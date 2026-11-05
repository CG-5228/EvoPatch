// Shared by spread.ts and verdict.ts: read saved runs, compute the baseline spread, and judge the five checks.
// Offline: reads runs/ and git only, never the TrueForge server.
//
// The method is TrueFoundry's (Anant Agarwal, Stranger Builds talk, 4 Nov 2026): a gain counts only after five checks.
//   1 baseline spread   2 scorer unchanged   3 held-out gain   4 the diff   5 beats the spread and repeats

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { scoreRun, type TaskScore } from "../evals/score.ts";
import { die, git, runDir } from "./lib.ts";

export interface RunScores {
  run: number;
  score: number;
  /** null when the task set has no held-out tasks */
  holdout: number | null;
  /** the commit the run ran at (HEAD before the run was committed), without "-dirty" */
  commit: string;
  dirty: boolean;
  /** git tree id of agent/ at that commit: the same agent ran when this matches (each run commit moves HEAD) */
  agent: string;
}

export interface Stats {
  n: number;
  min: number;
  max: number;
  mean: number;
  median: number;
}

export function parseRunList(arg: string | undefined, what: string): number[] {
  if (!arg) die(`Give the ${what} as a list of run numbers, e.g. 1,2,3 (or a range, 1-3).`);
  const out: number[] = [];
  for (const part of arg.split(",").map((p) => p.trim()).filter(Boolean)) {
    const m = part.match(/^(\d+)(?:-(\d+))?$/);
    if (!m) die(`"${part}" is not a run number or a range (e.g. 1,2,3 or 1-3).`);
    const a = Number(m[1]);
    const b = m[2] ? Number(m[2]) : a;
    for (let i = Math.min(a, b); i <= Math.max(a, b); i++) if (!out.includes(i)) out.push(i);
  }
  return out;
}

/** One saved run's numbers, from runs/run-NN/score.json (held-out from results.json for runs saved before holdout_score). */
export function readRun(run: number): RunScores {
  const dir = runDir(run);
  const nn = String(run).padStart(2, "0");
  const scoreFile = join(dir, "score.json");
  if (!existsSync(scoreFile)) die(`No saved run ${nn} (${scoreFile} is missing).`);
  const s = JSON.parse(readFileSync(scoreFile, "utf8")) as { score: number; agent_commit: string; holdout_score?: number | null };
  let holdout = s.holdout_score;
  if (holdout === undefined) {
    const resultsFile = join(dir, "results.json");
    const results = existsSync(resultsFile) ? (JSON.parse(readFileSync(resultsFile, "utf8")) as TaskScore[]) : [];
    const held = results.filter((r) => r.holdout);
    holdout = held.length ? scoreRun(held).score : null;
  }
  const full = String(s.agent_commit ?? "");
  const commit = full.replace(/-dirty$/, "");
  let agent = commit;
  try {
    agent = git("rev-parse", `${commit}:agent`);
  } catch {
    // commit not in this repo's history: compare by commit instead
  }
  return { run, score: s.score, holdout, commit, dirty: full.endsWith("-dirty"), agent };
}

export function stats(xs: number[]): Stats {
  const v = [...xs].sort((a, b) => a - b);
  const n = v.length;
  const mid = n % 2 ? v[(n - 1) / 2] : (v[n / 2 - 1] + v[n / 2]) / 2;
  return { n, min: v[0], max: v[n - 1], mean: round(v.reduce((a, b) => a + b, 0) / n), median: round(mid) };
}

export function round(x: number): number {
  return Math.round(x * 100) / 100;
}

const runName = (r: number) => `run-${String(r).padStart(2, "0")}`;
export const runNames = (rs: number[]) => rs.map(runName).join(", ");

/** runs/spread.md: the range a later run has to beat. */
export function spreadMarkdown(runs: RunScores[]): string {
  const s = stats(runs.map((r) => r.score));
  const held = runs.map((r) => r.holdout).filter((h): h is number => h !== null);
  const h = held.length === runs.length ? stats(held) : null;
  const line = (label: string, x: Stats) => `- ${label}: min ${x.min}, max ${x.max}, mean ${x.mean}, median ${x.median}`;
  const out = [
    "# Baseline spread",
    "",
    `Runs: ${runNames(runs.map((r) => r.run))} (${runs.length} runs, same agent, nothing changed between them).`,
    "",
    "| Run | Score | Held-out |",
    "|---|---|---|",
    ...runs.map((r) => `| ${runName(r.run)} | ${r.score} | ${r.holdout ?? "-"} |`),
    "",
    line("Score", s),
    h ? line("Held-out", h) : "- Held-out: no held-out score in every run (mark 1 or 2 tasks `\"holdout\": true` before run 1)",
    "",
    `The bar: a change counts only if every run after it scores above ${s.max}${h ? `, and held-out above ${h.max}` : ""}.`,
  ];
  const agents = new Set(runs.map((r) => r.agent));
  if (agents.size > 1) out.push("", `Warning: agent/ was not the same in all these runs (${agents.size} versions); a baseline is the same agent every time.`);
  if (runs.length < 3) out.push("", "Warning: fewer than 3 runs. Run the baseline at least 3 times before you trust this range.");
  if (s.min === s.max) out.push("", "No spread: every run scored the same. That can be real (temperature 0, few tasks) or too few runs to see it; more tasks and runs make it trustworthy.");
  return out.join("\n") + "\n";
}

// ---------- the five checks ----------

export type Result = "PASS" | "FAIL" | "MANUAL";
export interface Check {
  name: string;
  result: Result;
  detail: string;
}

