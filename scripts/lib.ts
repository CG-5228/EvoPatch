// Shared helpers: config, the TrueForge client, git, the agent's files, turns, session exports.
// SDK: @truefoundry/trueforge-sdk (https://trueforge.dev/api/quickstart). The TypeScript SDK uses camelCase
// field names (previousTurnId, iterationLimit); the HTTP API and the docs' JSON use snake_case.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { TrueForge, TrueForgeApi } from "@truefoundry/trueforge-sdk";
import { Agent, setGlobalDispatcher } from "undici";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const AGENT_DIR = join(ROOT, "agent");
export const RUNS_DIR = join(ROOT, "runs");
export const SUMMARY_CSV = join(RUNS_DIR, "summary.csv");
export const REGISTRY_CSV = join(RUNS_DIR, "registry.csv");
export const GITHUB_REPO = "CG-5228/EvoPatch";

// ---------- config ----------

if (existsSync(join(ROOT, ".env"))) process.loadEnvFile(join(ROOT, ".env"));

export const env = {
  baseUrl: process.env.TRUEFORGE_BASE_URL ?? "http://localhost:8790",
  token: process.env.TRUEFORGE_TOKEN || undefined,
};

/** Frozen with the tasks: every counted run uses these. */
export interface Protocol {
  k: number;
  concurrency: number;
  iteration_limit: number;
  max_rounds: number;
  max_changed_lines: number;
  max_skill_bytes: number;
  max_agent_bytes: number;
  infra_retries: number;
  infra_abort_after: number;
}

export const protocol = JSON.parse(readFileSync(join(ROOT, "evals", "protocol.json"), "utf8")) as Protocol;

// A turn can take minutes before the first byte: uploads build the sandbox inside the POST.
setGlobalDispatcher(new Agent({ headersTimeout: 0, bodyTimeout: 0 }));

export function client(): TrueForge {
  return new TrueForge({ baseUrl: env.baseUrl, token: env.token, timeoutInSeconds: 900 });
}

export function die(msg: string): never {
  console.error(`\n✗ ${msg}\n`);
  process.exit(1);
}

export function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

export function option(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

// ---------- git ----------

export function git(...args: string[]): string {
  return execFileSync("git", args, { cwd: ROOT, encoding: "utf8", maxBuffer: 1 << 26 }).trim();
}

export function headSha(): string {
  return git("rev-parse", "HEAD");
}

/** True when these paths have no uncommitted changes (staged, unstaged or untracked). */
export function isClean(...paths: string[]): boolean {
  return git("status", "--porcelain", "--", ...paths) === "";
}

/** Dev only: rehearse the protocol in a throwaway clone. Nothing is pushed, and skills stay at this pushed commit. */
const REHEARSAL_REF = process.env.EVOPATCH_REHEARSAL_REF;

/** The commit a run's skills are fetched at. */
export const skillRef = (sha: string) => REHEARSAL_REF ?? sha;

/** True when GitHub has this commit: git skills are fetched from there. */
export function isPushed(sha: string): boolean {
  if (REHEARSAL_REF) return true;
  try {
    execFileSync("gh", ["api", `repos/${GITHUB_REPO}/commits/${sha}`, "--jq", ".sha"], { stdio: ["ignore", "pipe", "ignore"] });
    return true;
  } catch {
    return false;
  }
}

export function push(): void {
  if (REHEARSAL_REF) return;
  for (let i = 0; i < 3; i++) {
    try {
      git("push", "-q", "origin", "HEAD:main");
      return;
    } catch {
      git("pull", "-q", "--rebase", "origin", "main");
    }
  }
  die("git push failed three times.");
}

// ---------- the agent's files ----------

export interface AgentFile {
  name: string;
  description: string;
  model: { name: string; params?: Record<string, unknown> };
  /** "inline": skills are pasted into the instructions. "git": real TrueForge skills from this repo (the default here). */
  skill_mode?: "inline" | "git";
}

export interface SkillFile {
  name: string;
  description: string;
  body: string;
  /** Path inside the repo, e.g. agent/skills/fix-workflow */
  path: string;
}

export interface AgentAt {
  sha: string;
  agent: AgentFile;
  instructions: string;
  skills: SkillFile[];
}

/** Everything about the agent at one commit, so a run can never mix files from two versions. */
export function readAgentAt(sha: string): AgentAt {
  const show = (path: string) => git("show", `${sha}:${path}`);
  const agent = JSON.parse(show("agent/agent.json")) as AgentFile;
  if (process.env.TF_AGENT_NAME) agent.name = process.env.TF_AGENT_NAME;
  if (process.env.TF_MODEL) agent.model = { ...agent.model, name: process.env.TF_MODEL };
  const skills: SkillFile[] = [];
  for (const line of git("ls-tree", "--name-only", `${sha}:agent/skills`).split("\n").filter(Boolean).sort()) {
    const path = `agent/skills/${line}`;
    const { meta, body } = parseFrontmatter(show(`${path}/SKILL.md`));
    skills.push({ name: meta.name ?? line, description: meta.description ?? "", body, path });
  }
  return { sha, agent, instructions: show("agent/instructions.md"), skills };
}

export function parseFrontmatter(text: string): { meta: Record<string, string>; body: string } {
  const m = text.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) return { meta: {}, body: text };
  const meta: Record<string, string> = {};
  for (const line of m[1].split("\n")) {
    const kv = line.match(/^(\w+):\s*(.*)$/);
    if (kv) meta[kv[1]] = kv[2].trim();
  }
  return { meta, body: m[2] };
}

