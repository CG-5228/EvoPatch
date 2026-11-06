// npx tsx scripts/replay-reasoning.ts --request <captured.json> --from <run,run> [--contexts 40] [--n 25] [--out file]
//
// Evidence for the feedback to TrueFoundry, never part of a run. TrueForge removes reasoning_content from assistant
// messages before the next model call. Xiaomi's docs say MiMo needs it. This replays real conversation states both
// ways and compares how often the model answers with noise.
//   --request: one request body TrueForge really sent, for its system prompt, tools and settings.
//   --from:    run folders whose session.json holds the conversations.
// The two arms are interleaved, so a change in the service during the test falls on both.

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { die, isNoise, option, ROOT, type TurnExport } from "./lib.ts";

interface Event {
  type: string;
  threadId?: string | null;
  content?: string;
  reasoningContent?: string;
  toolCallId?: string;
  toolCalls?: { id: string; type?: string; function: { name: string; arguments: string } }[];
}
interface Message {
  role: string;
  content: unknown;
  [key: string]: unknown;
}
interface Context {
  id: string;
  noise_before: boolean;
  stripped: Message[];
  kept: Message[];
}

const MODEL = option("model") ?? "tfy-managed/mimo-v2.6-flash";
const requestFile = option("request");
const sources = option("from")?.split(",");
if (!requestFile || !sources) die("Say --request <captured.json> and --from <run,run>.");
const wantedContexts = Number(option("contexts") ?? 40);
const repeats = Number(option("n") ?? 25);
const parallel = Number(option("parallel") ?? 12);
const outFile = option("out") ?? join(ROOT, "docs", "data", "reasoning-replay.json");

const captured = JSON.parse(readFileSync(requestFile!, "utf8")) as { messages: Message[]; [key: string]: unknown };
const system = captured.messages.filter((m) => m.role === "system");
const { messages: _messages, model: _model, ...settings } = captured;

// A small fixed-seed generator: the same contexts every time.
let seed = 20261106;
const random = () => (seed = (seed * 1664525 + 1013904223) % 2 ** 32) / 2 ** 32;

function conversation(turn: TurnExport, upTo: number, keep: boolean): Message[] {
  const input = turn.input as unknown as { content: { type: string; text?: string }[] }[];
  const text = input[0].content.filter((p) => p.type === "text").map((p) => p.text).join("\n");
  const messages: Message[] = [...system, { role: "user", content: text }];
  (turn.events as unknown as Event[]).slice(0, upTo).forEach((e) => {
    if ((e.threadId ?? "main") !== "main") return;
    if (e.type === "model.message") {
      const calls = (e.toolCalls ?? []).map((c) => ({ id: c.id, type: "function", function: c.function }));
      messages.push({ role: "assistant", content: e.content ?? null, ...(calls.length ? { tool_calls: calls } : {}), ...(keep && e.reasoningContent ? { reasoning_content: e.reasoningContent } : {}) });
    } else if (e.type === "tool.response" && e.toolCallId) {
      messages.push({ role: "tool", tool_call_id: e.toolCallId, content: e.content ?? "" });
    }
  });
  return messages;
}

const noisy: Context[] = [];
const others: Context[] = [];
for (const source of sources!) {
  const { turns } = JSON.parse(readFileSync(join(ROOT, source, "session.json"), "utf8")) as { turns: TurnExport[] };
  for (const turn of turns) {
    const events = turn.events as unknown as Event[];
    let assistants = 0;
    events.forEach((e, i) => {
      if (e.type !== "model.message" || (e.threadId ?? "main") !== "main") return;
      assistants++;
      const noise = isNoise(e.content ?? "") || isNoise(e.reasoningContent ?? "");
      if (assistants < 6 && !noise) return;
      (noise ? noisy : others).push({ id: `${turn.id}#${i}`, noise_before: noise, stripped: conversation(turn, i, false), kept: conversation(turn, i, true) });
    });
  }
}
const sample = [...others].sort(() => random() - 0.5).slice(0, Math.max(0, wantedContexts - noisy.length));
const contexts = [...noisy, ...sample];
console.log(`${contexts.length} contexts (${noisy.length} that gave noise before), ${repeats} repeats, 2 arms: ${contexts.length * repeats * 2} calls`);

interface Result {
  context: string;
  noise_before: boolean;
  arm: "stripped" | "kept";
  noise: boolean;
  prompt_tokens: number | null;
  error?: string;
  text?: string;
}

