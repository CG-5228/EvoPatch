// npm run probe
//
// Dev only: checks what the local sandbox really does, using the scripted mock model, so nothing here costs tokens.
// Needs: scripts/start-trueforge.sh --dev, and npm run mock-model -- scripts/probe-scenarios.json.
// Prints every exec with its result, then tests downloads, overlapping root turns and a broken skill.

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TrueForge } from "@truefoundry/trueforge-sdk";

const MOCK_URL = "http://127.0.0.1:8799/v1";
const REPO = "https://github.com/CG-5228/EvoPatch";
const SKILL_REF = execFileSync("git", ["rev-list", "--max-parents=0", "HEAD"], { encoding: "utf8" }).trim();

const tf = new TrueForge({ baseUrl: "http://localhost:8791", timeoutInSeconds: 600 });
const caps = (await tf.server.getCapabilities()).data;
console.log("capabilities:", JSON.stringify({ sandbox: caps.sandbox, skill: caps.skill }));

await tf.settings.modelProviders.createOrUpdate({
  manifest: {
    type: "custom",
    name: "mock",
    baseUrl: MOCK_URL,
    models: [{ name: "scripted", modelId: "scripted", properties: { contextLength: 200000, maxOutputTokens: 8000 } }],
  },
});
const skill = (path: string) => ({
  manifest: { type: "git" as const, name: "probe-skill", description: "Probe skill.", url: REPO, path, ref: SKILL_REF },
});
await tf.settings.skills.createOrUpdate(skill("agent/skills/review-checklist"));

const spec = {
  model: { name: "mock/scripted" },
  instructions: "Scripted probe.",
  skills: [{ name: "probe-skill" }],
  config: { sandbox: { enabled: true, fileDownloads: false }, askUserQuestions: { enabled: false }, generativeUi: { enabled: false } },
};

function tarball(): string {
  const dir = mkdtempSync(join(tmpdir(), "probe-"));
  writeFileSync(join(dir, "note.txt"), "probe tarball\n");
  const out = join(dir, "probe.tar.gz");
  execFileSync("tar", ["-czf", out, "-C", dir, "note.txt"], { env: { ...process.env, COPYFILE_DISABLE: "1" } });
  return `data:application/gzip;base64,${readFileSync(out).toString("base64")}`;
}

async function start(sessionId: string, scenario: string) {
  const content = [
    { type: "text" as const, text: `[[mock:${scenario}]] run the probe` },
    { type: "file" as const, name: "probe.tar.gz", data: tarball() },
  ];
  const t0 = Date.now();
  const { data } = await tf.sessions.createTurn(sessionId, { input: [{ type: "user.message", content }], previousTurnId: "none" }, { maxRetries: 0, timeoutInSeconds: 600 });
  console.log(`createTurn ${scenario}: ${data.id} in ${((Date.now() - t0) / 1000).toFixed(1)}s, status ${data.state.status}`);
  return data.id;
}

async function wait(sessionId: string, turnId: string) {
  for (;;) {
    const { data } = await tf.sessions.getTurn(sessionId, turnId);
    if (data.state.status !== "running") return data;
    await new Promise((r) => setTimeout(r, 1000));
  }
}

const { data: session } = await tf.sessions.create({ agent: { spec }, metadata: { purpose: "probe" } });
const turnId = await start(session.id, "probe");
const turn = await wait(session.id, turnId);
console.log("turn state:", JSON.stringify(turn.state).slice(0, 400));

const calls = new Map<string, string>();
for await (const e of await tf.sessions.listTurnEvents(session.id, turnId, { order: "asc" })) {
  const ev = e as unknown as Record<string, unknown>;
  if (ev.type === "model.message") {
    for (const c of (ev.toolCalls ?? []) as { id: string; function?: { arguments?: string } }[]) {
      calls.set(c.id, String(c.function?.arguments ?? ""));
    }
  } else if (ev.type === "sandbox.created") {
    console.log("sandbox.created:", JSON.stringify(ev).slice(0, 300));
  } else if (ev.type === "tool.response") {
    const id = String(ev.toolCallId ?? "");
    const command = (JSON.parse(calls.get(id) || "{}") as { command?: string }).command ?? id;
    console.log(`\n$ ${command}\n${JSON.stringify(ev.response ?? ev.content ?? ev).replace(/\\n/g, "\n").slice(0, 1800)}`);
  }
}

const file = await tf.sessions.downloadSandboxFile(session.id, turnId, { path: "out/hello.txt" });
console.log("\ndownload out/hello.txt:", JSON.stringify(Buffer.from(await file.arrayBuffer()).toString()));

// Four root turns at the same moment in one session.
const t0 = Date.now();
const ids = await Promise.all([0, 1, 2, 3].map(() => start(session.id, "overlap")));
const turns = await Promise.all(ids.map((id) => wait(session.id, id)));
console.log(`overlap: 4 turns in ${((Date.now() - t0) / 1000).toFixed(1)}s:`, turns.map((t) => t.state.status).join(","));
for (const id of ids) {
  for await (const e of await tf.sessions.listTurnEvents(session.id, id, { order: "asc" })) {
    const ev = e as unknown as Record<string, unknown>;
    if (ev.type === "tool.response") console.log(" ", JSON.stringify(ev.response ?? ev).slice(0, 220));
  }
}

// A broken skill: what does an upload turn do?
await tf.settings.skills.createOrUpdate(skill("agent/skills/does-not-exist"));
const { data: bad } = await tf.sessions.create({ agent: { spec }, metadata: { purpose: "probe-bad-skill" } });
try {
  const id = await start(bad.id, "overlap");
  const t = await wait(bad.id, id);
  console.log("bad skill: turn state", JSON.stringify(t.state).slice(0, 300));
} catch (e) {
  const err = e as { statusCode?: number; message?: string; body?: unknown };
  console.log("bad skill: POST rejected", err.statusCode, String(err.message).slice(0, 300), JSON.stringify(err.body ?? null).slice(0, 300));
}
await tf.settings.skills.createOrUpdate(skill("agent/skills/review-checklist"));
