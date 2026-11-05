// npm run setup
// Registers the model from .env, checks the server can run skills in a sandbox, and syncs the agent at HEAD.
// run-evals syncs the same way before every run, so the agent that runs always matches agent/ at one commit.

import { client, die, env, headSha, syncAgent } from "./lib.ts";

const tf = client();
const need = (name: string) => process.env[name] || die(`Set ${name} in .env (see .env.example).`);

try {
  const { data: caps } = await tf.server.getCapabilities();
  if (!caps.sandbox.enabled || !caps.skill.enabled) die(`This server can't run skills in a sandbox: ${caps.skill.reason ?? "no sandbox"}`);
} catch (e) {
  die(`Can't reach TrueForge at ${env.baseUrl}. Is it running? (scripts/start-trueforge.sh)\n  ${(e as Error).message}`);
}

const type = need("MODEL_PROVIDER");
// MODEL_ID can list several ids, comma-separated. Each gets an alias TrueForge accepts: the id's last part, with dots as hyphens.
const properties = { contextLength: Number(process.env.MODEL_CONTEXT_LENGTH ?? 200000), maxOutputTokens: Number(process.env.MODEL_MAX_OUTPUT_TOKENS ?? 16000) };
const models = need("MODEL_ID")
  .split(",")
  .map((id) => id.trim())
  .filter(Boolean)
  .map((modelId) => ({ name: modelId.split("/").pop()!.toLowerCase().replace(/[^a-z0-9-]/g, "-"), modelId, properties }));
const auth = { apiKey: need("MODEL_API_KEY") };
const baseUrl = process.env.MODEL_BASE_URL;
const manifest = (type === "custom" ? { type, name: "custom", baseUrl, auth, models } : { type, ...(baseUrl ? { baseUrl } : {}), auth, models }) as Parameters<typeof tf.settings.modelProviders.createOrUpdate>[0]["manifest"];
await tf.settings.modelProviders.createOrUpdate({ manifest });

const { data: available } = await tf.models.list();
console.log(`✓ Provider saved. Models: ${available.map((m) => m.name).join(", ")}`);

const { saved, at } = await syncAgent(tf, headSha());
console.log(`✓ Agent "${saved.name}" (${saved.id}) is in sync with agent/ at ${at.sha.slice(0, 7)}`);
console.log(`  model: ${saved.manifest.model.name}`);
console.log(`  skills: ${at.skills.map((s) => s.name).join(", ")}`);
if (!available.some((m) => m.name === at.agent.model.name)) console.warn(`! agent/agent.json uses "${at.agent.model.name}", which isn't one of the models above.`);
