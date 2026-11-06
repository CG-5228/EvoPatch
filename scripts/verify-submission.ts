// npm run verify-submission [-- path/to/fresh/clone]
//
// Checks what the automatic checks and judges read, on a clone of origin/main, not on this working tree.

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GITHUB_REPO } from "./lib.ts";

const given = process.argv[2];
const dir = given ?? mkdtempSync(join(tmpdir(), "evopatch-verify-"));
if (!given) execFileSync("git", ["clone", "-q", `https://github.com/${GITHUB_REPO}.git`, dir]);
const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8", maxBuffer: 1 << 26 }).trim();

let failed = 0;
function check(name: string, ok: boolean, detail = ""): void {
  if (!ok) failed++;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? `: ${detail}` : ""}`);
}

const repo = JSON.parse(execFileSync("gh", ["api", `repos/${GITHUB_REPO}`], { encoding: "utf8" })) as { private: boolean; fork: boolean; created_at: string };
check("repo is public", !repo.private);
check("repo is not a fork", !repo.fork);
check("repo created after the opening", Date.parse(repo.created_at) > Date.parse("2026-10-30T23:00:00Z"), repo.created_at);

for (const path of ["agent", "agent/agent.json", "evals/tasks", "evals/score.ts", "runs/summary.csv", "README.md", "LICENSE"]) check(`${path} exists`, existsSync(join(dir, path)));
const tasks = readdirSync(join(dir, "evals/tasks")).filter((f) => f.endsWith(".json"));
check("3+ tasks", tasks.length >= 3, `${tasks.length}`);
check("README has the exact heading", /^## Run 1 vs run N$/m.test(readFileSync(join(dir, "README.md"), "utf8")));

const lines = readFileSync(join(dir, "runs/summary.csv"), "utf8").trim().split("\n");
const header = lines[0].split(",");
check("summary.csv keeps the starter's first 10 columns", lines[0].startsWith("run,session_id,agent_commit,score,date_utc,tasks_passed,tasks_total,tokens,tool_calls,duration_s"));
const rows = lines.slice(1).map((l) => Object.fromEntries(l.split(",").map((v, i) => [header[i], v])));
check("2+ runs", rows.length >= 2, `${rows.length}`);
check("no -dirty runs", rows.every((r) => !r.agent_commit.endsWith("-dirty")));
const first = rows[0];
const better = rows.slice(1).filter((r) => Number(r.score) > Number(first?.score));
check("a later run beats run 1", better.length > 0, better.map((r) => `run ${r.run}: ${r.score} > ${first.score}`).join(", "));

const runCommit = (n: string) => git("log", "--format=%H", `--grep=^run ${n.padStart(2, "0")}: score`, "-n", "1");
if (first && better.length) {
  // Any later run that beats run 1 will do, as long as an edit came first: a baseline can beat run 1 by luck, with none.
  const learnedBefore = (r: Record<string, string>) =>
    git("log", "--format=%H", `${runCommit(first.run)}..${runCommit(r.run)}`, "--", "agent")
      .split("\n")
      .filter((sha) => sha && /^Agent-Session: \S+$/.test(git("log", "-1", "--format=%B", sha).trim().split("\n").pop() ?? ""));
  const proof = better.find((r) => learnedBefore(r).length > 0);
  check(
    "an agent commit ending in Agent-Session: sits between run 1 and a later, better run",
    !!proof,
    proof ? `run ${proof.run}, after ${learnedBefore(proof).length} agent commit(s)` : `none before run ${better.map((r) => r.run).join(", ")}`,
  );
}

if (first) {
  const start = runCommit(first.run);
  const touching = git("log", "--format=%H", `${start}..HEAD`, "--", "agent").split("\n").filter(Boolean);
  const strays = touching.filter((sha) => {
    const message = git("log", "-1", "--format=%B", sha).trim();
    return !/^Agent-Session: \S+$/.test(message.split("\n").pop() ?? "") && !message.startsWith("Revert agent change");
  });
  check("after run 1, agent/ changed only by learn commits or their reverts", strays.length === 0, strays.join(" "));
  const evalsChanged = git("diff", "--name-only", `${start}`, "HEAD", "--", "evals");
  check("evals/ unchanged since run 1", !evalsChanged, evalsChanged.split("\n")[0]);
}

for (const r of rows) {
  const session = join(dir, "runs", `run-${r.run.padStart(2, "0")}`, "session.json");
  check(`run ${r.run} has its session`, existsSync(session));
  if (existsSync(session)) check(`run ${r.run} session holds no upload`, !readFileSync(session, "utf8").includes(";base64,"));
}
check("runs/spread.md exists", existsSync(join(dir, "runs/spread.md")));
check("runs/verdict.md exists", existsSync(join(dir, "runs/verdict.md")));
check("no .env in the repo", !git("ls-files").split("\n").some((f) => /(^|\/)\.env$/.test(f)));

if (!given) rmSync(dir, { recursive: true, force: true });
console.log(failed ? `\n${failed} check(s) failed` : "\nAll checks passed");
process.exitCode = failed ? 1 : 0;
