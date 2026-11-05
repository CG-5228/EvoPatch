// npm run smoke
//
// One real turn through the agent before any counted run: it catches a bad model name, key or setting, a broken
// sandbox or a skill that won't install, while nothing is saved. Not a run: nothing goes into runs/ or summary.csv.
// The session is titled "smoke test (not counted)".

import { loadTasks, tarballName, taskPrompt, taskTarball } from "../evals/prompt.ts";
import { scoreAttempt } from "../evals/score.ts";
import { client, commandsOf, die, downloadFile, env, exportTurn, featureUsage, headSha, option, runTurn, syncAgent } from "./lib.ts";

const tf = client();
let agent;
try {
  agent = await syncAgent(tf, headSha());
} catch (e) {
  die(`Can't reach TrueForge at ${env.baseUrl}, or it rejected the agent. Is it running? (scripts/start-trueforge.sh)\n  ${(e as Error).message}`);
}
const tasks = loadTasks();
const task = tasks.find((t) => t.id === option("task")) ?? tasks.find((t) => !t.holdout);
if (!task) die("No tasks in evals/tasks/.");

const { data: session } = await tf.sessions.create({ agent: { name: agent.at.agent.name }, metadata: { purpose: "smoke" } });
await tf.sessions.update(session.id, { title: "smoke test (not counted)" });
const turn = await runTurn(tf, session.id, taskPrompt(task), { files: [{ name: tarballName(task), body: taskTarball(task) }] });
if (turn.outcome !== "ok") die(`Smoke test failed: the turn ended with status ${turn.status}${turn.error ? `: ${turn.error}` : ""} (session ${session.id}). Fix this before any run.`);

const { turn: exported } = await exportTurn(tf, session.id, turn.turnId);
const usage = featureUsage([exported]);
if (usage.init_failures) die(`Smoke test failed: the sandbox didn't start (session ${session.id}).`);
const state = await downloadFile(tf, session.id, turn.turnId, "skills/.tfy-skill-downloader-state.json");
const pinned = state ? (JSON.parse(state.toString()) as { downloaded_git_skills: { ref: string }[] }).downloaded_git_skills.every((s) => s.ref === agent.at.sha) : false;
if (!pinned) die(`Smoke test failed: the sandbox didn't install skills at ${agent.at.sha.slice(0, 7)} (session ${session.id}).`);

const patch = await downloadFile(tf, session.id, turn.turnId, "out/patch.diff");
const scored = scoreAttempt(task, patch, commandsOf(exported));
console.log(JSON.stringify(usage));
console.log(`✓ Smoke test passed: ${agent.at.agent.name} ran ${task.id} (${scored.failure_class}, session ${session.id}). Not counted as a run.`);
