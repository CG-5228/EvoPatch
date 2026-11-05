// npm run curate [-- --task id] [--repeats N]
//
// Builds evals/fixtures/<id>/ from upstream and runs the curation gate, SWE-bench style:
//   repo/            the project at the fix's parent commit (minus what the profile drops)
//   hidden/          the maintainers' test tree at the fix commit, unmodified
//   reference.patch  the upstream fix, source files only
//   f2p.json         tests that fail at the parent and pass with the fix
//   p2p.json         tests that pass both ways
// Tests that flip across repeats are quarantined. Results go to evals/curation.json.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { profileFor, runInImage, type Profile, type RunnerResult } from "../evals/docker.ts";

const ROOT = join(import.meta.dirname, "..");
const TASKS = join(ROOT, "evals", "tasks");
const FIXTURES = join(ROOT, "evals", "fixtures");
const CACHE = join(ROOT, ".cache", "upstream");
const LEDGER = join(ROOT, "evals", "curation.json");

const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const repeats = Number(arg("repeats") ?? 3);
const only = arg("task");

interface Task {
  id: string;
  repo: string;
  base_sha: string;
  fix_sha: string;
  [key: string]: unknown;
}

const git = (dir: string, ...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8", maxBuffer: 1 << 28 });

function clone(repo: string): string {
  const dir = join(CACHE, repo.replace("/", "__"));
  if (!existsSync(dir)) {
    mkdirSync(CACHE, { recursive: true });
    execFileSync("git", ["clone", "-q", "--filter=blob:none", "--no-checkout", `https://github.com/${repo}.git`, dir]);
  }
  return dir;
}

function extract(upstream: string, sha: string, into: string, paths: string[] = []): void {
  mkdirSync(into, { recursive: true });
  const tar = execFileSync("git", ["archive", "--format=tar", sha, ...paths], { cwd: upstream, maxBuffer: 1 << 30 });
  execFileSync("tar", ["-xf", "-", "-C", into], { input: tar });
}

function touchedTests(upstream: string, task: Task, profile: Profile): string[] {
  const names = git(upstream, "diff", "--name-only", task.base_sha, task.fix_sha, "--", ...profile.test_paths);
  return names.split("\n").filter(Boolean);
}

/** The gate's claim that a test belongs to this fix: its file was changed by the fix commit. */
function fromFixedFile(testId: string, touched: string[]): boolean {
  if (touched.some((f) => f.includes("/fixtures/"))) return true;
  return touched.some((f) => {
    const dotted = f.replace(/\.(py|js)$/, "").replaceAll("/", ".");
    return testId.startsWith(f) || testId.startsWith(`${dotted}::`) || testId.startsWith(`${dotted}.`);
  });
}

function curate(task: Task, profile: Profile) {
  const upstream = clone(task.repo);
  const dir = join(FIXTURES, task.id);
  rmSync(dir, { recursive: true, force: true });
  extract(upstream, task.base_sha, join(dir, "repo"));
  for (const path of profile.drop ?? []) rmSync(join(dir, "repo", path), { recursive: true, force: true });
  for (const [path, text] of Object.entries(profile.generated ?? {})) {
    mkdirSync(dirname(join(dir, "repo", path)), { recursive: true });
    writeFileSync(join(dir, "repo", path), text);
  }
  extract(upstream, task.fix_sha, join(dir, "hidden"), profile.test_paths);
  const licence = readdirSync(join(dir, "repo")).find((f) => /^(licen[cs]e|copying)/i.test(f));
  const reference = git(upstream, "diff", task.base_sha, task.fix_sha, "--", ...profile.source_paths);
  writeFileSync(join(dir, "reference.patch"), reference);

  const before = runInImage(dir, profile, null);
  const fixed: RunnerResult[] = [];
  for (let i = 0; i < repeats; i++) fixed.push(runInImage(dir, profile, reference));
  const visibleBase = runInImage(dir, profile, null, false);
  const visibleFixed = runInImage(dir, profile, reference, false);

  const stable = new Set(Object.keys(fixed[0].tests).filter((id) => fixed.every((r) => r.tests[id] === fixed[0].tests[id])));
  const quarantined = Object.keys(fixed[0].tests).filter((id) => !stable.has(id));
  const passing = [...stable].filter((id) => fixed[0].tests[id] === "pass");
  const f2p = passing.filter((id) => before.tests[id] !== "pass" && before.tests[id] !== "skip").sort();
  const p2p = passing.filter((id) => before.tests[id] === "pass").sort();
  const stale = Object.keys(visibleBase.tests).filter((id) => visibleBase.tests[id] === "pass" && visibleFixed.tests[id] === "fail").sort();
  const touched = touchedTests(upstream, task, profile);
  const untraced = f2p.filter((id) => !fromFixedFile(id, touched));

  // A project's own .gitignore can hide files we generate. Force-add them, or a fresh clone won't have them.
  const hidden = git(ROOT, "ls-files", "-o", "-i", "--exclude-standard", "--", dir).split("\n").filter(Boolean);
  if (hidden.length) git(ROOT, "add", "-f", "--", ...hidden);

  writeFileSync(join(dir, "f2p.json"), JSON.stringify(f2p, null, 1) + "\n");
  writeFileSync(join(dir, "p2p.json"), JSON.stringify(p2p, null, 1) + "\n");
  writeFileSync(join(dir, "stale.json"), JSON.stringify(stale, null, 1) + "\n");

  const problems: string[] = [];
  if (!licence) problems.push("no licence file");
  if (!reference.trim()) problems.push("empty reference patch");
  if (!fixed[0].applied) problems.push(`reference did not apply: ${fixed[0].apply_error}`);
  if (fixed[0].timed_out || before.timed_out) problems.push("timed out");
  if (!f2p.length) problems.push("no FAIL_TO_PASS tests");
  if (!p2p.length) problems.push("no PASS_TO_PASS tests");
  if (untraced.length) problems.push(`${untraced.length} FAIL_TO_PASS tests outside the fix's test files`);
  return {
    id: task.id,
    collected_base: Object.keys(before.tests).length,
    collected_fixed: Object.keys(fixed[0].tests).length,
    visible_base: Object.keys(visibleBase.tests).length,
    f2p: f2p.length,
    p2p: p2p.length,
    failing_with_fix: Object.values(fixed[0].tests).filter((v) => v === "fail").length,
    quarantined,
    stale: stale.length,
    untraced: untraced.slice(0, 5),
    repeats,
    licence: licence ?? null,
    problems,
    tail: problems.length ? fixed[0].tail.slice(-600) : "",
  };
}

const ledger: Record<string, unknown> = existsSync(LEDGER) ? JSON.parse(readFileSync(LEDGER, "utf8")) : {};
const tasks = readdirSync(TASKS).filter((f) => f.endsWith(".json")).sort().map((f) => JSON.parse(readFileSync(join(TASKS, f), "utf8")) as Task).filter((t) => !only || t.id === only);

for (const task of tasks) {
  const started = Date.now();
  const row = curate(task, profileFor(task));
  ledger[task.id] = row;
  writeFileSync(LEDGER, JSON.stringify(ledger, null, 1) + "\n");
  console.log(`${row.problems.length ? "FAIL" : "ok  "} ${task.id.padEnd(28)} f2p ${String(row.f2p).padStart(4)}  p2p ${String(row.p2p).padStart(5)}  visible ${row.visible_base}  stale ${row.stale}  flaky ${row.quarantined.length}  ${Math.round((Date.now() - started) / 1000)}s ${row.problems.join("; ")}`);
}
