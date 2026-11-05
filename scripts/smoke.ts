// npm run smoke
//
// One real turn through the agent, before you count any run: it catches a bad model name, key or setting
// while nothing is saved. Sends the first eval task, scores the reply, and prints it. Not a run: nothing goes
// into runs/ or summary.csv, nothing is committed. The session is titled "smoke test (not counted)".

import { scoreTask } from "../evals/score.ts";
import { client, die, env, headSha, loadTasks, readAgent, runTurn, syncAgent, taskPrompt } from "./lib.ts";

const tf = client();
let agent;
try {
  agent = await syncAgent(tf, headSha());
} catch (e) {
  die(`Can't reach TrueForge at ${env.baseUrl}, or it rejected the agent. Is it running? (npx @truefoundry/trueforge@latest)\n  ${(e as Error).message}`);
}
const task = loadTasks()[0];
if (!task) die("No tasks in evals/tasks/.");

const { data: session } = await tf.sessions.create({ agent: { name: readAgent().agent.name }, metadata: { purpose: "smoke" } });
await tf.sessions.update(session.id, { title: "smoke test (not counted)" });
const turn = await runTurn(tf, session.id, taskPrompt(task));
if (turn.status !== "done") die(`Smoke test failed: the turn ended with status ${turn.status}${turn.error ? `: ${turn.error}` : ""} (session ${session.id}). Fix the model setting before any run.`);
const scored = scoreTask(task, turn.text);
if (!scored.parsed) die(`Smoke test failed: ${agent.name} answered, but with no valid \`\`\`json block with "findings" (session ${session.id}). Reply:\n\n${turn.text.slice(-1500)}`);
console.log(`✓ Smoke test passed: ${agent.name} answered ${task.id} (score ${scored.score.toFixed(2)}, session ${session.id}). Not counted as a run.`);