async function ask(context: Context, arm: "stripped" | "kept"): Promise<Result> {
  const base = { context: context.id, noise_before: context.noise_before, arm };
  try {
    const response = await fetch(`${process.env.MODEL_BASE_URL!.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.MODEL_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ ...settings, model: MODEL, messages: context[arm], stream: true, stream_options: { include_usage: true }, max_tokens: 120 }),
      signal: AbortSignal.timeout(180_000),
    });
    if (!response.ok) return { ...base, noise: false, prompt_tokens: null, error: `HTTP ${response.status}: ${(await response.text()).slice(0, 200)}` };
    let content = "";
    let reasoning = "";
    let promptTokens: number | null = null;
    for (const line of (await response.text()).split("\n")) {
      if (!line.startsWith("data: ") || line.includes("[DONE]")) continue;
      const chunk = JSON.parse(line.slice(6)) as { choices?: { delta?: { content?: string; reasoning_content?: string } }[]; usage?: { prompt_tokens?: number } };
      content += chunk.choices?.[0]?.delta?.content ?? "";
      reasoning += chunk.choices?.[0]?.delta?.reasoning_content ?? "";
      promptTokens = chunk.usage?.prompt_tokens ?? promptTokens;
    }
    const noise = isNoise(content) || isNoise(reasoning);
    return { ...base, noise, prompt_tokens: promptTokens, ...(noise ? { text: (content || reasoning).slice(0, 100) } : {}) };
  } catch (e) {
    return { ...base, noise: false, prompt_tokens: null, error: String(e).slice(0, 200) };
  }
}

const jobs: [Context, "stripped" | "kept"][] = [];
for (let r = 0; r < repeats; r++) for (const c of contexts) jobs.push([c, "stripped"], [c, "kept"]);
const results: Result[] = [];
await Promise.all(
  Array.from({ length: parallel }, async () => {
    for (let job = jobs.shift(); job; job = jobs.shift()) {
      results.push(await ask(...job));
      if (results.length % 200 === 0) console.log(`  ${results.length} calls, noise so far: stripped ${results.filter((x) => x.arm === "stripped" && x.noise).length}, kept ${results.filter((x) => x.arm === "kept" && x.noise).length}`);
    }
  }),
);

/** Two-sided Fisher exact test on a 2×2 table. */
function fisher(a: number, b: number, c: number, d: number): number {
  const logFactorial = (n: number) => {
    let s = 0;
    for (let i = 2; i <= n; i++) s += Math.log(i);
    return s;
  };
  const logP = (x: number) => {
    const [r1, r2, c1, c2, n] = [a + b, c + d, a + c, b + d, a + b + c + d];
    return logFactorial(r1) + logFactorial(r2) + logFactorial(c1) + logFactorial(c2) - logFactorial(n) - logFactorial(x) - logFactorial(r1 - x) - logFactorial(c1 - x) - logFactorial(r2 - c1 + x);
  };
  const seen = logP(a);
  let p = 0;
  for (let x = Math.max(0, a + c - (c + d)); x <= Math.min(a + b, a + c); x++) if (logP(x) <= seen + 1e-9) p += Math.exp(logP(x));
  return Math.min(1, p);
}

const summary = (arm: "stripped" | "kept") => {
  const rows = results.filter((r) => r.arm === arm);
  const answered = rows.filter((r) => !r.error);
  const tokens = answered.map((r) => r.prompt_tokens ?? 0);
  return { calls: rows.length, errors: rows.length - answered.length, noise: answered.filter((r) => r.noise).length, noise_on_earlier_noise_points: answered.filter((r) => r.noise && r.noise_before).length, mean_prompt_tokens: Math.round(tokens.reduce((s, t) => s + t, 0) / (tokens.length || 1)) };
};
const stripped = summary("stripped");
const kept = summary("kept");
const p = fisher(stripped.noise, stripped.calls - stripped.errors - stripped.noise, kept.noise, kept.calls - kept.errors - kept.noise);
const out = { model: MODEL, date: new Date().toISOString(), contexts: contexts.length, earlier_noise_contexts: noisy.length, repeats, stripped, kept, fisher_p: Number(p.toFixed(5)), noise_samples: results.filter((r) => r.noise).slice(0, 20), errors: [...new Set(results.flatMap((r) => r.error ?? []))].slice(0, 10) };
writeFileSync(outFile, JSON.stringify(out, null, 1) + "\n");
console.log(JSON.stringify({ stripped, kept, fisher_p: out.fisher_p, errors: out.errors }, null, 1));
console.log(`Saved ${outFile.replace(`${ROOT}/`, "")}.`);
