// Dev only: what each provider failure really looks like through TrueForge, on the mock model.
import { client, classifyTurn, exportTurn, featureUsage, readAgentAt, buildManifest, headSha, runTurn } from "./lib.ts";

const tf = client();
const spec = buildManifest(readAgentAt(headSha()));
const cases: [string, string, boolean][] = [["s429", "infra", false], ["s500", "infra", false], ["s401", "infra", true], ["s402", "infra", true], ["midstream", "infra", false], ["length", "failed", false], ["slow", "ok", false]];
let failed = 0;
for (const [name, outcome, fatal] of cases) {
  const { data: session } = await tf.sessions.create({ agent: { spec: { ...spec, skills: [] } }, metadata: { purpose: "mock-infra" } });
  const t0 = Date.now();
  const turn = await runTurn(tf, session.id, `[[mock:${name}]] go`);
  const ok = turn.outcome === outcome && turn.fatal === fatal;
  if (!ok) failed++;
  const usage = name === "slow" ? featureUsage([(await exportTurn(tf, session.id, turn.turnId)).turn]) : null;
  console.log(`${ok ? "ok  " : "FAIL"} ${name.padEnd(10)} ${turn.status} -> ${turn.outcome} fatal=${turn.fatal} ${Math.round((Date.now() - t0) / 1000)}s ${String(turn.error ?? "").slice(0, 90)}${usage ? ` suspected_timeouts=${usage.suspected_timeouts}` : ""}`);
}
console.log(failed ? `${failed} wrong` : "all as expected", typeof classifyTurn);
