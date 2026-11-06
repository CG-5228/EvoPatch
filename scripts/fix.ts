// npm run fix -- --repo owner/name --sha <commit> --bug report.md [--language python|js] [--tests tests] [--pythonpath src]
//
// The live-bug demo: one real bug from outside the eval set, through the same agent, skills, tools and sandbox as a
// run. Nothing is scored and nothing reaches summary.csv. The output says so, and is saved under runs/demos/.
//
// Skills are global by name, so a demo during the protocol would change what a run's agent fetches. This refuses to
// start until every counted run is done, and it only ever registers the final agent's commit.

import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { TrueForge } from "@truefoundry/trueforge-sdk";
import { auditCommands } from "../evals/audit.ts";
import { EVALS_DIR } from "../evals/docker.ts";
import { tarballName, taskPrompt, type Task } from "../evals/prompt.ts";
import { client, commandsOf, die, downloadFile, env, exportTurn, featureUsage, git, isClean, option, ROOT, runDir, RUNS_DIR, runTurn, SUMMARY_CSV, syncAgent, traceOf, unscreenedEdit, writeJson } from "./lib.ts";

const NOT_COUNTED = "NOT COUNTED. A live demo on a bug outside the eval set: it's in no score and no run.";

export interface Options {
  repo: string;
  sha: string;
  bug: string;
  language?: string;
  tests?: string;
  pythonpath?: string;
}

export interface FinalAgent {
  run: number;
  commit: string;
  tree: string;
}

/** Whatever on this machine a demo would interfere with. */
export function protocolProcesses(): string[] {
  try {
    return execFileSync("pgrep", ["-fl", "run-protocol\\.sh|scripts/(run-evals|evolve|improve)\\.ts"], { encoding: "utf8" }).trim().split("\n");
  } catch {
    return []; // pgrep exits 1 when nothing matches
  }
}

/** A stopped run can resume at any time, and it must find the skills where it left them. */
function unfinishedRuns(): string[] {
  return [RUNS_DIR, join(RUNS_DIR, "search"), join(RUNS_DIR, "controls")]
    .filter((root) => existsSync(root))
    .flatMap((root) => readdirSync(root).filter((d) => existsSync(join(root, d, ".partial"))));
}

/** Every reason a demo can't start now, and the agent it would use. */
export function check(running: string[]): { problems: string[]; final: FinalAgent | null } {
  const problems: string[] = [];
  if (running.length) problems.push(`The protocol is running:\n    ${running.join("\n    ").slice(0, 600)}`);
  const unfinished = unfinishedRuns();
  if (unfinished.length) problems.push(`These runs stopped and haven't finished: ${unfinished.join(", ")}.`);
  const edit = unscreenedEdit();
  if (edit) problems.push(`The agent's newest edit (${edit.slice(0, 7)}) hasn't been through its screens.`);
  if (!isClean("agent")) problems.push("agent/ has uncommitted changes.");

  const rows = existsSync(SUMMARY_CSV) ? readFileSync(SUMMARY_CSV, "utf8").trim().split("\n").slice(1).filter(Boolean) : [];
  const last = rows.at(-1)?.split(",");
  if (!last) return { problems: [...problems, "There are no counted runs yet."], final: null };
  const run = Number(last[0]);
  const name = `run-${String(run).padStart(2, "0")}`;
  const verdictFile = join(RUNS_DIR, "verdict.md");
  const postEdit = existsSync(verdictFile) ? (readFileSync(verdictFile, "utf8").match(/Post-edit: ([^.]*)\./)?.[1] ?? "") : "";
  if (!postEdit.split(", ").includes(name)) problems.push(`The verdict doesn't cover ${name} as a final run, so the counted runs aren't finished.`);

  const tree = (JSON.parse(readFileSync(join(runDir(run), "score.json"), "utf8")) as { agent_tree: string }).agent_tree;
  if (git("rev-parse", "HEAD:agent") !== tree) problems.push(`agent/ here isn't the agent of ${name}, so skills would register at another commit than the final one.`);
  return { problems, final: { run, commit: last[2], tree } };
}

/** The same layout as a task's upload: repo/ and tools/, with no git history, since the fix may be in it. */
export function buildUpload(o: Options, work: string): { task: Task; body: Buffer; language: string } {
  const repo = join(work, "repo");
  const url = existsSync(o.repo) ? resolve(o.repo) : `https://github.com/${o.repo}.git`;
  execFileSync("git", ["clone", "-q", url, repo], { stdio: ["ignore", "ignore", "inherit"] });
  execFileSync("git", ["-C", repo, "checkout", "-q", "--detach", o.sha], { stdio: ["ignore", "ignore", "inherit"] });
  rmSync(join(repo, ".git"), { recursive: true, force: true });

  const language = o.language ?? (existsSync(join(repo, "package.json")) && !existsSync(join(repo, "pyproject.toml")) ? "js" : "python");
  const fallback = ["tests", "test"].find((d) => existsSync(join(repo, d))) ?? ".";
  const tests = (o.tests ?? fallback).split(",");
  const id = `fix-${basename(o.repo).replace(/\.git$/, "").replace(/[^a-z0-9]+/gi, "-").toLowerCase()}`;
  const task = { id, issue_text: readFileSync(o.bug, "utf8") } as Task;

  const tools = join(EVALS_DIR, "tools");
  const skip = (from: string) => !/__pycache__|\.DS_Store/.test(from);
  mkdirSync(join(work, "tools"));
  for (const name of ["finish", "test", "timeout"]) cpSync(join(tools, name), join(work, "tools", name));
  writeFileSync(join(work, "tools", "task.json"), JSON.stringify({ language, tarball: tarballName(task), pythonpath: o.pythonpath ?? ".", pytest_args: ["-o", "addopts="], targets: tests, test_paths: tests, test_exclude: [], ignore: [], deselect: [] }, null, 1) + "\n");
  const parts = ["repo", "tools"];
  if (language === "python") cpSync(join(tools, "pylib"), join(work, "tools", "pylib"), { recursive: true, filter: skip });
  else {
    mkdirSync(join(work, "node_modules", "tap"), { recursive: true });
    cpSync(join(tools, "tap", "index.js"), join(work, "node_modules", "tap", "index.js"));
    parts.push("node_modules");
  }
  const file = join(work, tarballName(task));
  execFileSync("tar", ["-czf", file, "-C", work, ...parts], { env: { ...process.env, COPYFILE_DISABLE: "1" } });
  return { task, body: readFileSync(file), language };
}

