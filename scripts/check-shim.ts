// npm run check-shim: the sandbox runs node-semver's tests on a small tap shim, the scorer on real tap.
// They must agree on every test file, for every JS task, with and without the fix.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { profileFor, runInImage, type RunnerResult } from "../evals/docker.ts";
import { fixtureDir, loadTasks } from "../evals/prompt.ts";

const files = (r: RunnerResult) => Object.fromEntries(Object.entries(r.tests).filter(([id]) => id.endsWith("::(file)")));
let wrong = 0;
for (const t of loadTasks().filter((x) => x.language === "js")) {
  const profile = profileFor(t);
  const reference = readFileSync(join(fixtureDir(t), "reference.patch"));
  for (const [label, patch] of [["base", null], ["fixed", reference]] as const) {
    const real = files(await runInImage(fixtureDir(t), profile, patch));
    const shim = files(await runInImage(fixtureDir(t), profile, patch, true, true));
    const differ = [...new Set([...Object.keys(real), ...Object.keys(shim)])].filter((id) => real[id] !== shim[id]);
    wrong += differ.length;
    const failing = Object.values(real).filter((v) => v === "fail").length;
    console.log(`${differ.length ? "FAIL" : "ok  "} ${t.id.padEnd(28)} ${label.padEnd(5)} ${Object.keys(real).length} files, ${failing} failing${differ.length ? `; differ: ${differ.slice(0, 6).map((d) => `${d.replace("::(file)", "")} real=${real[d]} shim=${shim[d]}`).join("; ")}` : ""}`);
  }
}
console.log(wrong ? `\n${wrong} verdicts differ` : "\nShim and real tap agree");
process.exitCode = wrong ? 1 : 0;
