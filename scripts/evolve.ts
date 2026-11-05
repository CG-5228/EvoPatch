// npm run evolve -- --baseline 1,2,3
//
// Rounds of: improve → two train-only screens → keep, or git revert. Holdout tasks never run here.
// An edit is kept only if both screens beat the bar: the highest baseline train score, then the last kept edit's score.
// Stops after protocol.max_rounds, or after two rounds in a row with no kept edit. Any failure stops the loop and
// waits for a person: fallbacks are Chris's call. Then run the final counted runs and `npm run verdict`.

import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { die, git, headSha, option, protocol, push, ROOT, RUNS_DIR, writeJson } from "./lib.ts";
import { parseRunList } from "./realgain.ts";

const baseline = parseRunList(option("baseline"), "baseline runs");
const read = (dir: string) => JSON.parse(readFileSync(join(dir, "score.json"), "utf8")) as { train_score: number | null };
const name = (r: number) => `runs/run-${String(r).padStart(2, "0")}`;
let bar = Math.max(...baseline.map((r) => read(join(ROOT, name(r))).train_score ?? 0));
const roundsFile = join(RUNS_DIR, "rounds.json");
const rounds = (existsSync(roundsFile) ? JSON.parse(readFileSync(roundsFile, "utf8")) : []) as Record<string, unknown>[];
const sources = baseline.map(name);
const verdictFile = join(ROOT, "VERDICT.md");

const tsx = (script: string, ...args: string[]) => spawnSync("npx", ["tsx", `scripts/${script}.ts`, ...args], { cwd: ROOT, stdio: "inherit" });

function record(entry: Record<string, unknown>, line: string): void {
  rounds.push(entry);
  writeJson(roundsFile, rounds);
  if (!existsSync(verdictFile)) appendFileSync(verdictFile, "# Verdict log\n\nOne entry per round, written by `npm run evolve`.\n\n");
  appendFileSync(verdictFile, `${line}\n`);
  git("add", roundsFile, verdictFile);
  git("commit", "-q", "-m", `round ${entry.round}: ${entry.kept ? "kept" : "dropped"}`);
  push();
}

function screen(round: number, tag: string): number {
  const label = `round-${round}-${tag}`;
  const result = tsx("run-evals", "--kind", "search", "--label", label, "--train-only");
  if (result.status !== 0) die(`Screen ${label} stopped. Fix it, resume it with --resume, and restart evolve.`);
  sources.push(`runs/search/${label}`);
  return read(join(RUNS_DIR, "search", label)).train_score ?? 0;
}

let dry = 0;
const first = rounds.length + 1;
for (let round = first; round <= protocol.max_rounds && dry < 2; round++) {
  const before = headSha();
  let ok = false;
  for (let tries = 1; tries <= 3 && !ok; tries++) {
    const result = tsx("improve", "--from", sources.join(","));
    if (result.status === 0) ok = true;
    else if (result.status !== 3) die("improve stopped. Nothing was committed by this step.");
  }
  const child = headSha();
  if (!ok || child === before) {
    dry++;
    record({ round, kept: false, reason: "no accepted change" }, `- Round ${round}: no change passed the guards.`);
    continue;
  }
  const subject = git("log", "-1", "--format=%s%n%n%b", child);
  const a = screen(round, "a");
  const b = a > bar ? screen(round, "b") : null;
  const kept = a > bar && b !== null && b > bar;
  const entry = { round, commit: child, kept, bar, screens: [a, ...(b === null ? [] : [b])], change: subject.split("\n")[2] ?? "" };
  if (kept) {
    dry = 0;
    bar = Math.min(a, b as number);
    record(entry, `- Round ${round}: kept ${child.slice(0, 7)}. Train ${a}, ${b}, over the bar of ${entry.bar}.`);
  } else {
    dry++;
    execFileSync("git", ["revert", "--no-edit", child], { cwd: ROOT, stdio: "ignore" });
    git("commit", "--amend", "-q", "-m", `Revert agent change ${child.slice(0, 7)}: train ${a}${b === null ? "" : `, ${b}`} didn't clear ${entry.bar}`);
    push();
    record(entry, `- Round ${round}: dropped ${child.slice(0, 7)}. Train ${a}${b === null ? "" : `, ${b}`}, not over the bar of ${entry.bar}.`);
  }
}
console.log("Evolve finished. Next: two or more counted runs (npm run run-evals), then npm run verdict.");
