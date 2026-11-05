// The checks a proposed self-edit must pass before it is committed. The agent writes the change; these only accept or
// reject it. Frozen with the protocol.

import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fixtureDir, loadTasks } from "../evals/prompt.ts";
import { parseFrontmatter, protocol, ROOT } from "./lib.ts";

export interface Proposal {
  path: string;
  text: string;
}

export interface Diagnosis {
  cause?: string;
  rule?: string;
  cited?: string[];
  predicted_effect?: string;
}

const ALLOWED = /^agent\/(instructions\.md|skills\/[a-z][a-z0-9-]{0,62}[a-z0-9]\/SKILL\.md)$/;

function leakCorpus(): string[] {
  const terms = JSON.parse(readFileSync(join(ROOT, "evals", "leak-terms.json"), "utf8")) as string[];
  for (const t of loadTasks()) {
    terms.push(t.id);
    const lines = readFileSync(join(fixtureDir(t), "reference.patch"), "utf8").split("\n").filter((l) => l.startsWith("+") && !l.startsWith("+++"));
    terms.push(...lines.map((l) => l.slice(1).trim()).filter((l) => l.length >= 16));
    for (const id of JSON.parse(readFileSync(join(fixtureDir(t), "f2p.json"), "utf8")) as string[]) {
      const name = id.split("::").pop()?.replace(/\[.*$/, "") ?? "";
      if (name.length >= 12) terms.push(name);
    }
  }
  return [...new Set(terms)];
}

/** What a proposal quotes from the tasks. Only the lines it adds are checked. */
export function findLeaks(files: Proposal[], extra: string[] = []): string[] {
  const corpus = [...leakCorpus(), ...extra];
  const leaks: string[] = [];
  for (const f of files) {
    for (const q of corpus) {
      const word = /^\w+$/.test(q) ? new RegExp(`\\b${q}\\b`) : null;
      if (word ? word.test(f.text) : f.text.includes(q)) leaks.push(`${f.path} quotes "${q.slice(0, 60)}"`);
    }
    if (/#\d{3,4}\b|\bissue \d{3,4}\b/i.test(f.text)) leaks.push(`${f.path} cites an issue number`);
  }
  return leaks;
}

/** Lines changed by the proposal against the parent's files. */
export function changedLines(files: Proposal[], parent: (path: string) => string | null): number {
  const dir = mkdtempSync(join(tmpdir(), "evopatch-diff-"));
  try {
    let total = 0;
    for (const f of files) {
      const a = join(dir, "a");
      const b = join(dir, "b");
      mkdirSync(dirname(a), { recursive: true });
      writeFileSync(a, parent(f.path) ?? "");
      writeFileSync(b, f.text);
      let out = "";
      try {
        execFileSync("git", ["diff", "--no-index", "--numstat", a, b], { encoding: "utf8" });
      } catch (e) {
        out = (e as { stdout?: string }).stdout ?? "";
      }
      const [added, removed] = out.trim().split(/\s+/).map(Number);
      total += (added || 0) + (removed || 0);
    }
    return total;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export function checkProposal(files: Proposal[], diagnosis: Diagnosis, failureIds: Set<string>, parent: (path: string) => string | null, allParentFiles: Proposal[], bundleStrings: string[]): string[] {
  const problems: string[] = [];
  if (!files.length) problems.push("no files proposed");

  const cited = [...new Set(diagnosis.cited ?? [])];
  if (!diagnosis.cause?.trim() || !diagnosis.rule?.trim() || !diagnosis.predicted_effect?.trim()) problems.push("diagnosis needs cause, rule and predicted_effect");
  if (cited.length < 2) problems.push("diagnosis must cite at least 2 failed attempts");
  for (const id of cited) if (!failureIds.has(id)) problems.push(`diagnosis cites "${id}", which isn't a failed attempt in the bundle`);
  if (new Set(cited.map((id) => id.replace(/^[^/]*\//, "").replace(/-\d+$/, ""))).size < 2) problems.push("diagnosis must cite failures on at least 2 different tasks: a rule from one task is a patch for that task");

  for (const f of files) {
    if (!ALLOWED.test(f.path)) problems.push(`${f.path} isn't an allowed file`);
    if (f.path.endsWith("/SKILL.md")) {
      const dirName = f.path.split("/")[2];
      const { meta, body } = parseFrontmatter(f.text);
      if (meta.name !== dirName) problems.push(`${f.path}: frontmatter name must be ${dirName}`);
      if (!meta.description || /^[>|]/.test(meta.description)) problems.push(`${f.path}: frontmatter description must be one line`);
      if (!body.trim()) problems.push(`${f.path} has no body`);
      if (Buffer.byteLength(f.text) > protocol.max_skill_bytes) problems.push(`${f.path} is over ${protocol.max_skill_bytes} bytes`);
    }
    if (f.path === "agent/instructions.md") {
      for (const required of ["## Output", "work/tools/finish", "out/patch.diff"]) if (!f.text.includes(required)) problems.push(`instructions.md lost "${required}"`);
    }
  }

  const lines = changedLines(files, parent);
  if (lines > protocol.max_changed_lines) problems.push(`${lines} lines changed; one round allows ${protocol.max_changed_lines}`);
  const after = new Map(allParentFiles.map((f) => [f.path, f.text]));
  for (const f of files) after.set(f.path, f.text);
  const size = [...after.values()].reduce((s, t) => s + Buffer.byteLength(t), 0);
  if (size > protocol.max_agent_bytes) problems.push(`agent files total ${size} bytes; the cap is ${protocol.max_agent_bytes}`);

  const added = files.map((f) => {
    const before = new Set((parent(f.path) ?? "").split("\n"));
    return { path: f.path, text: f.text.split("\n").filter((l) => !before.has(l)).join("\n") };
  });
  problems.push(...findLeaks(added, bundleStrings));
  return problems;
}