/** The only place that writes the agent's runtime config: agents.update replaces the whole manifest. */
export function buildManifest(at: AgentAt): TrueForgeApi.AgentSpec {
  return {
    model: at.agent.model,
    instructions: at.instructions.trim(),
    skills: at.skills.map((s) => ({ name: s.name })),
    config: {
      iterationLimit: protocol.iteration_limit,
      sandbox: { enabled: true, fileDownloads: false },
      dynamicSubAgents: { enabled: true },
      askUserQuestions: { enabled: false }, // runs are unattended: never pause for a question
      generativeUi: { enabled: false },
    },
  };
}

/**
 * Create or update the TrueForge agent so it matches agent/ at `sha`, with every skill pinned to that commit.
 * https://trueforge.dev/create-agent/overview#create-an-agent-via-the-api
 */
export async function syncAgent(tf: TrueForge, sha: string): Promise<{ saved: TrueForgeApi.Agent; at: AgentAt }> {
  const at = readAgentAt(sha);
  if (!isPushed(sha)) die(`Commit ${sha.slice(0, 7)} isn't on GitHub yet, and skills are fetched from there. Push first.`);
  for (const s of at.skills) {
    await tf.settings.skills.createOrUpdate({
      manifest: { type: "git", name: s.name, description: s.description, url: `https://github.com/${GITHUB_REPO}`, path: s.path, ref: skillRef(sha) },
    });
  }
  const manifest = buildManifest(at);
  const existing = await findAgent(tf, at.agent.name);
  const { data } = existing
    ? await tf.agents.update(existing.id, { description: at.agent.description, manifest })
    : await tf.agents.create({ name: at.agent.name, description: at.agent.description, manifest });
  return { saved: data, at };
}

export async function findAgent(tf: TrueForge, name: string): Promise<TrueForgeApi.Agent | undefined> {
  const page = await tf.agents.list({ agentName: name }); // substring match, so check the exact name
  for await (const a of page) if (a.name === name) return a;
  return undefined;
}

// ---------- turns ----------

/** Text of a final model message (string or content parts). */
export function messageText(msg: TrueForgeApi.ModelMessageEvent | null | undefined): string {
  const c = msg?.content;
  if (!c) return "";
  if (typeof c === "string") return c;
  return c.map((p) => ("text" in p ? p.text : "")).join("");
}

export interface UploadFile {
  name: string;
  body: Buffer;
}

export interface TurnResult {
  turnId: string;
  status: string;
  text: string;
  error?: string;
  /** ok: the agent finished. failed: it ran out of room, which counts. infra: not the agent's fault, retry it. */
  outcome: "ok" | "failed" | "infra";
  /** The account can't continue: stop the run. */
  fatal: boolean;
}

const FATAL_ERROR = /\b(401|402|403)\b|unauthori[sz]ed|insufficient|quota|credit|budget/i;
const REAL_FAILURE = /^Output (truncated|blocked)/;

/** Decide whose fault a finished turn was. Written into docs/protocol.md before run 1. */
export function classifyTurn(state: { status: string; message?: string; reason?: string; requiredActions?: unknown[] }): Pick<TurnResult, "outcome" | "fatal"> {
  if (state.status === "done") return { outcome: state.requiredActions?.length ? "infra" : "ok", fatal: false };
  if (state.status === "cancelled") return { outcome: state.reason === "server-execution-timeout" ? "failed" : "infra", fatal: false };
  if (state.status === "error") {
    const message = state.message ?? "";
    if (REAL_FAILURE.test(message)) return { outcome: "failed", fatal: false };
    return { outcome: "infra", fatal: FATAL_ERROR.test(message) };
  }
  return { outcome: "infra", fatal: false };
}

