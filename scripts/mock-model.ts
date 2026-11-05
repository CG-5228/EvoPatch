// npm run mock-model -- <scenarios.json> [port]
//
// Dev only: an OpenAI-compatible server that replays scripted steps, so the sandbox and the harness can be tested
// with no model key. TrueForge only ever calls POST {base_url}/chat/completions with stream:true.
// The first user message picks the scenario: a [[mock:NAME]] marker, or a "routes" entry whose text it contains.
// The step is the number of assistant messages so far, so the server keeps no state. Subagents and anything
// unscripted get a plain text answer.
//
// A step is one of: {"exec": "command"}, {"subagent": {"name": "...", "input": "..."}}, {"text": "final reply"},
// {"status": 429}, {"streamError": "message"}, {"finish": "length"}.

import { readFileSync } from "node:fs";
import { createServer, type ServerResponse } from "node:http";

type Step =
  | { exec: string }
  | { subagent: { name: string; input: string } }
  | { text: string }
  | { status: number }
  | { streamError: string }
  | { finish: string };

interface Message {
  role: string;
  content?: string | { type: string; text?: string }[] | null;
}

const [file, port = "8799"] = process.argv.slice(2);
if (!file) throw new Error("usage: mock-model <scenarios.json> [port]");
// After the Nth "improve" scenario, tasks use the scenario "better-N", if there is one: a stand-in for a better agent.
let improvements = 0;
const { routes = {}, ...scenarios } = JSON.parse(readFileSync(file, "utf8")) as Record<string, Step[]> & { routes?: Record<string, string> };

function text(m: Message): string {
  if (typeof m.content === "string") return m.content;
  return (m.content ?? []).map((p) => p.text ?? "").join("");
}

function send(res: ServerResponse, chunk: unknown): void {
  res.write(`data: ${JSON.stringify(chunk)}\n\n`);
}

function finish(res: ServerResponse, reason: string): void {
  send(res, { choices: [{ delta: {}, finish_reason: reason }] });
  send(res, { choices: [], usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 } });
  res.write("data: [DONE]\n\n");
  res.end();
}

function toolCall(res: ServerResponse, step: number, name: string, args: unknown): void {
  const id = `call_${step}_0`;
  send(res, { choices: [{ delta: { role: "assistant", tool_calls: [{ index: 0, id, function: { name, arguments: "" } }] } }] });
  send(res, { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: JSON.stringify(args) } }] } }] });
  finish(res, "tool_calls");
}

function reply(res: ServerResponse, content: string): void {
  send(res, { choices: [{ delta: { role: "assistant", content } }] });
  finish(res, "stop");
}

createServer((req, res) => {
  let body = "";
  req.on("data", (d) => (body += d));
  req.on("end", () => {
    if (req.method !== "POST" || !req.url?.endsWith("/chat/completions")) {
      res.writeHead(404).end();
      return;
    }
    const messages = (JSON.parse(body) as { messages: Message[] }).messages;
    const start = () => res.writeHead(200, { "content-type": "text/event-stream" });
    if (messages.some((m) => m.role === "system" && text(m).includes("operating as a sub-agent"))) {
      start();
      reply(res, "Sub-agent report: nothing to add.");
      return;
    }
    const firstUser = messages.find((m) => m.role === "user");
    const said = firstUser ? text(firstUser) : "";
    const routed = Object.entries(routes as Record<string, string>).find(([needle]) => said.includes(needle))?.[1];
    const name = said.match(/\[\[mock:([\w-]+)\]\]/)?.[1] ?? routed ?? "default";
    const index = messages.filter((m) => m.role === "assistant").length;
    if (name === "improve" && index === 0) improvements++;
    const better = name === "default" && scenarios[`better-${improvements}`] ? `better-${improvements}` : name;
    const step = scenarios[better]?.[index];
    if (step && "status" in step) {
      res.writeHead(step.status, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: `mock status ${step.status}` } }));
      return;
    }
    start();
    if (!step) reply(res, "Done.");
    else if ("exec" in step) toolCall(res, index, "exec", { intent: "scripted step", command: step.exec });
    else if ("subagent" in step) toolCall(res, index, "create_sub_agent", step.subagent);
    else if ("text" in step) reply(res, step.text);
    else if ("finish" in step) finish(res, step.finish);
    else {
      send(res, { error: { message: step.streamError } });
      res.end();
    }
  });
}).listen(Number(port), "127.0.0.1", () => console.log(`mock model on http://127.0.0.1:${port}/v1`));
