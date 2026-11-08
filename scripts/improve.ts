// npm run improve -- --from runs/run-01,runs/run-02,runs/run-03 [--no-commit] [--proof-dir dir]
//
// The agent reads its own failures and makes one small change to itself.
//   1. Bundles the failed training attempts, void ones included: bug report, patch, the trace of what it did, every
//      command it ran, and which tests failed, with no test source and no expected values. Which rule voided an
//      attempt never appears here, and neither do holdout tasks.
//   2. Opens a TrueForge session with the agent itself. Analyst subagents read the traces, a skeptic checks the
//      cause against passing traces, and the root writes its diagnosis before it edits anything.
//   3. Host guards accept or reject the change (scripts/guards.ts). The host writes nothing of its own.
//   4. Commits with the trailer "Agent-Session: <session_id>" as the last line, and pushes.
// Exit code 3 means the guards rejected the proposal: the reason is saved under runs/rejected/.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fixtureDir, loadTasks } from "../evals/prompt.ts";
import type { AttemptScore, TaskScore } from "../evals/score.ts";
import { checkProposal, type Diagnosis, type Proposal } from "./guards.ts";
import {
  client,
  die,
  downloadFile,
  exportSession,
  featureUsage,
  flag,
  git,
  headSha,
  howItEnded,
  isClean,
  option,
  push,
  readAgentAt,
  ROOT,
  RUNS_DIR,
  runTurn,
  SUMMARY_CSV,
  syncAgent,
  traceOf,
  writeJson,
  type TurnExport,
} from "./lib.ts";

const sources = option("from")?.split(",").map((d) => d.trim()).filter(Boolean);
if (!sources?.length) die("Say which runs to learn from: --from runs/run-01,runs/run-02,runs/run-03");
if (!isClean("agent")) die("agent/ has uncommitted changes: the agent's change must be its own.");

const tasks = new Map(loadTasks().map((t) => [t.id, t]));
const sha = headSha();
const rows = readFileSync(SUMMARY_CSV, "utf8").trim().split("\n").slice(1).filter(Boolean);
const nn = String(rows.length).padStart(2, "0");

// ---------- the bundle ----------

interface Attempt {
  id: string;
  score: AttemptScore;
  turn?: TurnExport;
  dir: string;
}

const attempts: Attempt[] = [];
for (const source of sources) {
  const dir = join(ROOT, source);
  const results = JSON.parse(readFileSync(join(dir, "results.json"), "utf8")) as TaskScore[];
  const session = JSON.parse(readFileSync(join(dir, "session.json"), "utf8")) as { turns: TurnExport[] };
  const byId = new Map(session.turns.map((t) => [t.id, t]));
  for (const r of results) {
    if (r.holdout || tasks.get(r.task_id)?.holdout) continue;
    for (const a of r.attempts) attempts.push({ id: `${basename(source)}/${a.task_id}-${a.attempt}`, score: a, turn: a.turn_id ? byId.get(a.turn_id) : undefined, dir });
  }
}
const failed = attempts.filter((a) => !a.score.resolved);
if (failed.length < 2) {
  console.log(`Only ${failed.length} failed training attempts: there's nothing general to learn from.`);
  process.exit(0);
}
const mixed = new Set(failed.map((a) => a.score.task_id));
const contrasts = [...mixed].flatMap((id) => attempts.find((a) => a.score.task_id === id && a.score.resolved) ?? []);

function renderTrace(a: Attempt): string {
  const steps = a.turn ? traceOf(a.turn) : [];
  const text = steps
    .map((s, i) => [`#${i + 1} [${s.thread}] ${s.tool} exit=${s.exit ?? "?"}${s.seconds === null ? "" : ` ${s.seconds}s`}: ${s.intent}`, `$ ${s.command.slice(0, 500)}`, s.head.slice(0, 350), s.tail ? `...\n${s.tail.slice(-250)}` : ""].filter(Boolean).join("\n"))
    .join("\n\n");
  return text.length > 16000 ? `${text.slice(0, 8000)}\n\n[... middle of the trace removed ...]\n\n${text.slice(-8000)}` : text;
}

