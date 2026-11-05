// npm run guards-selftest: every kind of bad self-edit must be rejected, and a good one accepted.

import { checkProposal, type Diagnosis, type Proposal } from "./guards.ts";
import { classifyTurn } from "./lib.ts";

const skillPath = "agent/skills/fix-workflow/SKILL.md";
const parentSkill = "---\nname: fix-workflow\ndescription: The steps for fixing a bug.\n---\n\n# Fix workflow\n\n1. Reproduce.\n";
const instructions = "# EvoPatch\n\n## Output\n\nRun `work/tools/finish`. It writes `out/patch.diff`.\n";
const parentFiles: Proposal[] = [
  { path: skillPath, text: parentSkill },
  { path: "agent/instructions.md", text: instructions },
];
const parent = (path: string) => parentFiles.find((f) => f.path === path)?.text ?? null;
const failures = new Set(["run-01/boltons-404-omd-eq-1", "run-01/boltons-458-addlist-2", "run-02/boltons-404-omd-eq-2"]);
const good: Diagnosis = { cause: "Stopped at the example", rule: "Check neighbours", cited: ["run-01/boltons-404-omd-eq-1", "run-01/boltons-458-addlist-2"], predicted_effect: "Fewer partial fixes" };
const edit = (extra: string): Proposal[] => [{ path: skillPath, text: `${parentSkill}2. ${extra}\n` }];

let failed = 0;
function check(name: string, files: Proposal[], diagnosis: Diagnosis, wantProblem: RegExp | null, extra: string[] = []): void {
  const problems = checkProposal(files, diagnosis, failures, parent, parentFiles, extra);
  const ok = wantProblem ? problems.some((p) => wantProblem.test(p)) : problems.length === 0;
  if (!ok) failed++;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : `: ${JSON.stringify(problems)}`}`);
}

check("a small general rule is accepted", edit("Check the values next to the reported one."), good, null);
check("no files", [], good, /no files/);
check("cites one attempt", edit("Check."), { ...good, cited: ["run-01/boltons-404-omd-eq-1"] }, /at least 2 failed/);
check("cites two attempts of one task", edit("Check."), { ...good, cited: ["run-01/boltons-404-omd-eq-1", "run-02/boltons-404-omd-eq-2"] }, /2 different tasks/);
check("cites an attempt that didn't fail", edit("Check."), { ...good, cited: ["run-01/boltons-404-omd-eq-1", "run-09/made-up-1"] }, /isn't a failed attempt/);
check("no root cause", edit("Check."), { ...good, cause: " " }, /needs cause/);
check("writes outside the allowed files", [{ path: "evals/score.ts", text: "x" }], good, /isn't an allowed file/);
check("writes agent.json", [{ path: "agent/agent.json", text: "{}" }], good, /isn't an allowed file/);
check("bad skill name", [{ path: "agent/skills/Bad_Name/SKILL.md", text: parentSkill }], good, /isn't an allowed file/);
check("frontmatter name mismatch", [{ path: skillPath, text: parentSkill.replace("name: fix-workflow", "name: other") }], good, /frontmatter name/);
check("block-scalar description", [{ path: skillPath, text: parentSkill.replace("description: The steps for fixing a bug.", "description: >-") }], good, /description must be one line/);
check("empty skill body", [{ path: skillPath, text: "---\nname: fix-workflow\ndescription: x\n---\n" }], good, /no body/);
check("drops the output contract", [{ path: "agent/instructions.md", text: "# EvoPatch\n\nJust fix it.\n" }], good, /lost/);
check("too many changed lines", [{ path: skillPath, text: parentSkill + Array.from({ length: 60 }, (_, i) => `- rule ${i}`).join("\n") + "\n" }], good, /lines changed/);
check("skill over the size cap", [{ path: skillPath, text: parentSkill.replace("# Fix workflow", `# ${"x".repeat(13000)}`) }], good, /over 12000 bytes/);
check("names a library", edit("In boltons, copy the iterable."), good, /quotes "boltons"/);
check("names a function", edit("Check zip_broadcast twice."), good, /quotes "zip_broadcast"/);
check("names a task", edit("See mit-1284-bucket."), good, /quotes "mit-1284-bucket"/);
check("quotes a line of a fix", edit("Add: if exp < len(suffix) and abs(float(format % (abs_bytes / (base**exp)))) >= base:"), good, /quotes "if exp < len/);
check("cites an issue number", edit("Same as #1284."), good, /issue number/);
check("quotes a string from the bundle", edit("Run test_should_do_the_thing again."), good, /quotes "test_should_do_the_thing"/, ["test_should_do_the_thing"]);
check("plain words like diff and metric are fine", edit("Compare the diff against the metric you care about."), good, null);

const turn = (name: string, state: Parameters<typeof classifyTurn>[0], outcome: string, fatal = false) => {
  const got = classifyTurn(state);
  const ok = got.outcome === outcome && got.fatal === fatal;
  if (!ok) failed++;
  console.log(`${ok ? "ok  " : "FAIL"} turn: ${name}${ok ? "" : `: ${JSON.stringify(got)}`}`);
};
turn("finished", { status: "done" }, "ok");
turn("paused for an action", { status: "done", requiredActions: [{}] }, "infra");
turn("status paused", { status: "paused" }, "infra");
turn("rate limited", { status: "error", message: "Request failed (429): slow down" }, "infra");
turn("server error", { status: "error", message: "Request failed (500): oops" }, "infra");
turn("bad key", { status: "error", message: "Request failed (401): bad key" }, "infra", true);
turn("out of credit", { status: "error", message: "Request failed (402): payment required" }, "infra", true);
turn("output truncated", { status: "error", message: "Output truncated at the token limit" }, "failed");
turn("ran out of time", { status: "cancelled", reason: "server-execution-timeout" }, "failed");
turn("ran out of steps", { status: "error", message: "You have reached iteration limit of 120, please request again" }, "failed");
turn("abandoned", { status: "cancelled", reason: "abandoned" }, "infra");

console.log(failed ? `\n${failed} check(s) failed` : "\nAll checks passed");
process.exitCode = failed ? 1 : 0;
