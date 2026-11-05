// npm run run-evals [-- --kind counted|search|control|scratch] [--label name] [--at sha] [--train-only]
//                      [--tasks a,b] [--k N] [--resume] [--no-commit]
//
// One run = one TrueForge session. Each attempt at each task is one root turn, so it gets a fresh sandbox.
//   counted   runs/run-NN + a row in runs/summary.csv: always every task, at the frozen settings
//   search    runs/search/<label>: a train-only screen of a candidate edit; no row in summary.csv
//   control   runs/controls/<label>: a check on another agent commit; no row in summary.csv
//   scratch   runs-scratch/<label>: not committed; for pilots and development
// Counted, search and control runs are listed in runs/registry.csv before they start, so an aborted run stays visible.

import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { loadTasks, tarballName, taskPrompt, taskTarball, type Task } from "../evals/prompt.ts";
import { IMAGE } from "../evals/docker.ts";
import { scoreAttempt, scoreRun, scoreTask, type AttemptScore, type FailureClass } from "../evals/score.ts";
import {
  client,
  commandsOf,
  die,
  downloadFile,
  env,
  exportTurn,
  featureUsage,
  flag,
  git,
  headSha,
  isClean,
  option,
  protocol,
  push,
  REGISTRY_CSV,
  ROOT,
  runDir,
  RUNS_DIR,
  runTurn,
  SUMMARY_CSV,
  syncAgent,
  turnStats,
  writeJson,
  type TurnExport,
} from "./lib.ts";

const HEADER = "run,session_id,agent_commit,score,date_utc,tasks_passed,tasks_total,tokens,tool_calls,duration_s,holdout_score,train_score";
const REGISTRY_HEADER = "started_utc,kind,label,session_id,agent_commit,status";
const FREEZE_TAG = "eval-v1";

type Kind = "counted" | "search" | "control" | "scratch";
const kind = (option("kind") ?? "counted") as Kind;
if (!["counted", "search", "control", "scratch"].includes(kind)) die(`Unknown --kind ${kind}`);
const official = kind !== "scratch";

// 1. Counted evidence comes only from the frozen harness and a known agent.
if (official) {
  if (process.env.TF_MODEL || process.env.TF_AGENT_NAME) die("TF_MODEL and TF_AGENT_NAME override agent/agent.json. Unset them for an official run.");
  if (!isClean("agent", "evals", "scripts", "package.json", "package-lock.json")) die("agent/, evals/, scripts/ or the package files have uncommitted changes. Commit them first.");
  if (!git("tag", "--list", FREEZE_TAG)) die(`No ${FREEZE_TAG} tag yet: freeze the evaluation before an official run.`);
  if (git("diff", "--name-only", FREEZE_TAG, "--", "evals", "agent/agent.json")) die(`evals/ or agent/agent.json changed since ${FREEZE_TAG}.`);
  if (kind === "counted" && (option("tasks") || option("k") || flag("train-only"))) die("Counted runs always use every task at the frozen k.");
}

const sha = option("at") ?? headSha();
const k = Number(option("k") ?? protocol.k);
const wanted = option("tasks")?.split(",");
const tasks = loadTasks().filter((t) => (!wanted || wanted.includes(t.id)) && (!flag("train-only") || !t.holdout));
if (!tasks.length) die("No tasks selected.");

// 2. Where this run goes.
if (!existsSync(SUMMARY_CSV) || readFileSync(SUMMARY_CSV, "utf8").trim() === "") writeFileSync(SUMMARY_CSV, HEADER + "\n");
const rows = readFileSync(SUMMARY_CSV, "utf8").trim().split("\n").slice(1).filter(Boolean);
const run = rows.length + 1;
const nn = String(run).padStart(2, "0");
const label = option("label") ?? (kind === "counted" ? `run-${nn}` : new Date().toISOString().replace(/\W/g, "").slice(0, 15));
const dir = kind === "counted" ? runDir(run) : kind === "search" ? join(RUNS_DIR, "search", label) : kind === "control" ? join(RUNS_DIR, "controls", label) : join(ROOT, "runs-scratch", label);
const partial = join(dir, ".partial");
mkdirSync(partial, { recursive: true });
const sessionFile = join(partial, "session-id");
const resuming = flag("resume") && existsSync(sessionFile);

// 3. Make the TrueForge agent match agent/ at this commit.
const tf = client();
const { saved, at } = await syncAgent(tf, sha);
console.log(`${label}: agent "${saved.name}" at ${sha.slice(0, 7)}, ${tasks.length} tasks × ${k} attempts`);