/** Every command in order, with its thread. A long trace loses its middle; this doesn't, and it's the same for every attempt, so it can't point at what voided one. */
function renderCommands(a: Attempt): string {
  if (!a.turn) return "";
  const events = a.turn.events as unknown as { type: string; threadId?: string; title?: string }[];
  const names = new Map(events.filter((e) => e.type === "thread.created").map((e) => [e.threadId, e.title]));
  return traceOf(a.turn).map((s, i) => `#${i + 1} [${names.get(s.thread) ?? s.thread}] ${s.command.replace(/\s+/g, " ").slice(0, 240)}`).join("\n");
}

/** CI-style result: which tests, no expected values. Parameters are stripped because they can hold the answer. */
function testSummary(a: Attempt) {
  const task = tasks.get(a.score.task_id)!;
  const f2p = new Set(JSON.parse(readFileSync(join(fixtureDir(task), "f2p.json"), "utf8")) as string[]);
  const failures = a.score.failing.map((f) => ({
    test: task.language === "js" ? f.id.split("::")[0] : f.id.replace(/\[.*$/, ""),
    kind: f2p.has(f.id) ? "the bug is still there" : "this worked before your patch",
    exception: f.message.match(/\b\w*(Error|Exception|Warning)\b/)?.[0] ?? "assertion",
  }));
  return {
    outcome: a.score.failure_class === "audit" ? "void" : a.score.failure_class,
    bug_tests_passed: `${a.score.f2p_passed} of ${a.score.f2p_total}`,
    regressions: a.score.p2p_failed,
    failures: [...new Map(failures.map((f) => [JSON.stringify(f), f])).values()],
    how_it_ended: a.turn ? howItEnded(a.turn) : null,
  };
}

function writeAttempt(root: string, a: Attempt): void {
  const dir = join(root, a.id.replace("/", "--"));
  mkdirSync(dir, { recursive: true });
  const task = tasks.get(a.score.task_id)!;
  const patch = join(a.dir, "patches", `${a.score.task_id}-${a.score.attempt}.diff`);
  writeFileSync(join(dir, "report.md"), task.issue_text);
  writeFileSync(join(dir, "patch.diff"), existsSync(patch) ? readFileSync(patch) : "");
  writeFileSync(join(dir, "trace.md"), renderTrace(a));
  writeFileSync(join(dir, "commands.md"), renderCommands(a));
  writeFileSync(join(dir, "result.json"), JSON.stringify({ attempt: a.id, bug_class: task.bug_class, ...testSummary(a) }, null, 1) + "\n");
}

const bundle = mkdtempSync(join(ROOT, ".tmp-improve-"));
try {
  const parent = readAgentAt(sha);
  const parentFile = (path: string): string | null => {
    try {
      return git("show", `${sha}:${path}`) + "\n";
    } catch {
      return null;
    }
  };
  const agentPaths = ["agent/instructions.md", ...parent.skills.map((s) => `${s.path}/SKILL.md`)];
  const parentFiles: Proposal[] = agentPaths.map((path) => ({ path, text: parentFile(path) ?? "" }));
  for (const f of parentFiles) {
    mkdirSync(dirname(join(bundle, f.path)), { recursive: true });
    writeFileSync(join(bundle, f.path), f.text);
  }
  for (const a of failed) writeAttempt(join(bundle, "failures"), a);
  for (const a of contrasts) writeAttempt(join(bundle, "passes"), a);
  const rejectedLog = join(RUNS_DIR, "rounds.json");
  const rounds = existsSync(rejectedLog) ? (JSON.parse(readFileSync(rejectedLog, "utf8")) as { kept: boolean }[]) : [];
  writeFileSync(join(bundle, "earlier-rounds.json"), JSON.stringify(rounds, null, 1) + "\n");
  const tarball = join(ROOT, `.tmp-improve-${process.pid}.tar.gz`);
  execFileSync("tar", ["-czf", tarball, "-C", bundle, "."], { env: { ...process.env, COPYFILE_DISABLE: "1" } });
  const body = readFileSync(tarball);
  rmSync(tarball);

  const failureIds = new Set(failed.map((a) => a.id));
  const prompt = `This message is not a bug report. Today you improve yourself. Ignore your usual workflow for this conversation.

Unpack your evidence: \`mkdir -p bundle out && tar -xzf uploads/improve-bundle.tar.gz -C bundle\`.

- \`bundle/agent/\`: your current instructions and skills.
- \`bundle/failures/<attempt>/\`: attempts you got wrong. \`report.md\` is the bug report, \`patch.diff\` is what you submitted, \`trace.md\` is what you did, \`commands.md\` is every command run in the attempt with the thread that ran it (\`main\` is you, any other name is a subagent you started), \`result.json\` says which tests failed and how the attempt ended. You can't see the tests or the right answer.
- An \`outcome\` of \`void\` in \`result.json\` means the attempt didn't count, whatever its tests did. An attempt is void if it fetches this project's code or its fix from the network, or reads another copy of this library on this machine.
- \`bundle/passes/<attempt>/\`: attempts at the same tasks that passed.
- \`bundle/earlier-rounds.json\`: earlier changes and what they did to the score. Don't repeat a change that was dropped.

Attempt ids are the folder names with \`--\` written as \`/\`: the folder \`run-01--some-task-2\` is the attempt \`run-01/some-task-2\`.

Do this in order:

1. Use \`create_sub_agent\` to read the failures: give each analyst a few attempt folders. An analyst sees only what you write, so tell it where the files are and to report what went wrong in the agent's process: what it skipped, assumed or stopped too early on, and which general habit would have prevented it. Analysts must not edit files.
2. Choose ONE root cause that shows up in failures on at least two different tasks. Prefer the cause behind the most failures.
3. Use one more subagent as a skeptic: ask it to check your cause against \`bundle/passes/\` and to say if the passing attempts contradict it.
4. Before you edit anything, write \`out/diagnosis.json\`: {"cause": "...", "rule": "the general rule you will add", "cited": ["attempt ids, at least 2, from at least 2 tasks"], "predicted_effect": "what should change"}.
5. Make ONE small edit that teaches that rule. Copy each file you change to \`out/agent/...\` with the same path, for example \`out/agent/skills/fix-workflow/SKILL.md\`. Change at most 40 lines in total. Keep the frontmatter of skills on single lines. Keep the Output section of instructions.md.
6. Write \`out/LEARNED.md\`: one sentence, what you learned.
7. Write \`out/manifest.json\`: {"files": ["agent/skills/fix-workflow/SKILL.md"]}.
8. Run \`shasum -a 256\` on every file in \`out/agent/\`, and on \`out/diagnosis.json\`, so the hashes are on record.

The rule must help on code you have never seen. Never mention project names, function names, file names, test names, issue numbers or values from these attempts: a rule that names them will be rejected.`;

  // ---------- ask the agent ----------

  const tf = client();
  const { at } = await syncAgent(tf, sha);
  const { data: session } = await tf.sessions.create({ agent: { name: at.agent.name }, metadata: { purpose: "improve", learned_from: nn, parent_commit: sha } });
  await tf.sessions.update(session.id, { title: `improve after run ${nn}` });
  console.log(`Asking "${at.agent.name}" to learn from ${failed.length} failed attempts (session ${session.id})…`);
  const turn = await runTurn(tf, session.id, prompt, { files: [{ name: "improve-bundle.tar.gz", body }] });
  const exported = await exportSession(tf, session.id);
  const proofDir = option("proof-dir") ? join(ROOT, option("proof-dir")!) : join(RUNS_DIR, `run-${nn}`);
  writeJson(join(proofDir, `improve-${session.id}.json`), exported);
  if (turn.outcome === "infra" || turn.fatal) die(`The improve turn ended with status ${turn.status}${turn.error ? `: ${turn.error}` : ""}. Nothing was committed.`);

  // ---------- read and check the change ----------

  const read = async (path: string) => (await downloadFile(tf, session.id, turn.turnId, path))?.toString("utf8") ?? null;
  const rawManifest = await read("out/manifest.json");
  const rawDiagnosis = await read("out/diagnosis.json");
  const learned = ((await read("out/LEARNED.md")) ?? "").replace(/\s+/g, " ").trim();
  const reject = (problems: string[]): never => {
    const file = join(RUNS_DIR, "rejected", `${session.id}.json`);
    writeJson(file, { session_id: session.id, parent: sha, problems, diagnosis: rawDiagnosis, manifest: rawManifest, learned });
    console.error(`\n✗ The guards rejected this change:\n  ${problems.join("\n  ")}\n  Saved to ${file.replace(`${ROOT}/`, "")}`);
    process.exit(3);
  };
  if (turn.outcome !== "ok") reject([`the session ended early: ${turn.error ?? turn.status}`]);
  if (!rawManifest || !rawDiagnosis) reject(["out/manifest.json or out/diagnosis.json is missing"]);
  let paths: string[] = [];
  let diagnosis: Diagnosis = {};
  try {
    paths = (JSON.parse(rawManifest!) as { files: string[] }).files;
    diagnosis = JSON.parse(rawDiagnosis!) as Diagnosis;
  } catch {
    reject(["out/manifest.json or out/diagnosis.json isn't valid JSON"]);
  }
  const files: Proposal[] = [];
  for (const path of paths) {
    const bytes = await downloadFile(tf, session.id, turn.turnId, `out/${path}`);
    if (!bytes) reject([`${path} is in the manifest but wasn't written`]);
    files.push({ path, text: bytes!.toString("utf8") });
  }
  const record = JSON.stringify(exported.turns);
  const unhashed = files.filter((f) => !record.includes(createHash("sha256").update(f.text).digest("hex"))).map((f) => f.path);
  if (unhashed.length) reject([`no matching shasum in the session for: ${unhashed.join(", ")}`]);

  const bundleStrings = failed.flatMap((a) => testSummary(a).failures.map((f) => f.test.split("::").pop() ?? "")).filter((s) => s.length >= 12);
  const problems = checkProposal(files, diagnosis, failureIds, parentFile, parentFiles, [...new Set(bundleStrings)]);
  if (problems.length) reject(problems);

  // ---------- write and commit ----------

  for (const f of files) {
    mkdirSync(dirname(join(ROOT, f.path)), { recursive: true });
    writeFileSync(join(ROOT, f.path), f.text);
  }
  writeJson(join(proofDir, `diagnosis-${session.id}.json`), { ...diagnosis, learned, session_id: session.id, parent: sha, usage: featureUsage(exported.turns) });
  if (isClean("agent")) {
    console.log("The agent sent back its files unchanged. Nothing to commit.");
    process.exit(0);
  }
  console.log(git("diff", "--stat", "--", "agent"));
  const message = `agent: learn from run ${nn}\n\n${learned || "(no summary given)"}\n\nAgent-Session: ${session.id}`;
  if (flag("no-commit")) {
    console.log(`\nFiles written, not committed:\n${message}`);
  } else {
    git("add", "agent", "runs");
    git("commit", "-q", "-m", message);
    push();
    console.log(`\n✓ Committed the agent's change (Agent-Session: ${session.id}): ${headSha()}`);
  }
} finally {
  rmSync(bundle, { recursive: true, force: true });
  for (const f of readdirSync(ROOT)) if (f.startsWith(".tmp-improve-")) rmSync(join(ROOT, f), { recursive: true, force: true });
}