const WALL_CLOCK_LIMIT_MS = 35 * 60 * 1000; // above the server's 30 minute turn limit

/**
 * Start one turn and poll until it ends. `previousTurnId: "none"` makes a new root turn with a fresh sandbox.
 * Uploads go in the same request, so a sandbox or skill failure rejects the POST: that is an infra result, never a failed attempt.
 */
export async function runTurn(tf: TrueForge, sessionId: string, text: string, opts: { files?: UploadFile[]; root?: boolean } = {}): Promise<TurnResult> {
  const content = [
    { type: "text" as const, text },
    ...(opts.files ?? []).map((f) => ({ type: "file" as const, name: f.name, data: `data:application/gzip;base64,${f.body.toString("base64")}` })),
  ];
  let turnId: string;
  try {
    const { data } = await tf.sessions.createTurn(
      sessionId,
      { input: [{ type: "user.message", content }], ...(opts.root === false ? {} : { previousTurnId: "none" }) },
      { maxRetries: 0 }, // a retried POST would start a second turn
    );
    turnId = data.id;
  } catch (e) {
    const error = `createTurn rejected: ${(e as Error).message.slice(0, 300)}`;
    return { turnId: "", status: "rejected", text: "", error, outcome: "infra", fatal: FATAL_ERROR.test(error) };
  }
  const started = Date.now();
  for (;;) {
    let state: TrueForgeApi.TurnState;
    try {
      state = (await tf.sessions.getTurn(sessionId, turnId)).data.state;
    } catch {
      await new Promise((r) => setTimeout(r, 5000));
      continue;
    }
    if (state.status !== "running") {
      const s = state as { status: string; message?: string; reason?: string; requiredActions?: unknown[]; output?: TrueForgeApi.ModelMessageEvent | null };
      return { turnId, status: s.status, text: messageText(s.output), error: s.message ?? s.reason, ...classifyTurn(s) };
    }
    if (Date.now() - started > WALL_CLOCK_LIMIT_MS) {
      return { turnId, status: "lost", text: "", error: "no end after 35 minutes", outcome: "infra", fatal: false };
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
}

export async function downloadFile(tf: TrueForge, sessionId: string, turnId: string, path: string): Promise<Buffer | null> {
  try {
    const file = await tf.sessions.downloadSandboxFile(sessionId, turnId, { path });
    return Buffer.from(await file.arrayBuffer());
  } catch {
    return null;
  }
}

// ---------- session exports ----------

export type TurnExport = TrueForgeApi.Turn & { events: TrueForgeApi.SessionEvent[] };

/** Uploads echo into turn records as base64. Keep their hash and size, so the tarball can be rebuilt and matched. */
function redact(value: unknown, found: { sha256: string; bytes: number }[]): unknown {
  if (typeof value === "string") {
    const m = value.match(/^data:[^;,]+;base64,(.*)$/s);
    if (!m) return value;
    const bytes = Buffer.from(m[1], "base64");
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    found.push({ sha256, bytes: bytes.length });
    return `[upload removed from this export: sha256 ${sha256}, ${bytes.length} bytes]`;
  }
  if (Array.isArray(value)) return value.map((v) => redact(v, found));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redact(v, found)]));
  return value;
}

export async function exportTurn(tf: TrueForge, sessionId: string, turnId: string): Promise<{ turn: TurnExport; uploads: { sha256: string; bytes: number }[] }> {
  const { data: turn } = await tf.sessions.getTurn(sessionId, turnId);
  const events: TrueForgeApi.SessionEvent[] = [];
  for await (const e of await tf.sessions.listTurnEvents(sessionId, turnId, { order: "asc" })) events.push(e);
  const uploads: { sha256: string; bytes: number }[] = [];
  return { turn: redact({ ...turn, events }, uploads) as TurnExport, uploads };
}

export async function exportSession(tf: TrueForge, sessionId: string) {
  const { data: session } = await tf.sessions.get(sessionId);
  const turns: TurnExport[] = [];
  const uploads: { sha256: string; bytes: number }[] = [];
  for await (const t of await tf.sessions.listTurns(sessionId)) {
    const one = await exportTurn(tf, sessionId, t.id);
    turns.push(one.turn);
    uploads.push(...one.uploads);
  }
  turns.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  return {
    exported_at: new Date().toISOString(),
    base_url: env.baseUrl,
    redactions: { note: "Uploaded tarballs are replaced by their sha256 and size. evals/prompt.ts rebuilds them.", uploads },
    session,
    turns,
  };
}

export type SessionExport = Awaited<ReturnType<typeof exportSession>>;

// ---------- reading what happened in a turn ----------