// 4. One session for the whole run. https://trueforge.dev/api/overview#session
let sessionId: string;
if (resuming) {
  sessionId = readFileSync(sessionFile, "utf8").trim();
} else {
  const { data: session } = await tf.sessions.create({ agent: { name: at.agent.name }, metadata: { purpose: kind, run: label.slice(0, 120), agent_commit: sha } });
  sessionId = session.id;
  await tf.sessions.update(sessionId, { title: `${kind} ${label} @ ${sha.slice(0, 7)}`.slice(0, 50) });
  writeFileSync(sessionFile, sessionId);
  if (official) {
    if (!existsSync(REGISTRY_CSV)) writeFileSync(REGISTRY_CSV, REGISTRY_HEADER + "\n");
    appendFileSync(REGISTRY_CSV, [new Date().toISOString(), kind, label, sessionId, sha, "started"].join(",") + "\n");
    git("add", REGISTRY_CSV);
    git("commit", "-q", "-m", `registry: start ${kind} ${label}`);
    push();
  }
}
console.log(`  session ${sessionId}`);

// 5. Every attempt: run it, classify it, save the patch, score it.
interface Done {
  score: AttemptScore;
  turn: TurnExport;
  infra: { attempt: string; error: string }[];
}
const done = new Map<string, Done>();
const key = (t: Task, a: number) => `${t.id}-${a}`;
const donePath = join(partial, "done.jsonl");
if (resuming && existsSync(donePath)) {
  for (const line of readFileSync(donePath, "utf8").split("\n").filter(Boolean)) {
    const d = JSON.parse(line) as Done;
    done.set(`${d.score.task_id}-${d.score.attempt}`, d);
  }
  console.log(`  resuming: ${done.size} attempts already done`);
}

const queue: { task: Task; attempt: number }[] = [];
for (let attempt = 1; attempt <= k; attempt++) for (const task of tasks) if (!done.has(key(task, attempt))) queue.push({ task, attempt });

let infraStreak = 0;
let aborted = "";
const started = Date.now();

async function attemptOnce(task: Task, attempt: number): Promise<void> {
  const infra: Done["infra"] = [];
  for (let tries = 0; tries <= protocol.infra_retries; tries++) {
    if (aborted) return;
    const turn = await runTurn(tf, sessionId, taskPrompt(task), { files: [{ name: tarballName(task), body: taskTarball(task) }] });
    if (turn.fatal) {
      aborted = `the provider refused the request: ${turn.error}`;
      return;
    }
    if (turn.outcome === "infra") {
      infra.push({ attempt: key(task, attempt), error: `${turn.status}: ${turn.error ?? ""}`.slice(0, 300) });
      console.log(`  ${key(task, attempt).padEnd(34)} infra (${turn.status}), retrying`);
      if (++infraStreak >= protocol.infra_abort_after) {
        aborted = `${infraStreak} infrastructure failures in a row, last: ${turn.error}`;
        return;
      }
      continue;
    }
    const { turn: exported } = await exportTurn(tf, sessionId, turn.turnId);
    const usage = featureUsage([exported]);
    if (usage.init_failures) {
      infra.push({ attempt: key(task, attempt), error: "sandbox init failed during the turn" });
      if (++infraStreak >= protocol.infra_abort_after) {
        aborted = "the sandbox failed to start repeatedly";
        return;
      }
      continue;
    }
    infraStreak = 0;
    const state = await downloadFile(tf, sessionId, turn.turnId, "skills/.tfy-skill-downloader-state.json");
    const refs = state ? (JSON.parse(state.toString()) as { downloaded_git_skills: { ref: string }[] }).downloaded_git_skills.map((s) => s.ref) : [];
    if (usage.execs && refs.some((r) => r !== sha)) {
      aborted = `skills ran at ${refs[0]?.slice(0, 7)}, not ${sha.slice(0, 7)}: something changed the registry during this run`;
      return;
    }
    const patch = await downloadFile(tf, sessionId, turn.turnId, "out/patch.diff");
    const report = await downloadFile(tf, sessionId, turn.turnId, "out/report.json");
    const patchFile = join(dir, "patches", `${key(task, attempt)}.diff`);
    mkdirSync(dirname(patchFile), { recursive: true });
    if (patch?.length) writeFileSync(patchFile, patch);
    const commands = commandsOf(exported);
    const score: AttemptScore = { ...scoreAttempt(task, patch, commands, attempt), commands };
    const entry: Done = { score: { ...score, turn_id: turn.turnId, report: report?.toString().slice(0, 1000) }, turn: exported, infra };
    done.set(key(task, attempt), entry);
    appendFileSync(donePath, JSON.stringify(entry) + "\n");
    console.log(`  ${key(task, attempt).padEnd(34)} ${score.failure_class}${score.f2p_total ? ` (${score.f2p_passed}/${score.f2p_total})` : ""}`);
    return;
  }
  aborted ||= `${key(task, attempt)} failed on infrastructure ${protocol.infra_retries + 1} times`;
}

await Promise.all(
  Array.from({ length: protocol.concurrency }, async () => {
    for (let next = queue.shift(); next && !aborted; next = queue.shift()) await attemptOnce(next.task, next.attempt);
  }),
);

