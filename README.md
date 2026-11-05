# TrueForge starter: an agent that gets better every time it runs

Starter repo for the **Stranger Builds** challenge *"Build an agent that gets better every time it runs"* (sponsor: [TrueForge](https://trueforge.dev) by TrueFoundry).

It gives you a working loop on day one, so you spend the week on the agent:

```
run the evals ──► score ──► the agent rewrites its own instructions/skill ──► run again ──► higher score?
   (TrueForge session)         (from its failures, committed with Agent-Session: <id>)
```

The example agent is a **code reviewer**: it reads a small code change and lists the real problems in it as JSON. Its playbook is a `review-checklist` skill that starts short on purpose. Swap in your own agent and tasks; keep the loop.

## Run 1 vs run N

> Fill this in at the end. Keep the heading: the challenge checks for it.

- **Task and score:** _e.g. review 6 small code changes (2 held out); score = 100 × mean(issues caught − 0.5 × noise comments) per task._
- **Baseline (run 1, 3 runs, nothing changed):** _e.g. runs 1-3: 44 / 50 / 56 → range 44-56; held-out 50 / 50 / 50 (`runs/spread.md`)._
- **After the change (2+ runs):** _e.g. runs 5-6: 72 / 75. Held-out: 50 → 67; training: 52 → 78 (`runs/summary.csv`)._
- **The change that did it:** _link to the commit with `Agent-Session:`, and what the agent learned in one line._
- **Real gain?** _yes / no, with the five checks (`runs/verdict.md`, see [What the judges check](#what-the-judges-check))._
- **What still fails:** _e.g. the held-out task's inverted range check (`||` vs `&&`)._

## What the challenge asks

Build an agent on TrueForge that looks at its own runs, rewrites its own skills or instructions, and does the job better the next time. Then prove it in a public repo. You **complete** the challenge when your repo shows all four:

1. **GitHub:** a public repo, created after Fri 30 Oct 23:00 UTC, **not a fork** (made from this template is fine).
2. **TrueForge runtime:** your agent runs on TrueForge, and each run you count is a TrueForge session.
3. **Run 1 vs a later run:** same tasks, same scorer. The later run comes after at least one change the agent made to itself.
4. **The agent changed itself, and it got better:** a commit with the agent's change to `agent/`, between run 1 and the later run, ending with `Agent-Session: <session_id>`, and a higher score after it.

The rule: **the agent writes the change.** You can review it, keep it or drop it. You don't write it.

That is the minimum. To be judged a **real** gain, it also has to pass TrueFoundry's five checks: see [What the judges check](#what-the-judges-check).

## What's in here

```
agent/
  agent.json                      name, description, model, skill_mode (inline | git)
  instructions.md                 the agent's instructions (its system prompt)
  skills/review-checklist/SKILL.md  its playbook, the part it rewrites most
evals/
  tasks/*.json                    the fixed task set (04 is a holdout: scored, never shown to improve)
  score.ts                        deterministic scorer → one number, higher is better
scripts/
  setup.ts                        create/update the TrueForge agent from agent/
  run-evals.ts                    one run = one TrueForge session; scores it, saves runs/run-NN/, adds a row to summary.csv
  improve.ts                      the agent reads its failed run and rewrites agent/; commits with Agent-Session
  smoke.ts                        one real turn through the agent, not saved as a run
  spread.ts                       the baseline spread of some runs → runs/spread.md (offline)
  verdict.ts                      the five checks: baseline runs vs post-edit runs → runs/verdict.md (offline)
  realgain.ts                     shared by spread and verdict
  export-session.ts               save any TrueForge session (session, turns, events) as JSON
  lib.ts                          shared helpers (TrueForge SDK client, git, files)
runs/summary.csv                  one row per run
runs/spread.md, runs/verdict.md   written by npm run spread / npm run verdict
```

## Quickstart (about 5 minutes)

You need Node.js 22.14+, git, and one model key (a TrueFoundry AI Gateway key, your own OpenAI/Anthropic/Gemini/... key, or any OpenAI-compatible endpoint).

**0. Make your repo** (after Fri 30 Oct 23:00 UTC). On GitHub, click **Use this template → Create a new repository**. Don't fork. Then clone it.

**1. Start TrueForge** in its own terminal, and keep it running:

```bash
npx @truefoundry/trueforge@latest
```

Open http://localhost:8790 → **Settings → Models** → pick your provider → paste your key → **Create**. Note the model name it shows, written `provider/model` (e.g. `anthropic/claude-sonnet-4-6`, `openai/gpt-5.2`).

**2. Install and configure:**

```bash
npm install
cp .env.example .env
# set TF_MODEL=provider/model in .env if it isn't anthropic/claude-sonnet-4-6
```

**3. Create the agent:**

```bash
npm run setup
# ✓ Agent "code-reviewer" (...) is in sync with agent/ at 1a2b3c4
```

It's now under **Agents** in the TrueForge UI. Send it one message as a smoke test: it catches a bad model setting before you start counting runs. It isn't a run.

```bash
npm run smoke
# ✓ Smoke test passed: code-reviewer answered 01-python-utils (score 0.67, session ...). Not counted as a run.
```

(Or click **Try** in the UI and paste a task.)

**4. Measure your baseline: run 1, three times, nothing changed.**

```bash
npm run run-evals
# Run 01: agent "code-reviewer" at 1a2b3c4, 4 tasks
#   01-python-utils          0.67
#   ...
# Run 01 score: 50 (0/4 tasks passed, 5414 tokens)
#   held-out: 50   training: 50
# ✓ Committed runs/run-01. Next: npm run run-evals again (2 more), to measure your baseline spread before any change
npm run run-evals
npm run run-evals
npm run spread -- 1,2,3      # → runs/spread.md: min, max, mean, median of the score and the held-out score
```

That range is the bar: a change only counts if it beats the highest. One lucky run is not a gain: agents are random, and with few tasks one flip moves the score a lot. After this, **don't change `evals/` or the model again.** Same tasks, same scorer, every run.

**5. Let the agent improve itself, then check the gain:**

```bash
npm run improve              # the agent rewrites agent/ from its failures; committed with Agent-Session: <id>
git show                     # read it: small? a general rule, not an answer to one task?
npm run run-evals            # two runs, so one lucky run can't fool you
npm run run-evals
npm run verdict -- 1,2,3 4,5 # the five checks → runs/verdict.md
```

`verdict` ends with **gain shown** (if the diff holds up when you read it) or **gain NOT shown (which check)**. Not shown? Undo the agent's commit (`git revert <its sha>`, find it with `git log -- agent`), and run `npm run improve` again. Stop after a few rounds with no gain and say so. Then fill in **Run 1 vs run N** above, and push.

## The loop, step by step

**`npm run run-evals`**
1. Refuses to run if `agent/` or `evals/` has uncommitted changes, so `agent_commit` always says exactly what ran.
2. Syncs the TrueForge agent with `agent/` (`agents.update`), so the files and the agent can't drift.
3. Opens **one TrueForge session** for the run. Each task is one **root turn** in it (`previousTurnId: "none"`), so tasks don't see each other.
4. Scores every reply with `evals/score.ts`, exports the session, and writes:
   - `runs/run-NN/results.json`: each reply and its score details
   - `runs/run-NN/score.json`: the run's numbers
   - `runs/run-NN/session.json`: the session, its turns and every event, from TrueForge
   - a new row in `runs/summary.csv`: `run, session_id, agent_commit, score, date_utc, tasks_passed, tasks_total, tokens, tool_calls, duration_s, holdout_score, train_score` (held-out and training tasks scored the same way, apart; empty when there are none)
5. Commits `runs/` as `run NN: score X` (skip with `--no-commit`).
6. Tells you what's next: until there are 3 runs, run again to measure the baseline spread; then `improve`.

**`npm run improve`** (options: `--run NN`, `--coach`, `--no-commit`)
1. Takes the failed tasks from the last run (never the holdout ones), with the scorer's feedback: what was missed, what was noise.
2. Opens a TrueForge session **with the agent itself** and asks it for new versions of its files. With `--coach`, a separate inline TrueForge "coach" agent on the same model writes them instead (allowed: "the agent, or a TrueForge agent coaching it").
3. Checks the answer: only `agent/instructions.md` and `agent/skills/*/SKILL.md` may change; skills keep their frontmatter; the JSON output format stays; and the new text **must not quote the eval tasks** (task ids, file names, the buggy lines), so the agent learns rules, not answers.
4. Writes the files, saves the improve session to `runs/run-NN/improve-session.json`, and commits:

   ```
   agent: learn from run 01

   I only checked three kinds of problems; I now also check ...

   Agent-Session: 01m5sab7yga874pqmr33w87hra
   ```

**`npm run smoke`**: one real turn (the first task) through the agent, scored and printed, nothing saved or committed. The session is titled "smoke test (not counted)".

**`npm run spread -- 1,2,3`** (or `1-3`): reads those runs' `score.json` and writes `runs/spread.md`: min, max, mean and median of the score and of the held-out score. Offline.

**`npm run verdict -- <baseline runs> <post-edit runs>`** (e.g. `-- 1,2,3 4,5`): the five checks, from `runs/` and git only (offline), written to `runs/verdict.md` with `runs/spread.md`:

| Check | PASS when |
|---|---|
| 1 Baseline spread | 3+ baseline runs with the same `agent/`, range recorded. MANUAL if they all scored the same (no spread to see yet). |
| 2 Scorer and tasks unchanged | `evals/` at every counted run and at HEAD is the same as at the first baseline run; no `-dirty` run. |
| 3 Held-out gain | every post-edit held-out score beats the baseline's highest held-out score. |
| 4 The diff | always MANUAL: it counts the lines changed in `agent/`, fails if they quote a task id, file name or buggy line (the same guard as `improve`), and gives you the `git diff` to read. |
| 5 Beats the spread, repeats | 2+ post-edit runs, every one above the baseline's highest score. |

Any FAIL → "gain NOT shown (...)". `npm run spread -- --selftest` checks this math on made-up runs.

**`npm run export-session -- <session_id> [out.json]`**: any session as JSON (e.g. one you ran in the UI). TrueForge has no export button yet; this pages through `sessions.get`, `sessions.listTurns` and `sessions.listTurnEvents`.

**`npm run score -- runs/run-NN`** re-scores a saved run. **`npm run score -- --selftest`** checks the scorer on perfect, empty and noisy answers.

## Make it yours

Pick your task and your scorer **before run 1**; after run 1 they're frozen.

- **The agent:** edit `agent/agent.json` (name, model), `agent/instructions.md` and the skill. Rename or add skills under `agent/skills/<name>/SKILL.md`.
- **The tasks:** put 5 or more in `evals/tasks/*.json` (3 is the minimum; this example's 4 is a demo). Mark one or two `"holdout": true`: they count in the score, but `improve` never shows them to the agent. If the held-out score goes up too, the agent learned something general; the judges check it.
- **The prompt per task:** `taskPrompt()` in `scripts/lib.ts`.
- **The scorer:** `evals/score.ts`. It must give **one number, higher is better**: tasks passed, a checker, tests, a judge prompt. Want to measure "cheaper"? Use tasks solved per 1,000 tokens (`score.json` has the tokens).
- **The improve prompt:** in `scripts/improve.ts`. Its overfitting guard is tuned for this example; adapt it to your tasks.

Some ideas from the challenge brief: a PR reviewer that sharpens its checklist; issue → PR with memory (run tests in the sandbox); an overnight janitor on a TrueForge schedule; subagents that coach each other; the cheaper agent.

## Skills and the sandbox

`agent/agent.json` has `"skill_mode"`:

- **`inline`** (default, no sandbox, nothing to install): `setup` pastes each `SKILL.md` into the agent's instructions. The agent rewrites the files; `setup` pushes them with `agents.update`. Works everywhere, including Windows.
- **`git`**: real TrueForge [skills](https://trueforge.dev/skills). `setup` registers each `agent/skills/<name>` from your **public** repo (`SKILL_REPO_URL` in `.env`), pinned to the commit that runs, and turns the sandbox on. Push before each `run-evals`. Skills need a sandbox:
  - local `npx` on **macOS**: built-in local sandbox;
  - local `npx` on **Linux**: built-in local sandbox once `bubblewrap`, `socat` and `ripgrep` are installed (restart TrueForge after);
  - Windows or hosted setups: [Daytona](https://trueforge.dev/sandbox) (has a free trial).

The challenge's submit form asks for **two or more** of: skills, subagents, MCP tools, the sandbox. **The default `inline` mode uses none of them**: the skill is pasted into the instructions as text. To meet the bar:

- switch to `"skill_mode": "git"`: real TrueForge skills plus the sandbox they run in (two). It is not yet verified end to end in this starter (see *Status* below);
- and/or give the agent MCP tools (Settings → Connectors) or subagents, and use them for real in the task.

Whichever you use, point to it in your README (where in `agent/` or the session it shows). Whether schedules, human checkpoints or the SDK also count is TrueFoundry's call; ask them before you rely on it.

### Local or open models

Any OpenAI-compatible endpoint works as a `custom` provider (**Settings → Models → Add custom provider**). If it runs on your own machine (Ollama, vLLM, LM Studio), TrueForge blocks private addresses by default; start it with your host allowed:

```bash
OUTBOUND_URL_ALLOWED_HOSTS='["127.0.0.1"]' npx @truefoundry/trueforge@latest
```

and use `http://127.0.0.1:<port>/v1` as the base URL.

## What the judges check

**Automatically, for everyone** (this is the minimum to complete):
- the repo is public, not a fork, and was created after the opening (Fri 30 Oct, 23:00 UTC);
- `agent/`, `evals/tasks/` (3+ tasks), `evals/score.*`, `runs/summary.csv` and this README with a **Run 1 vs run N** section exist;
- `summary.csv` has 2+ runs, and a later run scores higher than run 1;
- a commit that changes `agent/` and ends with `Agent-Session:` comes after run 1's commit and before the later run's.

**For finalists, TrueFoundry's judges check that the gain is real.** One later run beating one run 1 can be luck: agents are random, and with few tasks one flip moves the score a lot. In TrueFoundry's own demo, a baseline run scored higher than run 1 with nothing changed. A gain counts only if all five are true:

1. **You measured the baseline spread** before any edit: run 1 run 3 or more times, lowest and highest written down.
2. **The scorer never changed**, and the agent can't read it or quote it in its instructions.
3. **The gain shows up on held-out tasks** that `improve` never read.
4. **The diff is readable**: small, one change per round, a general rule, not a patch for one task.
5. **The gain is bigger than the spread** and survives a rerun: the later runs beat the baseline's highest score.

If one fails, say the gain wasn't shown. An honest "no real gain yet, here is why" beats a lucky number. Too noisy to tell? Add tasks (5+, one or two held out) and runs. `npm run verdict` runs these checks for you (check 4 still needs your eyes).

Judges open the sessions (`runs/run-NN/session.json`), the diffs, the scorer and `runs/verdict.md`, and may ask you to run it again live.

You also send: a video (up to 2 minutes), three lines (what it does, how it uses TrueForge, what it learned), and a half-page feedback note on TrueForge.

The five checks are TrueFoundry's method, from Anant Agarwal's (TrueFoundry) talk for Stranger Builds on 4 Nov 2026. The guide from that talk: [https://sb-self-improving-agents.vercel.app](https://sb-self-improving-agents.vercel.app).

## Troubleshooting

- **`Can't reach TrueForge`**: is `npx @truefoundry/trueforge@latest` still running? Different port? Set `TRUEFORGE_BASE_URL`.
- **`Model "..." is not configured`**: add the provider in Settings → Models, and set `TF_MODEL` to the exact `provider/model` name shown there.
- **A task shows `[error: ...]`**: the model call failed (key, quota, model name). The run still saves; fix it and run again before you count it.
- **`agent/ or evals/ has uncommitted changes`**: commit them. (`--allow-dirty` exists for experiments; the row is marked `-dirty`, don't count it.)
- **`skills require a sandbox provider`** in `git` mode: see *Skills and the sandbox*.
- **The model rejects `temperature`** (some reasoning models do): remove `params` in `agent/agent.json`.

## Status of this starter (v0)

Built against TrueForge `@truefoundry/trueforge` 0.180.0 and `@truefoundry/trueforge-sdk` 0.180.0 (23 Oct 2026).

- Tested end to end against a real local TrueForge server (npx, local mode) with a **mock** OpenAI-compatible model: `setup`, `run-evals` (run 1), `improve` (commit with `Agent-Session:`), `run-evals` (run 2), `export-session`, `score`. Not yet run with a real model key.
- TODO(verify): `skill_mode: "git"` end to end. Skill registration (`settings.skills.createOrUpdate`) is accepted by the server; running the skill needs a sandbox, which our test machine didn't have. See https://trueforge.dev/skills and https://trueforge.dev/sandbox.
- TODO(verify): the local sandbox on macOS needs no extra packages (from TrueForge's source, `packages/trueforge/src/sandbox/local`; not in the docs yet).
- `smoke`, `spread`, `verdict` and the new `holdout_score`/`train_score` columns: `spread` and `verdict` tested offline on made-up runs in a scratch repo (`npm run spread -- --selftest` plus real git history); `smoke` and the new `run-evals` columns not yet run against a TrueForge server.
- TODO: a scheduled variant (TrueForge [schedules](https://trueforge.dev/schedules)) that runs the evals nightly.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md), including how to contribute to [TrueForge](https://github.com/truefoundry/trueforge) itself.

## License

MIT, see [LICENSE](LICENSE).