/** What verdict.ts finds in git about the runs; kept separate so the checks can be tested without a repo. */
export interface GitFacts {
  /** files under evals/ that differ between the first baseline run's commit and any later counted run's (or are uncommitted now) */
  evalsChanged: string[];
  /** lines added + removed under agent/ between the last baseline run's commit and the first post-edit run's */
  agentLinesChanged: number;
  agentFilesChanged: string[];
  /** leak-guard hits in the lines the change added */
  leaks: string[];
  /** commits in that range that touch agent/ and carry an Agent-Session trailer */
  agentSessionCommits: number;
  /** the command to read the change */
  showCommand: string;
}

export function fiveChecks(baseline: RunScores[], post: RunScores[], g: GitFacts): Check[] {
  const b = stats(baseline.map((r) => r.score));
  const checks: Check[] = [];

  // 1. Baseline spread
  if (baseline.length < 3) checks.push({ name: "1 Baseline spread", result: "FAIL", detail: `only ${baseline.length} baseline run(s); run the unchanged agent 3 or more times` });
  else if (new Set(baseline.map((r) => r.agent)).size > 1) checks.push({ name: "1 Baseline spread", result: "FAIL", detail: "agent/ changed between the baseline runs; they must be the same agent" });
  else if (b.min === b.max) checks.push({ name: "1 Baseline spread", result: "MANUAL", detail: `all ${baseline.length} baseline runs scored ${b.max}: there is no spread to measure yet` });
  else checks.push({ name: "1 Baseline spread", result: "PASS", detail: `${baseline.length} runs: min ${b.min}, max ${b.max}, mean ${b.mean}, median ${b.median}` });

  // 2. Scorer and tasks unchanged
  const dirty = [...baseline, ...post].filter((r) => r.dirty).map((r) => r.run);
  if (dirty.length) checks.push({ name: "2 Scorer and tasks unchanged", result: "FAIL", detail: `${runNames(dirty)} ran with uncommitted changes (-dirty); don't count them` });
  else if (g.evalsChanged.length) checks.push({ name: "2 Scorer and tasks unchanged", result: "FAIL", detail: `changed since ${runName(baseline[0].run)}: ${g.evalsChanged.join(", ")}` });
  else checks.push({ name: "2 Scorer and tasks unchanged", result: "PASS", detail: `no changes to evals/ since ${runName(baseline[0].run)}` });

  // 3. Held-out gain
  const bh = baseline.map((r) => r.holdout);
  const ph = post.map((r) => r.holdout);
  if (bh.some((h) => h === null) || ph.some((h) => h === null)) checks.push({ name: "3 Held-out gain", result: "FAIL", detail: "no held-out score in every run: mark 1 or 2 tasks \"holdout\": true (before run 1)" });
  else {
    const bmax = Math.max(...(bh as number[]));
    const ok = (ph as number[]).every((h) => h > bmax);
    checks.push({ name: "3 Held-out gain", result: ok ? "PASS" : "FAIL", detail: `post-edit held-out ${ph.join(", ")} ${ok ? "all beat" : "does not beat"} the baseline max ${bmax}` });
  }

  // 4. The diff (a heuristic: a person has to read it)
  const files = g.agentFilesChanged.length ? ` in ${g.agentFilesChanged.join(", ")}` : "";
  if (g.agentLinesChanged === 0) checks.push({ name: "4 The diff", result: "FAIL", detail: "agent/ did not change between the baseline and the post-edit runs" });
  else if (g.leaks.length) checks.push({ name: "4 The diff", result: "FAIL", detail: `the change quotes the eval tasks: ${g.leaks.join("; ")}` });
  else
    checks.push({
      name: "4 The diff",
      result: "MANUAL",
      detail:
        `${g.agentLinesChanged} line(s) changed${files}, no task ids, file names or buggy lines quoted` +
        `${g.agentSessionCommits ? "" : ", but no commit with Agent-Session: (did the agent write it?)"}. ` +
        `Read it yourself (small? a general rule?): ${g.showCommand}`,
    });

  // 5. Beats the spread, repeats
  const scores = post.map((r) => r.score);
  if (post.length < 2) checks.push({ name: "5 Beats the spread, repeats", result: "FAIL", detail: `${post.length} post-edit run; run at least 2 so one lucky run can't fool you` });
  else {
    const ok = scores.every((s) => s > b.max);
    checks.push({ name: "5 Beats the spread, repeats", result: ok ? "PASS" : "FAIL", detail: `${post.length} post-edit runs (${scores.join(", ")}), ${ok ? "all above" : "not all above"} the baseline max ${b.max}` });
  }
  return checks;
}

export function verdictLine(checks: Check[]): string {
  const failed = checks.filter((c) => c.result === "FAIL").map((c) => c.name.replace(/^\d+ /, ""));
  if (failed.length) return `Verdict: gain NOT shown (${failed.join(", ")})`;
  const manual = checks.filter((c) => c.result === "MANUAL").map((c) => c.name.replace(/^\d+ /, ""));
  if (manual.length) return `Verdict: gain shown, if what you read holds (${manual.join(", ")})`;
  return "Verdict: gain shown";
}

export function verdictMarkdown(baseline: RunScores[], post: RunScores[], checks: Check[]): string {
  return [
    "# Verdict",
    "",
    `Baseline: ${runNames(baseline.map((r) => r.run))}. Post-edit: ${runNames(post.map((r) => r.run))}.`,
    "",
    "| Check | Result | Detail |",
    "|---|---|---|",
    ...checks.map((c) => `| ${c.name} | ${c.result} | ${c.detail.replace(/\|/g, "\\|")} |`),
    "",
    verdictLine(checks),
    "",
    "If any check fails, report the gain as not shown. Method: TrueFoundry's five checks (Anant Agarwal, 4 Nov 2026).",
    "",
  ].join("\n");
}
