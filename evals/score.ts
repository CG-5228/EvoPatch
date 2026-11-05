// The scorer. Deterministic: same patch in, same result out. Frozen before run 1.
//
//   npm run score -- runs/run-01          re-score a saved run from its patches and compare
//   npm run score -- --selftest [--all]   attack the scorer: tampering, bad patches, real diff output, determinism
//
// Attempt: the patch is applied to a clean snapshot (source files only) in the pinned image, the maintainers' test
// tree is overlaid, and the attempt is resolved when every FAIL_TO_PASS and PASS_TO_PASS test passes and the audit
// has no hard hit. Task score = resolved attempts / attempts. A task passes when every attempt is resolved.
// Run score = 100 × the mean task score.

import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { AUDIT_FIXTURES, auditCommands, type AuditResult } from "./audit.ts";
import { EVALS_DIR, profileFor, runInImage, type RunnerResult } from "./docker.ts";
import { fixtureDir, loadTasks, taskPrompt, taskTarball, type Task } from "./prompt.ts";

export type FailureClass = "resolved" | "no_patch" | "patch_rejected" | "timeout" | "audit" | "f2p_failed" | "p2p_regression";

export interface AttemptScore {
  task_id: string;
  attempt: number;
  holdout: boolean;
  /** counts toward the score: tests pass and no hard audit hit */
  resolved: boolean;
  /** tests pass, audit ignored; reported beside `resolved` */
  tests_resolved: boolean;
  failure_class: FailureClass;
  f2p_passed: number;
  f2p_total: number;
  p2p_failed: number;
  p2p_total: number;
  applied: boolean;
  dropped: string[];
  /** added lines shared with the upstream fix, 0..1. Report only: it never affects the score */
  similarity: number;
  audit: AuditResult;
  /** every exec command, so a saved run can be re-scored with its audit */
  commands?: string[];
  turn_id?: string;
  report?: string;
  failing: { id: string; kind: string; message: string }[];
}

export interface TaskScore {
  task_id: string;
  holdout: boolean;
  score: number;
  passed: boolean;
  attempts: AttemptScore[];
}

const readList = (t: Task, name: string) => JSON.parse(readFileSync(join(fixtureDir(t), name), "utf8")) as string[];

function addedLines(patch: string): Set<string> {
  const lines = patch.split("\n").filter((l) => l.startsWith("+") && !l.startsWith("+++")).map((l) => l.slice(1).trim()).filter(Boolean);
  return new Set(lines);
}

export function similarity(patch: string, reference: string): number {
  const a = addedLines(patch);
  const b = addedLines(reference);
  if (!a.size || !b.size) return 0;
  const shared = [...a].filter((l) => b.has(l)).length;
  return round(shared / new Set([...a, ...b]).size, 3);
}

export function scoreAttempt(task: Task, patch: Buffer | null, commands: string[] = [], attempt = 1): AttemptScore {
  const f2p = readList(task, "f2p.json");
  const p2p = readList(task, "p2p.json");
  const audit = auditCommands(commands);
  const base = {
    task_id: task.id,
    attempt,
    holdout: task.holdout,
    f2p_total: f2p.length,
    p2p_total: p2p.length,
    audit,
  };
  if (!patch?.length) {
    return { ...base, resolved: false, tests_resolved: false, failure_class: "no_patch", f2p_passed: 0, p2p_failed: 0, applied: false, dropped: [], similarity: 0, failing: [] };
  }
  const result: RunnerResult = runInImage(fixtureDir(task), profileFor(task), patch);
  const f2pPassed = f2p.filter((id) => result.tests[id] === "pass").length;
  const p2pFailed = p2p.filter((id) => result.tests[id] !== "pass");
  const testsResolved = result.applied && !result.timed_out && f2pPassed === f2p.length && p2pFailed.length === 0;
  const failure_class: FailureClass = !result.applied
    ? "patch_rejected"
    : result.timed_out
      ? "timeout"
      : audit.hard.length
        ? "audit"
        : f2pPassed < f2p.length
          ? "f2p_failed"
          : p2pFailed.length
            ? "p2p_regression"
            : "resolved";
  const failingIds = [...f2p.filter((id) => result.tests[id] !== "pass"), ...p2pFailed];
  return {
    ...base,
    resolved: testsResolved && !audit.hard.length,
    tests_resolved: testsResolved,
    failure_class,
    f2p_passed: f2pPassed,
    p2p_failed: p2pFailed.length,
    applied: result.applied,
    dropped: result.dropped,
    similarity: similarity(patch.toString("utf8"), readFileSync(join(fixtureDir(task), "reference.patch"), "utf8")),
    failing: failingIds.slice(0, 20).map((id) => ({ id, kind: result.failures[id]?.kind ?? "missing", message: result.failures[id]?.message ?? "" })),
  };
}

