// Runs evals/runner.py in the pinned scorer image, with no network. The only way tests are ever executed for a score.

import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const EVALS_DIR = dirname(fileURLToPath(import.meta.url));
export const IMAGE = "evopatch-scorer:1";

export interface Profile {
  language: "python" | "js";
  test_paths: string[];
  source_paths: string[];
  drop?: string[];
  pythonpath?: string;
  pytest_args?: string[];
  targets?: string[];
  generated?: Record<string, string>;
  test_exclude?: string[];
  visible_ignore?: string[];
}

export interface RunnerResult {
  applied: boolean;
  kept: number;
  dropped: string[];
  apply_error?: string;
  timed_out: boolean;
  tests: Record<string, "pass" | "fail" | "skip">;
  failures: Record<string, { kind: string; message: string }>;
  rc: number | null;
  tail: string;
}

/** The scorer image's id, or "" if it isn't built. `docker image inspect` can't see it on Docker Desktop's image store. */
export function scorerImageId(): string {
  return execFileSync("docker", ["images", "--no-trunc", "--format", "{{.ID}}", IMAGE], { encoding: "utf8" }).trim();
}

export function loadProfiles(): Record<string, Profile> {
  return JSON.parse(readFileSync(join(EVALS_DIR, "profiles.json"), "utf8"));
}

/** A task's runner profile: its repo's, plus any overrides the task needs to run on today's tools. */
export function profileFor(task: { repo: string; profile_overrides?: Partial<Profile> }): Profile {
  return { ...loadProfiles()[task.repo], ...task.profile_overrides };
}

/** Never a synchronous call: a blocked event loop makes the harness's other requests fail (docs/friction-log.md). */
function docker(args: string[]): Promise<void> {
  return new Promise((done, fail) => {
    const child = spawn("docker", args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr = (stderr + chunk).slice(-4000);
    });
    child.on("error", fail);
    child.on("close", (code) => (code === 0 ? done() : fail(new Error(`docker exited with ${code}: ${stderr}`))));
  });
}

/** Apply `patch` (null for none) to the fixture's snapshot and run its tests. `overlayHidden` swaps in the maintainers' test files. */
export async function runInImage(fixtureDir: string, profile: Profile, patch: Buffer | string | null, overlayHidden = true, tapShim = false): Promise<RunnerResult> {
  const scratch = resolve(EVALS_DIR, "..", ".tmp");
  mkdirSync(scratch, { recursive: true });
  const job = mkdtempSync(join(scratch, "job-"));
  try {
    if (patch !== null) {
      mkdirSync(join(job, "patches"));
      writeFileSync(join(job, "patches", "attempt.diff"), patch);
    }
    writeFileSync(join(job, "job.json"), JSON.stringify({ profile, patch: patch === null ? null : "patches/attempt.diff", overlay_hidden: overlayHidden, node_path: tapShim ? "/tools" : null }));
    await docker(["run", "--rm", "--network", "none", "-v", `${resolve(fixtureDir)}:/fixture:ro`, "-v", `${job}:/job`, "-v", `${join(EVALS_DIR, "runner.py")}:/runner.py:ro`, "-v", `${join(EVALS_DIR, "tools")}:/tools:ro`, IMAGE, "python", "/runner.py"]);
    return JSON.parse(readFileSync(join(job, "result.json"), "utf8")) as RunnerResult;
  } finally {
    rmSync(job, { recursive: true, force: true });
  }
}
