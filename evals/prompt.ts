// What the agent gets for one task: the message and a tarball. Frozen with the tasks: same bytes every run.
// The tarball holds repo/ (the project at the fix's parent commit) and tools/. Never hidden/ or reference.patch.

import { existsSync, lstatSync, readdirSync, readFileSync, readlinkSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { EVALS_DIR, profileFor, type Profile } from "./docker.ts";

export interface Task {
  id: string;
  title: string;
  holdout: boolean;
  language: "python" | "js";
  repo: string;
  base_sha: string;
  fix_sha: string;
  pr: number;
  issue: number | null;
  links: string[];
  merged_at: string;
  license: string;
  bug_class: string;
  issue_text: string;
  profile_overrides?: Partial<Profile>;
}

export const tarballName = (t: Task) => `${t.id}.tar.gz`;
export const fixtureDir = (t: Task) => join(EVALS_DIR, "fixtures", t.id);

export function loadTasks(): Task[] {
  const dir = join(EVALS_DIR, "tasks");
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")) as Task);
}

export function taskPrompt(t: Task): string {
  return [
    `Fix the bug in this report. The project is in \`uploads/${tarballName(t)}\`.`,
    "",
    `Unpack it first: \`mkdir -p work out && tar -xzf uploads/${tarballName(t)} -C work\`. The project is then in \`work/repo\`.`,
    "`work/tools/test` runs its tests. When you are done, run `work/tools/finish \"what you changed and why\"`: only that patch is scored.",
    "",
    "Your fix is graded by the project's own tests, including tests you can't see. Editing test files changes nothing: only source files are applied.",
    "An attempt is void if it fetches this project's code or its fix from the network, or reads another copy of this library on this machine.",
    "",
    "## Bug report",
    "",
    t.issue_text.trim(),
  ].join("\n");
}

/** pytest wants file paths in --deselect; the ids we store are `tests.test_x::name`. */
function nodeId(id: string): string {
  const [module, ...rest] = id.split("::");
  return `${module.replaceAll(".", "/")}.py::${rest.join("::")}`;
}

function toolsConfig(t: Task, profile: Profile) {
  const stale = JSON.parse(readFileSync(join(fixtureDir(t), "stale.json"), "utf8")) as string[];
  return {
    language: profile.language,
    tarball: tarballName(t),
    pythonpath: profile.pythonpath,
    pytest_args: profile.pytest_args,
    targets: profile.targets,
    test_paths: profile.test_paths,
    test_exclude: profile.test_exclude,
    ignore: profile.visible_ignore,
    deselect: profile.language === "python" ? stale.map(nodeId) : [],
  };
}

// ---------- a deterministic tar: sorted, fixed owner and time ----------

interface Entry {
  path: string;
  mode: number;
  body?: Buffer;
  link?: string;
}

function walk(dir: string, prefix: string, out: Entry[]): void {
  for (const name of readdirSync(dir).sort()) {
    if (name === "__pycache__" || name === ".DS_Store") continue;
    const full = join(dir, name);
    const path = `${prefix}/${name}`;
    const st = lstatSync(full);
    if (st.isSymbolicLink()) out.push({ path, mode: 0o777, link: readlinkSync(full) });
    else if (st.isDirectory()) {
      out.push({ path: `${path}/`, mode: 0o755 });
      walk(full, path, out);
    } else out.push({ path, mode: st.mode & 0o111 ? 0o755 : 0o644, body: readFileSync(full) });
  }
}

function header(e: Entry): Buffer {
  const b = Buffer.alloc(512);
  let name = e.path;
  let prefix = "";
  if (Buffer.byteLength(name) > 100) {
    const cut = name.lastIndexOf("/", 154);
    prefix = name.slice(0, cut);
    name = name.slice(cut + 1);
    if (cut < 0 || Buffer.byteLength(name) > 100) throw new Error(`path too long for tar: ${e.path}`);
  }
  const octal = (n: number, width: number) => n.toString(8).padStart(width - 1, "0") + "\0";
  b.write(name, 0);
  b.write(octal(e.mode, 8), 100);
  b.write(octal(0, 8), 108);
  b.write(octal(0, 8), 116);
  b.write(octal(e.body?.length ?? 0, 12), 124);
  b.write(octal(0, 12), 136);
  b.write(" ".repeat(8), 148);
  b.write(e.link !== undefined ? "2" : e.path.endsWith("/") ? "5" : "0", 156);
  if (e.link !== undefined) b.write(e.link, 157);
  b.write("ustar\0" + "00", 257);
  b.write(prefix, 345);
  const sum = b.reduce((s, x) => s + x, 0);
  b.write(sum.toString(8).padStart(6, "0") + "\0 ", 148);
  return b;
}

export function taskTarball(t: Task): Buffer {
  const profile = profileFor(t);
  const entries: Entry[] = [{ path: "repo/", mode: 0o755 }];
  walk(join(fixtureDir(t), "repo"), "repo", entries);

  const tools = join(EVALS_DIR, "tools");
  entries.push({ path: "tools/", mode: 0o755 });
  for (const name of ["finish", "test", "timeout"]) entries.push({ path: `tools/${name}`, mode: 0o755, body: readFileSync(join(tools, name)) });
  entries.push({ path: "tools/task.json", mode: 0o644, body: Buffer.from(JSON.stringify(toolsConfig(t, profile), null, 1) + "\n") });
  if (profile.language === "python") {
    entries.push({ path: "tools/pylib/", mode: 0o755 });
    walk(join(tools, "pylib"), "tools/pylib", entries);
  } else {
    entries.push({ path: "node_modules/", mode: 0o755 }, { path: "node_modules/tap/", mode: 0o755 });
    entries.push({ path: "node_modules/tap/index.js", mode: 0o644, body: readFileSync(join(tools, "tap", "index.js")) });
  }

  const blocks: Buffer[] = [];
  for (const e of entries) {
    blocks.push(header(e));
    if (e.body?.length) blocks.push(e.body, Buffer.alloc((512 - (e.body.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(blocks), { level: 9 });
}

export function fixtureReady(t: Task): boolean {
  return existsSync(join(fixtureDir(t), "f2p.json"));
}