export function scoreTask(task: Pick<Task, "id" | "holdout">, attempts: AttemptScore[]): TaskScore {
  const resolved = attempts.filter((a) => a.resolved).length;
  return { task_id: task.id, holdout: !!task.holdout, score: round(attempts.length ? resolved / attempts.length : 0, 4), passed: attempts.length > 0 && resolved === attempts.length, attempts };
}

export function scoreRun(tasks: TaskScore[]): { score: number; tasks_passed: number; tasks_total: number; holdout_score: number | null; train_score: number | null } {
  const mean = (xs: TaskScore[]) => (xs.length ? round((100 * xs.reduce((s, t) => s + t.score, 0)) / xs.length, 2) : null);
  return {
    score: mean(tasks) ?? 0,
    tasks_passed: tasks.filter((t) => t.passed).length,
    tasks_total: tasks.length,
    holdout_score: mean(tasks.filter((t) => t.holdout)),
    train_score: mean(tasks.filter((t) => !t.holdout)),
  };
}

function round(x: number, d: number): number {
  const k = 10 ** d;
  return Math.round(x * k) / k;
}

// ---------- CLI ----------

let failures = 0;
function check(name: string, ok: boolean, detail = ""): void {
  if (!ok) failures++;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${!ok && detail ? ` (${detail})` : ""}`);
}

/** The same command tools/finish runs, on the host: real macOS diff output with the fix applied. */
function realDiff(task: Task, reference: string): Buffer {
  const scratch = resolve(EVALS_DIR, "..", ".tmp");
  mkdirSync(scratch, { recursive: true });
  const dir = mkdtempSync(join(scratch, "diff-"));
  try {
    cpSync(join(fixtureDir(task), "repo"), join(dir, "a"), { recursive: true, verbatimSymlinks: true });
    cpSync(join(fixtureDir(task), "repo"), join(dir, "b"), { recursive: true, verbatimSymlinks: true });
    execFileSync("patch", ["-p1", "-s"], { cwd: join(dir, "b"), input: reference }); // not git apply: this folder is inside a repo, where it silently skips ignored paths
    try {
      return execFileSync("diff", ["-ruN", "-x", "__pycache__", "a/", "b/"], { cwd: dir, env: { ...process.env, LC_ALL: "C", TZ: "UTC" }, maxBuffer: 1 << 26 });
    } catch (e) {
      const err = e as { status?: number; stdout?: Buffer };
      if (err.status === 1 && err.stdout) return err.stdout;
      throw e;
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function selftest(all: boolean): void {
  for (const [command, hard] of AUDIT_FIXTURES) check(`audit: ${command.slice(0, 70)}`, auditCommands([command]).hard.length > 0 === hard);

  const ready = loadTasks().filter((t) => existsSync(join(fixtureDir(t), "f2p.json")) && readList(t, "f2p.json").length);
  const seen = new Set<string>();
  const chosen = all ? ready : ready.filter((t) => !seen.has(t.repo) && seen.add(t.repo));
  for (const t of chosen) {
    const profile = profileFor(t);
    const reference = readFileSync(join(fixtureDir(t), "reference.patch"));
    const a = taskTarball(t);
    check(`${t.id}: tarball is byte-identical across builds`, a.equals(taskTarball(t)));
    const listing = execFileSync("tar", ["-tzf", "-"], { input: a, maxBuffer: 1 << 26 }).toString();
    check(`${t.id}: tarball holds no hidden tests or reference`, !/hidden\/|reference\.patch|f2p\.json|p2p\.json/.test(listing));
    check(`${t.id}: prompt holds no fix`, !taskPrompt(t).includes(t.fix_sha));

    const fixed = scoreAttempt(t, reference);
    check(`${t.id}: reference patch resolves`, fixed.resolved, fixed.failure_class);
    check(`${t.id}: real macOS diff output resolves`, scoreAttempt(t, realDiff(t, reference.toString())).resolved);
    check(`${t.id}: empty patch does not`, scoreAttempt(t, Buffer.alloc(0)).failure_class === "no_patch");

    const testFile = `${profile.test_paths[0]}/evopatch_extra.${t.language === "js" ? "js" : "py"}`;
    const newFile = (path: string, body: string) => Buffer.from(`--- a/${path}\n+++ b/${path}\n@@ -0,0 +1 @@\n+${body}\n`);
    const testOnly = scoreAttempt(t, newFile(testFile, "x = 1"));
    check(`${t.id}: test-only patch does not`, !testOnly.resolved && testOnly.dropped.includes(testFile));
    const tamper = scoreAttempt(t, newFile("conftest.py", "collect_ignore_glob = ['*']"));
    check(`${t.id}: root conftest is dropped`, !tamper.resolved && tamper.dropped.includes("conftest.py"));
    check(`${t.id}: malformed patch does not`, !scoreAttempt(t, Buffer.from(`--- a/${profile.source_paths[0]}nope\n+++ b/${profile.source_paths[0]}nope\n@@ -9,1 +9,1 @@\n-a\n+b\n`)).resolved);
    const hit = scoreAttempt(t, reference, ["pip install more-itertools"]);
    check(`${t.id}: an audit hit voids a passing patch`, hit.tests_resolved && !hit.resolved && hit.failure_class === "audit");
    const again = scoreAttempt(t, reference);
    check(`${t.id}: re-score is identical`, JSON.stringify(again) === JSON.stringify(fixed));
  }
  const one = (id: string, resolved: boolean) => ({ task_id: id, holdout: id === "h", score: resolved ? 1 : 0, passed: resolved, attempts: [] });
  const run = scoreRun([one("a", true), one("b", false), one("h", true)]);
  check("run score blends, train and holdout separate", run.score === 66.67 && run.train_score === 50 && run.holdout_score === 100 && run.tasks_passed === 2 && run.tasks_total === 3);
  console.log(failures ? `\n${failures} check(s) failed` : "\nAll checks passed");
  if (failures) process.exitCode = 1;
}

function rescore(dir: string): void {
  const saved = JSON.parse(readFileSync(join(resolve(dir), "results.json"), "utf8")) as TaskScore[];
  const tasks = new Map(loadTasks().map((t) => [t.id, t]));
  const rescored = saved.map((s) => {
    const task = tasks.get(s.task_id);
    if (!task) throw new Error(`unknown task ${s.task_id}`);
    const attempts = s.attempts.map((a) => {
      const file = join(resolve(dir), "patches", `${a.task_id}-${a.attempt}.diff`);
      return scoreAttempt(task, existsSync(file) ? readFileSync(file) : null, a.commands ?? [], a.attempt);
    });
    return scoreTask(task, attempts);
  });
  const now = scoreRun(rescored);
  const was = JSON.parse(readFileSync(join(resolve(dir), "score.json"), "utf8")) as { score: number };
  console.log(JSON.stringify(now));
  console.log(now.score === was.score ? `✓ matches score.json (${was.score})` : `✗ score.json says ${was.score}`);
  if (now.score !== was.score) process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const arg = process.argv[2];
  if (arg === "--selftest") selftest(process.argv.includes("--all"));
  else if (arg) rescore(arg);
  else console.log("usage: npm run score -- runs/run-NN | --selftest [--all]");
}
