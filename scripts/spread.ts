// npm run spread -- 1,2,3        (or 1-3)
//
// The baseline spread: run the unchanged agent 3 or more times, then write down how much its score moves on its own.
// Writes runs/spread.md with the min, max, mean and median of the score and of the held-out score.
// A later change only counts if it beats the max (see npm run verdict). Offline: reads runs/ only.
//
//   npm run spread -- --selftest   checks the spread and verdict math on made-up runs (no server, no git)

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { RUNS_DIR } from "./lib.ts";
import { fiveChecks, parseRunList, readRun, spreadMarkdown, stats, verdictLine, type GitFacts, type RunScores } from "./realgain.ts";

if (process.argv[2] === "--selftest") selftest();
else {
  const runs = parseRunList(process.argv[2], "baseline runs").map(readRun);
  const md = spreadMarkdown(runs);
  writeFileSync(join(RUNS_DIR, "spread.md"), md);
  console.log(md + "\n(saved runs/spread.md)");
}

function selftest(): void {
  let failed = 0;
  const check = (name: string, got: unknown, want: unknown) => {
    const ok = JSON.stringify(got) === JSON.stringify(want);
    console.log(`${ok ? "ok  " : "FAIL"} ${name}: ${JSON.stringify(got)}${ok ? "" : ` (want ${JSON.stringify(want)})`}`);
    if (!ok) failed++;
  };
  check("stats odd", stats([50, 44, 56]), { n: 3, min: 44, max: 56, mean: 50, median: 50 });
  check("stats even", stats([1, 4, 2, 3]), { n: 4, min: 1, max: 4, mean: 2.5, median: 2.5 });

  const r = (run: number, score: number, holdout: number | null, commit: string): RunScores => ({ run, score, holdout, commit, dirty: false, agent: commit });
  const base = [r(1, 44, 50, "a"), r(2, 50, 50, "a"), r(3, 56, 50, "a")];
  const git: GitFacts = { evalsChanged: [], agentLinesChanged: 8, agentFilesChanged: ["agent/skills/x/SKILL.md"], leaks: [], agentSessionCommits: 1, showCommand: "git diff a b -- agent/" };
  const results = (post: RunScores[], g: GitFacts = git) => fiveChecks(base, post, g).map((c) => c.result);

  const good = [r(4, 72, 100, "b"), r(5, 75, 100, "b")];
  check("real gain", results(good), ["PASS", "PASS", "PASS", "MANUAL", "PASS"]);
  check("real gain verdict", verdictLine(fiveChecks(base, good, git)), "Verdict: gain shown, if what you read holds (The diff)");
  const lucky = [r(4, 72, 100, "b"), r(5, 52, 100, "b")];
  check("second run inside the spread", results(lucky)[4], "FAIL");
  const noHeldOut = [r(4, 72, 50, "b"), r(5, 75, 50, "b")];
  check("no held-out gain", verdictLine(fiveChecks(base, noHeldOut, git)), "Verdict: gain NOT shown (Held-out gain)");
  check("scorer changed", results(good, { ...git, evalsChanged: ["evals/score.ts"] })[1], "FAIL");
  check("diff quotes a task", results(good, { ...git, leaks: ["agent/ quotes \"01-python-utils\""] })[3], "FAIL");
  check("one post-edit run", results([good[0]])[4], "FAIL");
  check("two baseline runs", fiveChecks(base.slice(0, 2), good, git)[0].result, "FAIL");
  check("no spread", fiveChecks([r(1, 50, 50, "a"), r(2, 50, 50, "a"), r(3, 50, 50, "a")], good, git)[0].result, "MANUAL");
  if (failed) process.exit(1);
}