interface RawEvent {
  type: string;
  threadId?: string | null;
  createdAt?: string;
  toolCalls?: { id: string; function?: { name?: string; arguments?: string }; name?: string; arguments?: string }[];
  toolCallId?: string;
  content?: unknown;
  agentInfo?: { name?: string };
}

export interface TraceStep {
  thread: string;
  tool: string;
  intent: string;
  command: string;
  exit: number | null;
  head: string;
  tail: string;
  seconds: number | null;
}

/** The turn as an ordered list of tool calls: only what the agent itself saw, shortened. */
export function traceOf(turn: TurnExport): TraceStep[] {
  const steps = new Map<string, TraceStep & { at: number }>();
  const out: TraceStep[] = [];
  for (const raw of turn.events as unknown as RawEvent[]) {
    const at = raw.createdAt ? Date.parse(raw.createdAt) : 0;
    if (raw.type === "model.message") {
      for (const c of raw.toolCalls ?? []) {
        const name = c.function?.name ?? c.name ?? "";
        let args: { intent?: string; command?: string; name?: string; input?: string } = {};
        try {
          args = JSON.parse(c.function?.arguments ?? c.arguments ?? "{}");
        } catch {
          // a malformed call stays in the trace with empty fields
        }
        const step = { thread: raw.threadId ?? "main", tool: name, intent: args.intent ?? args.name ?? "", command: args.command ?? args.input ?? "", exit: null, head: "", tail: "", seconds: null, at };
        steps.set(c.id, step);
        out.push(step);
      }
    } else if (raw.type === "tool.response" && raw.toolCallId) {
      const step = steps.get(raw.toolCallId);
      if (!step) continue;
      const text = typeof raw.content === "string" ? raw.content : JSON.stringify(raw.content ?? "");
      let result = text;
      try {
        const parsed = JSON.parse(text) as { response?: { exitCode?: number; result?: string } };
        step.exit = parsed.response?.exitCode ?? null;
        result = parsed.response?.result ?? text;
      } catch {
        // plain text result
      }
      step.head = result.slice(0, 600);
      step.tail = result.length > 1200 ? result.slice(-600) : result.slice(600);
      step.seconds = at && step.at ? Math.round((at - step.at) / 1000) : null;
    }
  }
  return out.map(({ thread, tool, intent, command, exit, head, tail, seconds }) => ({ thread, tool, intent, command, exit, head, tail, seconds }));
}

export function commandsOf(turn: TurnExport): string[] {
  return traceOf(turn).filter((s) => s.tool === "exec").map((s) => s.command);
}

/** Proof of what the turn used, from its events. */
export function featureUsage(turns: TurnExport[]) {
  const usage = { turns: turns.length, execs: 0, skill_reads: {} as Record<string, number>, subagent_threads: 0, subagent_names: [] as string[], sandboxes: 0, init_failures: 0, suspected_timeouts: 0 };
  for (const t of turns) {
    for (const raw of t.events as unknown as RawEvent[]) {
      if (raw.type === "sandbox.created") usage.sandboxes++;
      if (raw.type === "thread.created") {
        usage.subagent_threads++;
        if (raw.agentInfo?.name) usage.subagent_names.push(raw.agentInfo.name);
      }
    }
    for (const s of traceOf(t).filter((x) => x.tool === "exec")) {
      usage.execs++;
      for (const m of s.command.matchAll(/skills\/([a-z0-9-]+)\/SKILL\.md/g)) usage.skill_reads[m[1]] = (usage.skill_reads[m[1]] ?? 0) + 1;
      if (s.head.includes("Sandbox initialization failed")) usage.init_failures++;
      if (s.exit === 1 && !s.head && (s.seconds ?? 0) >= 55) usage.suspected_timeouts++;
    }
  }
  return usage;
}

/** Tokens and tool calls across turns. */
export function turnStats(turns: TurnExport[]): { tokens: number; toolCalls: number; costUsd: number } {
  let tokens = 0;
  let toolCalls = 0;
  let costUsd = 0;
  for (const t of turns) {
    const metrics = "metrics" in t.state ? (t.state.metrics as { totalTokens?: number; totalCostInUsd?: number } | undefined) : undefined;
    tokens += metrics?.totalTokens ?? 0;
    costUsd += metrics?.totalCostInUsd ?? 0;
    for (const e of t.events) if (e.type === "model.message") toolCalls += e.toolCalls?.length ?? 0;
  }
  return { tokens, toolCalls, costUsd: Math.round(costUsd * 10000) / 10000 };
}

export function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2) + "\n");
}

export function runDir(n: number): string {
  return join(RUNS_DIR, `run-${String(n).padStart(2, "0")}`);
}