if (aborted) {
  if (official) {
    appendFileSync(REGISTRY_CSV, [new Date().toISOString(), kind, label, sessionId, sha, `aborted: ${aborted.replace(/[,\n]/g, " ").slice(0, 200)}`].join(",") + "\n");
    git("add", REGISTRY_CSV);
    git("commit", "-q", "-m", `registry: abort ${kind} ${label}`);
    push();
  }
  die(`Run stopped: ${aborted}\n  ${done.size} attempts are saved. Fix it, then: npm run run-evals -- --resume ... (nothing was added to summary.csv).`);
}

// 6. Save the run.
const entries = [...done.values()];
const turns = entries.map((e) => e.turn).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
const results = tasks.map((t) => scoreTask(t, entries.map((e) => e.score).filter((s) => s.task_id === t.id).sort((a, b) => a.attempt - b.attempt)));
const total = scoreRun(results);
const testsOnly = scoreRun(results.map((r) => ({ ...r, score: r.attempts.filter((a) => a.tests_resolved).length / r.attempts.length })));
const stats = turnStats(turns);
const durationS = Math.round((Date.now() - started) / 1000);
const classes = {} as Record<FailureClass, number>;
for (const e of entries) classes[e.score.failure_class] = (classes[e.score.failure_class] ?? 0) + 1;
const agentTree = git("rev-parse", `${sha}:agent`);
const { data: session } = await tf.sessions.get(sessionId);

writeJson(join(dir, "results.json"), results);
writeJson(join(dir, "score.json"), { run: kind === "counted" ? run : label, kind, session_id: sessionId, agent_commit: sha, agent_tree: agentTree, k, ...total, tests_only_score: testsOnly.score, failure_classes: classes, ...stats, duration_s: durationS });
writeJson(join(dir, "session.json"), { exported_at: new Date().toISOString(), base_url: env.baseUrl, redactions: { note: "Uploaded tarballs are replaced by their sha256 and size. evals/prompt.ts rebuilds them." }, session, turns });
writeJson(join(dir, "feature-usage.json"), featureUsage(turns));
writeJson(join(dir, "infra.json"), entries.flatMap((e) => e.infra));
writeJson(join(dir, "env.json"), {
  evals_tree: git("rev-parse", "HEAD:evals"),
  harness_commit: headSha(),
  model: at.agent.model,
  protocol,
  concurrency: protocol.concurrency,
  node: process.version,
  scorer_image: IMAGE,
  scorer_image_id: execFileSync("docker", ["image", "inspect", "--format", "{{.Id}}", IMAGE], { encoding: "utf8" }).trim(),
  server: "@truefoundry/trueforge@0.182.0",
});

for (const file of ["session.json"]) {
  const text = readFileSync(join(dir, file), "utf8");
  if (text.includes(";base64,")) die(`${file} still holds an upload.`);
  if (process.env.MODEL_API_KEY && text.includes(process.env.MODEL_API_KEY)) die(`${file} holds the model key. Nothing was committed.`);
  if (text.length > 95_000_000) die(`${file} is over GitHub's limit (${text.length} bytes).`);
}
rmSync(partial, { recursive: true, force: true });

// TrueForge never removes sandboxes; everything we need from this session is saved now.
for (const t of turns) {
  const id = (t.events as unknown as { type: string; sandboxId?: string }[]).find((e) => e.type === "sandbox.created")?.sandboxId;
  if (id?.startsWith("v1:local:")) rmSync(dirname(id.slice("v1:local:".length)), { recursive: true, force: true });
}

const date = new Date().toISOString().replace(/\.\d+Z$/, "Z");
if (kind === "counted") {
  appendFileSync(SUMMARY_CSV, [run, sessionId, sha, total.score, date, total.tasks_passed, total.tasks_total, stats.tokens, stats.toolCalls, durationS, total.holdout_score ?? "", total.train_score ?? ""].join(",") + "\n");
}
console.log(`\n${label} score: ${total.score} (train ${total.train_score ?? "-"}, holdout ${total.holdout_score ?? "-"}; ${total.tasks_passed}/${total.tasks_total} tasks passed every attempt, ${stats.tokens} tokens, ${durationS}s)`);
console.log(`  ${JSON.stringify(classes)}`);

// 7. Commit the run, so git history reads: run 1 → agent change → run N.
if (official && !flag("no-commit")) {
  appendFileSync(REGISTRY_CSV, [date, kind, label, sessionId, sha, `finished: ${total.score}`].join(",") + "\n");
  git("add", "runs");
  const subject = kind === "counted" ? `run ${nn}: score ${total.score}` : `${kind} ${label}: train ${total.train_score ?? "-"}`;
  git("commit", "-q", "-m", subject, "-m", `TrueForge session: ${sessionId}\nagent_commit: ${sha}`);
  push();
  console.log(`✓ Committed ${dir.replace(`${ROOT}/`, "")}.`);
}
