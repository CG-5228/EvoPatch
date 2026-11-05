// npm run verdict -- <baseline runs> <post-edit runs>      e.g.  npm run verdict -- 1,2,3 5,6
//
// Is the gain real? TrueFoundry's five checks (Anant Agarwal, Stranger Builds talk, 4 Nov 2026):
//   1 Baseline spread             3+ baseline runs of the same agent, range recorded
//   2 Scorer and tasks unchanged  evals/ is the same at every counted run as at the first baseline run (via git)
//   3 Held-out gain               every post-edit held-out score beats the baseline's highest held-out score
//   4 The diff                    agent/ between them: lines changed, no task ids/file names/buggy lines quoted;
//                                 always MANUAL: you read it (small? a general rule?)
//   5 Beats the spread, repeats   2+ post-edit runs, every one above the baseline's highest score
// If any check fails, the gain is not shown. Writes runs/verdict.md (and runs/spread.md). Offline: reads runs/ and git.

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { findLeaks } from "./guards.ts";
import { die, git, RUNS_DIR } from "./lib.ts";
import { fiveChecks, parseRunList, readRun, spreadMarkdown, verdictLine, verdictMarkdown, type GitFacts } from "./realgain.ts";

const baseline = parseRunList(process.argv[2], "baseline runs").map(readRun);
const post = parseRunList(process.argv[3], "post-edit runs (after the agent's change)").map(readRun);
if (Math.min(...post.map((r) => r.run)) <= Math.max(...baseline.map((r) => r.run))) die("The post-edit runs must come after the baseline runs.");

const short = (sha: string) => sha.slice(0, 7);
function tryGit(...args: string[]): string {
  try {
    return git(...args);
  } catch {
    die(`git ${args.join(" ")} failed. Are the runs' commits (agent_commit in score.json) in this repo's history?`);
  }
}

// 2. evals/ at the first baseline run vs every later counted run, and vs HEAD (what a judge would rerun).
const first = baseline[0].commit;
const evalsChanged = new Set<string>();
for (const c of [...baseline.slice(1), ...post].map((r) => r.commit).concat(git("rev-parse", "HEAD"))) {
  for (const f of tryGit("diff", "--name-only", first, c, "--", "evals").split("\n").filter(Boolean)) evalsChanged.add(f);
}

// 4. agent/ between the last baseline run and the first post-edit run.
const from = baseline[baseline.length - 1].commit;
const to = post[0].commit;
const numstat = tryGit("diff", "--numstat", from, to, "--", "agent").split("\n").filter(Boolean);
const agentLinesChanged = numstat.reduce((n, l) => n + l.split("\t").slice(0, 2).reduce((a, x) => a + (Number(x) || 0), 0), 0);
const added = tryGit("diff", "-U0", from, to, "--", "agent")
  .split("\n")
  .filter((l) => l.startsWith("+") && !l.startsWith("+++"))
  .map((l) => l.slice(1))
  .join("\n");
const facts: GitFacts = {
  evalsChanged: [...evalsChanged],
  agentLinesChanged,
  agentFilesChanged: numstat.map((l) => l.split("\t")[2]),
  leaks: findLeaks([{ path: "the added lines in agent/", text: added }]),
  agentSessionCommits: (tryGit("log", "--format=%B", `${from}..${to}`, "--", "agent").match(/^Agent-Session:/gm) ?? []).length,
  showCommand: `git diff ${short(from)} ${short(to)} -- agent/`,
};

const checks = fiveChecks(baseline, post, facts);
writeFileSync(join(RUNS_DIR, "spread.md"), spreadMarkdown(baseline));
const md = verdictMarkdown(baseline, post, checks);
writeFileSync(join(RUNS_DIR, "verdict.md"), md);
console.log(md + "(saved runs/verdict.md and runs/spread.md)");
if (verdictLine(checks).includes("NOT")) process.exitCode = 1;
