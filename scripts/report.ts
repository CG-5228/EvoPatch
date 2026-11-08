// npm run report            writes docs/results.md, docs/submission-facts.md and docs/data/results.json from runs/
// npm run compare -- 1 5    prints two runs side by side, task by task

import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadTasks } from "../evals/prompt.ts";
import type { TaskScore } from "../evals/score.ts";
import { git, GITHUB_REPO, howItEnded, protocol, REGISTRY_CSV, ROOT, runDir, RUNS_DIR, traceOf, turnStats, writeJson, type TurnExport } from "./lib.ts";

interface Row {
  run: number;
  score: number;
  train: number | null;
  holdout: number | null;
  commit: string;
  tree: string;
  tokens: number;
  classes: Record<string, number>;
  responses?: { model_calls: number; noise_responses: number; cut_off_responses: number };
  tests_only: number | null;
  cost_usd: number | null;
  tool_calls: number | null;
  session: string;
  usage: Record<string, unknown>;
  tasks: Record<string, { score: number; attempts: { attempt: number; outcome: string; bug_tests: string; similarity: number }[] }>;
}

function load(run: number): Row {
  const dir = runDir(run);
  const s = JSON.parse(readFileSync(join(dir, "score.json"), "utf8"));
  const results = JSON.parse(readFileSync(join(dir, "results.json"), "utf8")) as TaskScore[];
  return {
    run,
    score: s.score,
    train: s.train_score,
    holdout: s.holdout_score,
    commit: s.agent_commit,
    tree: s.agent_tree,
    tokens: s.tokens,
    classes: s.failure_classes,
    responses: s.responses,
    tests_only: s.tests_only_score ?? null,
    cost_usd: s.costUsd ?? null,
    tool_calls: s.toolCalls ?? null,
    session: s.session_id,
    usage: JSON.parse(readFileSync(join(dir, "feature-usage.json"), "utf8")),
    tasks: Object.fromEntries(
      results.map((r) => [r.task_id, { score: r.score, attempts: r.attempts.map((a) => ({ attempt: a.attempt, outcome: a.failure_class, bug_tests: `${a.f2p_passed}/${a.f2p_total}`, similarity: a.similarity })) }]),
    ),
  };
}

const runs = readdirSync(RUNS_DIR).filter((d) => /^run-\d+$/.test(d) && existsSync(join(RUNS_DIR, d, "score.json"))).map((d) => Number(d.slice(4))).sort((a, b) => a - b);

if (process.argv[2] === "compare") {
  const [a, b] = process.argv.slice(3).map((n) => load(Number(n)));
  console.log(`${"".padEnd(30)} run ${String(a.run).padStart(2, "0")}   run ${String(b.run).padStart(2, "0")}`);
  for (const t of loadTasks()) {
    const x = a.tasks[t.id]?.score ?? 0;
    const y = b.tasks[t.id]?.score ?? 0;
    console.log(`${(t.holdout ? "* " : "  ") + t.id.padEnd(28)} ${x.toFixed(2).padStart(6)}   ${y.toFixed(2).padStart(6)}  ${y > x ? "better" : y < x ? "worse" : ""}`);
  }
  console.log(`\n${"held-out (*)".padEnd(30)} ${String(a.holdout).padStart(6)}   ${String(b.holdout).padStart(6)}`);
  console.log(`${"train".padEnd(30)} ${String(a.train).padStart(6)}   ${String(b.train).padStart(6)}`);
  console.log(`${"score".padEnd(30)} ${String(a.score).padStart(6)}   ${String(b.score).padStart(6)}`);
  process.exit(0);
}

// ---------- what the sessions show ----------

const ENDINGS = ["time_limit", "output_cap", "iteration_limit", "safety_filter", "other"] as const;
type Endings = Record<(typeof ENDINGS)[number], number>;

interface Reviewer {
  attempts: number;
  reviewed: number;
  briefs: number;
  briefs_with_network_rule: number;
  reviewer_hit: number;
  root_hit: number;
  voided: number;
  voided_reviewer_only: number;
  voided_root_only: number;
  voided_both: number;
  voided_unmatched: number;
  patches_submitted: number;
  patches_passing: number;
}