/** The agent's last run of the project's tests, from what its sandbox returned. */
function lastTestRun(steps: ReturnType<typeof traceOf>) {
  const step = steps.filter((s) => s.thread === "main" && s.tool === "exec" && /tools\/test\b/.test(s.command)).at(-1);
  return step ? { command: step.command, exit: step.exit, output: (step.tail || step.head).trim() } : null;
}

/** Nothing here is scored, but a demo only means something if the agent didn't fetch the fix, so it shows what could have. */
export function networkUse(commands: string[], repo: string): string[] {
  const named = commands.filter((c) => c.includes(repo)).map((c) => c.slice(0, 300));
  return [...new Set([...named, ...auditCommands(commands).soft.map((h) => h.command)])];
}

/** Returns true when a patch came back. */
export async function runFix(tf: TrueForge, final: FinalAgent, o: Options, work: string): Promise<boolean> {
  const { task, body, language } = buildUpload(o, work);
  console.log(`\n${NOT_COUNTED}\n`);
  console.log(`Bug:   ${o.repo} at ${o.sha.slice(0, 7)} (${language})`);
  const { at } = await syncAgent(tf, final.commit).catch((e: Error) => die(`Can't reach TrueForge at ${env.baseUrl}, or it rejected the agent. Is it running? (scripts/start-trueforge.sh)\n  ${e.message}`));
  console.log(`Agent: ${at.agent.name} at ${final.commit.slice(0, 7)}, the agent of run ${final.run}, with its skills pinned there`);
  const { data: session } = await tf.sessions.create({ agent: { name: at.agent.name }, metadata: { purpose: "fix-demo", agent_commit: final.commit } });
  await tf.sessions.update(session.id, { title: "fix demo (not counted)" });
  console.log(`Session ${session.id}. This can take up to an hour.\n`);

  const turn = await runTurn(tf, session.id, taskPrompt(task), { files: [{ name: tarballName(task), body }] });
  if (!turn.turnId) die(`The turn didn't start: ${turn.error}`);
  const { turn: exported } = await exportTurn(tf, session.id, turn.turnId);
  const patch = await downloadFile(tf, session.id, turn.turnId, "out/patch.diff");
  const report = await downloadFile(tf, session.id, turn.turnId, "out/report.json");
  const test = lastTestRun(traceOf(exported));
  const network = networkUse(commandsOf(exported), o.repo);

  const label = `${task.id}-${new Date().toISOString().replace(/\W/g, "").slice(0, 15)}`;
  const dir = join(RUNS_DIR, "demos", label);
  writeJson(join(dir, "result.json"), { counted: false, repo: o.repo, sha: o.sha, agent_commit: final.commit, session_id: session.id, turn_id: turn.turnId, status: turn.status, error: turn.error ?? null, patch_bytes: patch?.length ?? 0, last_test_run: test, network_commands: network, usage: featureUsage([exported]) });
  writeJson(join(dir, "session.json"), exported);
  if (patch?.length) writeFileSync(join(dir, "patch.diff"), patch);

  console.log(`The turn ended: ${turn.status}${turn.error ? ` (${turn.error})` : ""}\n`);
  console.log("--- The patch ---");
  console.log(patch?.length ? patch.toString() : "The agent didn't submit a patch.");
  if (report?.length) console.log(`--- What it said it did ---\n${(JSON.parse(report.toString()) as { summary: string }).summary}\n`);
  console.log("--- Its last test run, in its sandbox ---");
  console.log(test ? `$ ${test.command}\nexit ${test.exit}\n${test.output}` : "It didn't run the tests.");
  console.log("\n--- Commands that used the network or named this repo ---");
  console.log(network.length ? network.map((c) => c.replace(/\s+/g, " ").slice(0, 160)).join("\n") : "None.");
  console.log(`\n${NOT_COUNTED}`);
  console.log(`Saved to ${dir.replace(`${ROOT}/`, "")}`);
  return Boolean(patch?.length);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [repo, sha, bug] = [option("repo"), option("sha"), option("bug")];
  if (!repo || !sha || !bug) die("Usage: npm run fix -- --repo owner/name --sha <commit> --bug report.md [--language python|js] [--tests tests] [--pythonpath src]");
  if (!existsSync(bug)) die(`No bug report at ${bug}.`);
  const { problems, final } = check(protocolProcesses());
  if (problems.length || !final) die(`The demo can only run after every counted run.\n  ${problems.join("\n  ")}`);
  const work = mkdtempSync(join(ROOT, ".tmp-fix-"));
  try {
    const ok = await runFix(client(), final, { repo, sha, bug, language: option("language"), tests: option("tests"), pythonpath: option("pythonpath") }, work);
    process.exitCode = ok ? 0 : 1;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