/**
 * A reviewer sees only the brief the root writes, so the prompt's rule reaches it only if the root passes it on.
 * Matches the wordings the briefs actually used, read by hand: the baseline's ("no network", "do not fetch") and the
 * line the agent added to patch-review in round 4 ("Work only inside `work/repo`: no fetching from the network, ...").
 */
const NETWORK_RULE = /\b(no network|without (the )?network|not use the network|don'?t use the network|do not (fetch|download)|no fetching|no internet|offline|network access|work only inside|only inside `?work\/repo|no machine-wide searches|no other copies)\b/i;

/** Why an attempt with no patch stopped. */
function endingOf(turn: TurnExport | undefined): keyof Endings {
  if (!turn) return "other";
  const { turn_error } = howItEnded(turn);
  const message = turn_error ?? "";
  if ((turn.state as { reason?: string }).reason === "server-execution-timeout") return "time_limit";
  if (message.startsWith("Output truncated")) return "output_cap";
  if (message.startsWith("Output blocked")) return "safety_filter";
  if (/iteration limit/i.test(message)) return "iteration_limit";
  return "other";
}

/** Reads the whole session export, so `compare` doesn't call it. The audit stores shortened commands, so hits match by prefix. */
function evidence(run: number): { no_patch_endings: Endings; reviewer: Reviewer } | null {
  const file = join(runDir(run), "session.json");
  if (!existsSync(file)) return null;
  const { turns } = JSON.parse(readFileSync(file, "utf8")) as { turns: TurnExport[] };
  const byId = new Map(turns.map((t) => [t.id, t]));
  const results = JSON.parse(readFileSync(join(runDir(run), "results.json"), "utf8")) as TaskScore[];
  const attempts = results.flatMap((t) => t.attempts);
  const no_patch_endings = Object.fromEntries(ENDINGS.map((k) => [k, 0])) as Endings;
  const r: Reviewer = { attempts: attempts.length, reviewed: 0, briefs: 0, briefs_with_network_rule: 0, reviewer_hit: 0, root_hit: 0, voided: 0, voided_reviewer_only: 0, voided_root_only: 0, voided_both: 0, voided_unmatched: 0, patches_submitted: 0, patches_passing: 0 };
  for (const a of attempts) {
    const turn = a.turn_id ? byId.get(a.turn_id) : undefined;
    if (a.failure_class === "no_patch") no_patch_endings[endingOf(turn)]++;
    else {
      r.patches_submitted++;
      if (a.tests_resolved) r.patches_passing++;
    }
    const steps = turn ? traceOf(turn) : [];
    const briefs = steps.filter((s) => s.tool === "create_sub_agent");
    if (briefs.length) r.reviewed++;
    r.briefs += briefs.length;
    r.briefs_with_network_rule += briefs.filter((s) => NETWORK_RULE.test(s.command)).length;
    const hits = a.audit.hard.map((h) => h.command.replace(/…$/, "").slice(0, 120));
    const hit = (root: boolean) => steps.some((s) => s.tool === "exec" && (s.thread === "main") === root && hits.some((h) => s.command.startsWith(h)));
    const byRoot = hit(true);
    const byReviewer = hit(false);
    if (byRoot) r.root_hit++;
    if (byReviewer) r.reviewer_hit++;
    if (a.failure_class !== "audit") continue;
    r.voided++;
    if (byRoot && byReviewer) r.voided_both++;
    else if (byRoot) r.voided_root_only++;
    else if (byReviewer) r.voided_reviewer_only++;
    else r.voided_unmatched++;
  }
  return { no_patch_endings, reviewer: r };
}

// ---------- the record ----------

interface Entry {
  at: string;
  kind: string;
  label: string;
  session: string;
  commit: string;
  status: string;
}

const registry: Entry[] = existsSync(REGISTRY_CSV)
  ? readFileSync(REGISTRY_CSV, "utf8").trim().split("\n").slice(1).map((l) => {
      const [at, kind, label, session, commit, ...status] = l.split(",");
      return { at, kind, label, session, commit, status: status.join(",") };
    })
  : [];

/** First start to finish, across stops. `duration_s` in summary.csv covers less for runs that resumed on the old code. */
function clock(label: string): { wall_s: number | null; stops: number } {
  const events = registry.filter((e) => e.label === label);
  const start = events.find((e) => e.status === "started");
  const end = events.find((e) => e.status.startsWith("finished"));
  return { wall_s: start && end ? Math.round((Date.parse(end.at) - Date.parse(start.at)) / 1000) : null, stops: events.filter((e) => e.status.startsWith("aborted")).length };
}

const rows = runs.map((n) => ({ ...load(n), ...clock(`run-${String(n).padStart(2, "0")}`), ...(evidence(n) ?? { no_patch_endings: null, reviewer: null }) }));

/** The runs named in spread.md. Without it, the runs on run 1's agent. */
function baselineRuns(): number[] {
  const file = join(RUNS_DIR, "spread.md");
  const listed = existsSync(file) ? readFileSync(file, "utf8").match(/^Runs: (.*?) \(/m)?.[1].match(/\d+/g)?.map(Number) : undefined;
  return listed?.length ? listed : rows.filter((r) => r.tree === rows[0].tree).map((r) => r.run);
}

function range(values: (number | null)[]) {
  const xs = values.filter((v) => v !== null);
  if (!xs.length) return null;
  return { min: Math.min(...xs), max: Math.max(...xs), mean: Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 100) / 100 };
}

const baseline = baselineRuns();
const baseRows = rows.filter((r) => baseline.includes(r.run));
const spread = { score: range(baseRows.map((r) => r.score)), holdout: range(baseRows.map((r) => r.holdout)), train: range(baseRows.map((r) => r.train)) };
const lastTree = rows.at(-1)?.tree;
const finalRows = rows.filter((r) => !baseline.includes(r.run) && r.tree === lastTree);

const inside = (v: number | null, s: { min: number; max: number } | null) => (v === null || !s ? null : v >= s.min && v <= s.max);

/** Saved score.json files under a folder of runs that aren't in summary.csv. */
function sideRuns(folder: string) {
  const dir = join(RUNS_DIR, folder);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((d) => existsSync(join(dir, d, "score.json"))).sort().map((label) => {
    const s = JSON.parse(readFileSync(join(dir, label, "score.json"), "utf8"));
    return { label, commit: s.agent_commit as string, session: s.session_id as string, score: s.score as number, holdout: (s.holdout_score ?? null) as number | null, train: (s.train_score ?? null) as number | null, tests_only: (s.tests_only_score ?? null) as number | null, classes: s.failure_classes as Record<string, number>, responses: s.responses as Row["responses"], cost_usd: (s.costUsd ?? null) as number | null };
  });
}

const screens = sideRuns("search");
const controls = sideRuns("controls").map((c) => ({ ...c, score_in_baseline_range: inside(c.score, spread.score), holdout_in_baseline_range: inside(c.holdout, spread.holdout) }));

interface Round {
  round: number;
  kept: boolean;
  commit?: string;
  bar?: number;
  screens?: number[];
  change?: string;
  reason?: string;
  session?: string;
}

const roundsFile = join(RUNS_DIR, "rounds.json");
const rounds = existsSync(roundsFile) ? (JSON.parse(readFileSync(roundsFile, "utf8")) as Round[]) : [];

const sessionOf = (commit: string) => git("log", "-1", "--format=%B", commit).match(/^Agent-Session: (\S+)$/m)?.[1];

/** A file a learn commit added under runs/, read from that commit: reverting a dropped round removes it from the tree, not from history. */
function fromLearnCommit<T>(commit: string, name: string): T | null {
  const path = git("show", "--name-only", "--format=", commit).split("\n").find((p) => p.startsWith("runs/") && p.endsWith(`/${name}`));
  return path ? (JSON.parse(git("show", `${commit}:${path}`)) as T) : null;
}

/** Each round with the diagnosis it was based on and the change it made. */
function detail(round: Round) {
  const commit = round.commit;
  if (!commit) return round;
  const session = sessionOf(commit);
  return { ...round, session, diagnosis: session ? fromLearnCommit(commit, `diagnosis-${session}.json`) : null, diff: git("show", "--format=", commit, "--", "agent") };
}

function verdict() {
  const file = join(RUNS_DIR, "verdict.md");
  if (!existsSync(file)) return null;
  const text = readFileSync(file, "utf8");
  const checks = [...text.matchAll(/^\| (\d [^|]+) \| (PASS|FAIL|MANUAL) \| (.*) \|$/gm)].map((m) => ({ name: m[1], result: m[2], detail: m[3].replaceAll("\\|", "|") }));
  return { checks, line: text.match(/^Verdict: .*$/m)?.[0] ?? "", baseline: text.match(/^Baseline: ([^.]*)\./m)?.[1] ?? "", post: text.match(/Post-edit: ([^.]*)\./m)?.[1] ?? "" };
}

const detailed = rounds.map(detail);
const theVerdict = verdict();

// ---------- docs/results.md ----------

const link = (sha: string) => `[${sha.slice(0, 7)}](https://github.com/${GITHUB_REPO}/tree/${sha})`;
const dash = (v: unknown) => (v === null || v === undefined ? "-" : String(v));
const money = (v: number | null | undefined) => (v === null || v === undefined ? "-" : `$${v.toFixed(2)}`);
const hours = (s: number | null) => (s === null ? "-" : `${Math.floor(s / 3600)}h${String(Math.round((s % 3600) / 60)).padStart(2, "0")}`);
const sum = (xs: (number | null | undefined)[]) => xs.reduce<number>((a, b) => a + (b ?? 0), 0);
const seen = rows.filter((r) => r.reviewer);
const total = (k: keyof Reviewer) => sum(seen.map((r) => r.reviewer![k]));
const involved = (r: Reviewer) => r.voided_reviewer_only + r.voided_both;
const briefCount = (runs: typeof seen) => `${sum(runs.map((r) => r.reviewer!.briefs_with_network_rule))} of ${sum(runs.map((r) => r.reviewer!.briefs))}`;
const seenBaseline = seen.filter((r) => baseline.includes(r.run));
const seenAfter = seen.filter((r) => !baseline.includes(r.run));
const briefLine = `Reviewer briefs that told the reviewer to stay in the working tree: ${briefCount(seenBaseline)} in the baseline runs${seenAfter.length ? `, ${briefCount(seenAfter)} in the runs after the agent's changes` : ""}.`;
const finding = seen.length
  ? `Across ${seen.length} counted run${seen.length === 1 ? "" : "s"}, ${sum(seen.map((r) => involved(r.reviewer!)))} of ${total("voided")} voided attempts involve the reviewer subagent. It tripped the audit in ${total("reviewer_hit")} of ${total("reviewed")} reviewed attempts, the main agent in ${total("root_hit")} of ${total("attempts")}. ${briefLine} ${total("patches_passing")} of ${total("patches_submitted")} submitted patches passed the maintainers' tests.`
  : "";
const driftLine = (c: (typeof controls)[number]) => `${c.label}: score ${c.score}, held-out ${dash(c.holdout)}. Score ${c.score_in_baseline_range ? "inside" : "outside"} the baseline range, held-out ${c.holdout_in_baseline_range ? "inside" : "outside"} it.`;

const lines = [
  "# Results",
  "",
  "Generated by `npm run report` from `runs/`.",
  "",
  "| Run | Held-out | Train (in-sample) | Blended | Tests only | Agent commit | Tokens | Cost |",
  "|---|---|---|---|---|---|---|---|",
  ...rows.map((r) => `| ${r.run} | ${r.holdout ?? "-"} | ${r.train ?? "-"} | ${r.score} | ${dash(r.tests_only)} | ${link(r.commit)} | ${r.tokens} | ${money(r.cost_usd)} |`),
  "",
  "## Failure classes",
  "",
  "| Run | " + ["resolved", "f2p_failed", "p2p_regression", "no_patch", "timeout", "patch_rejected", "audit"].join(" | ") + " |",
  "|---|---|---|---|---|---|---|---|",
  ...rows.map((r) => `| ${r.run} | ${["resolved", "f2p_failed", "p2p_regression", "no_patch", "timeout", "patch_rejected", "audit"].map((c) => r.classes[c] ?? 0).join(" | ")} |`),
  "",
  "## How attempts with no patch ended",
  "",
  "| Run | 60-minute limit | 16k output limit | 120-iteration limit | Safety filter | Other |",
  "|---|---|---|---|---|---|",
  ...rows.map((r) => `| ${r.run} | ${ENDINGS.map((k) => dash(r.no_patch_endings?.[k])).join(" | ")} |`),
  "",
  "## The reviewer and the audit",
  "",
  ...(finding ? [finding, ""] : []),
  "| Run | Reviewed attempts | Reviewer tripped the audit | Main agent tripped it | Voided | Voided, reviewer involved | Voided, main agent only | Briefs with the working-tree rule | Patches submitted | Passed the tests |",
  "|---|---|---|---|---|---|---|---|---|---|",
  ...seen.map(({ run, reviewer: v }) => `| ${run} | ${v!.reviewed} | ${v!.reviewer_hit} | ${v!.root_hit} | ${v!.voided} | ${involved(v!)} | ${v!.voided_root_only} | ${v!.briefs_with_network_rule} of ${v!.briefs} | ${v!.patches_submitted} | ${v!.patches_passing} |`),
  "",
  "## Model responses",
  "",
  "Not scored. If the noise rate moves between runs, the model's service moved, not the agent.",
  "",
  "| Run | Model calls | Noise | Cut off at the output limit |",
  "|---|---|---|---|",
  ...rows.map((r) => `| ${r.run} | ${r.responses?.model_calls ?? "-"} | ${r.responses?.noise_responses ?? "-"} | ${r.responses?.cut_off_responses ?? "-"} |`),
  "",
  "## Drift check",
  "",
  "A late re-run of the run 1 agent, never counted. It asks whether the model's service changed while the agent was learning.",
  "",
  ...(controls.length ? controls.map((c) => `- ${driftLine(c)}`) : ["No control run yet."]),
  "",
];
writeFileSync(join(ROOT, "docs", "results.md"), lines.join("\n"));

writeJson(join(ROOT, "docs", "data", "results.json"), {
  repo: GITHUB_REPO,
  generated_from: git("rev-parse", "HEAD"),
  baseline_runs: baseline,
  spread,
  tasks: loadTasks().map(({ id, title, holdout, repo, bug_class, links, merged_at }) => ({ id, title, holdout, repo, bug_class, links, merged_at })),
  runs: rows,
  rounds: detailed,
  controls,
  verdict: theVerdict,
});

// ---------- docs/submission-facts.md ----------

const tasks = loadTasks();
const held = tasks.filter((t) => t.holdout);
const k = protocol.k;
const repos = [...new Set(tasks.map((t) => t.repo))].map((repo) => {
  const mine = tasks.filter((t) => t.repo === repo);
  return `| ${repo} | ${mine.length} | ${mine[0].holdout ? "held out" : "train"} |`;
});
const env = rows.length ? (JSON.parse(readFileSync(join(runDir(rows[0].run), "env.json"), "utf8")) as { model: { name: string }; server: string; scorer_image_id?: string }) : null;
const site = `https://${GITHUB_REPO.split("/")[0].toLowerCase()}.github.io/${GITHUB_REPO.split("/")[1]}/`;
const blob = `https://github.com/${GITHUB_REPO}/blob/main`;

// Every learn commit's improve session, kept or reverted.
const improveCosts = git("log", "--format=%H", "--grep=^Agent-Session: ", "--", "agent").split("\n").filter(Boolean).flatMap((sha) => {
  const session = sessionOf(sha);
  const exported = session ? fromLearnCommit<{ turns: TurnExport[] }>(sha, `improve-${session}.json`) : null;
  return exported ? [turnStats(exported.turns).costUsd] : [];
});
const costs = [
  ["Counted runs", rows.length, sum(rows.map((r) => r.cost_usd))],
  ["Screens", screens.length, sum(screens.map((s) => s.cost_usd))],
  ["Improve sessions", improveCosts.length, sum(improveCosts)],
  ["Control runs", controls.length, sum(controls.map((c) => c.cost_usd))],
] as const;

const learnCommits = git("log", "--reverse", "--format=%H", "--grep=^Agent-Session: ", "--", "agent").split("\n").filter(Boolean).map((sha) => {
  const round = rounds.find((r) => r.commit === sha);
  return { sha, subject: git("log", "-1", "--format=%s", sha), session: git("log", "-1", "--format=%B", sha).match(/^Agent-Session: (\S+)$/m)?.[1] ?? "", state: !round ? "being screened" : round.kept ? `round ${round.round}, kept` : `round ${round.round}, reverted` };
});

const readme = readFileSync(join(ROOT, "README.md"), "utf8");
const open = [
  ...(baseRows.length < 3 ? [`${3 - baseRows.length} baseline run(s) still to run.`] : []),
  ...(learnCommits.some((c) => c.state === "being screened") ? ["An agent edit is still being screened."] : []),
  ...(rounds.length < protocol.max_rounds ? [`Rounds recorded: ${rounds.length} of ${protocol.max_rounds}. None starts after ${protocol.rounds_end}.`] : []),
  ...(finalRows.length < 2 ? [`Final runs on the final agent: ${finalRows.length}, and 2 or more are needed.`] : []),
  ...(controls.length ? [] : ["The drift check (`--kind control --at <run 1 commit>`) hasn't run."]),
  ...(theVerdict ? [] : ["`npm run verdict` hasn't run."]),
  ...(/_pending/.test(readme) ? ["`README.md`: `## Run 1 vs run N` still has pending lines."] : []),
  ...(readme.includes("<!-- Chris:") ? ["`README.md`: the intro is still Chris's to write."] : []),
];

const gainLine = !theVerdict ? "Pending: no verdict yet." : theVerdict.line.includes("NOT") ? `Gain not shown. ${theVerdict.line}` : theVerdict.line;
const better = rows.slice(1).filter((r) => r.score > rows[0].score && !baseline.includes(r.run));

const facts = [
  "# Submission facts",
  "",
  `Generated by \`npm run report\` from \`runs/\` at ${git("rev-parse", "--short=7", "HEAD")}. Don't edit it: the next report overwrites it. Facts only. The pitch, commitment, three lines, recap, narration and feedback note are Chris's.`,
  "",
  "## Links",
  "",
  `- Repo: https://github.com/${GITHUB_REPO}`,
  `- Results site: ${site}`,
  `- Results tables: ${blob}/docs/results.md`,
  `- Protocol: ${blob}/docs/protocol.md`,
  `- Tasks and licences: ${blob}/docs/tasks.md`,
  `- TrueForge friction log: ${blob}/docs/friction-log.md`,
  `- Prior work and AI use: ${blob}/docs/prior-work.md`,
  `- Run data: ${blob}/runs/summary.csv`,
  ...(theVerdict ? [`- Five checks: ${blob}/runs/verdict.md`] : []),
  "",
  "## Setup",
  "",
  `- Model: \`${env?.model.name ?? "-"}\``,
  `- Server: \`${env?.server ?? "-"}\``,
  `- Frozen at tag \`eval-v1\`, commit ${git("rev-parse", "--short=7", "eval-v1^{commit}")}`,
  `- Tasks: ${tasks.length} real merged fixes, ${tasks.length - held.length} train, ${held.length} held out`,
  `- Attempts: ${k} per task, so ${tasks.length * k} per counted run and ${(tasks.length - held.length) * k} per screen`,
  `- Limits per attempt: ${protocol.iteration_limit} iterations, 60 minutes, 16,000 output tokens per response`,
  "",
  "| Repo | Tasks | Split |",
  "|---|---|---|",
  ...repos,
  "",
  "## Runs",
  "",
  "| Run | Score | Held-out | Train | Tests only | Cost | Wall clock | Stops | Agent commit | Session |",
  "|---|---|---|---|---|---|---|---|---|---|",
  ...rows.map((r) => `| ${r.run}${baseline.includes(r.run) ? " (baseline)" : ""} | ${r.score} | ${dash(r.holdout)} | ${dash(r.train)} | ${dash(r.tests_only)} | ${money(r.cost_usd)} | ${hours(r.wall_s)} | ${r.stops} | ${r.commit.slice(0, 7)} | \`${r.session}\` |`),
  "",
  "Wall clock is first start to finish, from `runs/registry.csv`. Stops are the registry's. Run 2 also stopped once for a crash that the registry can't show, and `duration_s` in `summary.csv` is short for runs 2 and 3. Both are explained in `docs/protocol.md`.",
  "",
  "## The spread and the bar",
  "",
  `- Baseline runs: ${baseline.join(", ")}`,
  `- Score: min ${dash(spread.score?.min)}, max ${dash(spread.score?.max)}, mean ${dash(spread.score?.mean)}`,
  `- Held-out: min ${dash(spread.holdout?.min)}, max ${dash(spread.holdout?.max)}, mean ${dash(spread.holdout?.mean)}`,
  `- Train: min ${dash(spread.train?.min)}, max ${dash(spread.train?.max)}, mean ${dash(spread.train?.mean)}`,
  `- Bar for every final run: above ${dash(spread.score?.max)} overall and above ${dash(spread.holdout?.max)} held out`,
  `- Bar for the first kept edit: both screens above train ${dash(spread.train?.max)}`,
  "",
  "## Result",
  "",
  `- ${gainLine}`,
  `- Run 1: ${rows[0]?.score ?? "-"}. Runs after the baseline that beat it: ${better.length ? better.map((r) => `run ${r.run} (${r.score})`).join(", ") : "none yet"}.`,
  `- Final runs: ${finalRows.length ? finalRows.map((r) => `run ${r.run}: ${r.score}, held-out ${dash(r.holdout)}`).join("; ") : "none yet"}`,
  ...(theVerdict?.checks ?? []).map((c) => `- ${c.name}: ${c.result}. ${c.detail}`),
  "",
  "## Rounds",
  "",
  ...(detailed.length
    ? [
        "| Round | Result | Screens | Bar | Commit | Session |",
        "|---|---|---|---|---|---|",
        ...detailed.map((r) => `| ${dash(r.round)} | ${r.kept ? "kept" : "dropped"} | ${(r.screens ?? []).join(", ") || dash(r.reason)} | ${dash(r.bar)} | ${(r.commit ?? "-").slice(0, 7)} | \`${dash(r.session)}\` |`),
        "",
        ...detailed.filter((r) => r.change).map((r) => `- Round ${r.round}, in the agent's words: ${r.change}`),
      ]
    : ["No rounds recorded yet."]),
  "",
  "## Commits with `Agent-Session:`",
  "",
  ...(learnCommits.length ? learnCommits.map((c) => `- ${c.sha.slice(0, 7)} (${c.state}): \`Agent-Session: ${c.session}\``) : ["None yet."]),
  "",
  "## Why attempts fail",
  "",
  ...(finding ? [`- ${finding}`] : []),
  ...(seen.length ? [`- No patch, across counted runs: ${ENDINGS.map((e) => `${sum(rows.map((r) => r.no_patch_endings?.[e]))} ${e.replace("_", " ")}`).join(", ")}`] : []),
  "",
  "## Drift check",
  "",
  ...(controls.length ? controls.map((c) => `- ${driftLine(c)} Session \`${c.session}\`, agent commit ${c.commit.slice(0, 7)}.`) : ["Pending."]),
  "",
  "## TrueForge in the counted runs",
  "",
  `- Sandboxes: ${sum(rows.map((r) => r.usage.sandboxes as number))}`,
  `- Exec calls: ${sum(rows.map((r) => r.usage.execs as number))}`,
  `- Skill reads: ${sum(rows.flatMap((r) => Object.values((r.usage.skill_reads ?? {}) as Record<string, number>)))}`,
  `- Subagent threads: ${sum(rows.map((r) => r.usage.subagent_threads as number))}`,
  `- Model calls: ${sum(rows.map((r) => r.responses?.model_calls))}`,
  "",
  "## Cost",
  "",
  "| What | Sessions | Cost |",
  "|---|---|---|",
  ...costs.map(([name, n, usd]) => `| ${name} | ${n} | ${money(usd)} |`),
  `| Total | ${sum(costs.map((c) => c[1]))} | ${money(sum(costs.map((c) => c[2])))} |`,
  "",
  "From each session's own metrics. The pilots are separate: see `docs/pilot.md`.",
  "",
  "## Open items",
  "",
  ...(open.length ? open.map((o) => `- ${o}`) : ["Nothing `report` can see."]),
  "",
  "`report` can't see these: every counted attempt re-scored in the pinned image (`npm run score -- runs/run-NN`), `npm run verify-submission` on a fresh clone, the MCP commitment, the declaration, the video and the submission.",
  "",
];
writeFileSync(join(ROOT, "docs", "submission-facts.md"), facts.join("\n"));
console.log(`✓ docs/results.md and docs/submission-facts.md: ${rows.length} runs`);
