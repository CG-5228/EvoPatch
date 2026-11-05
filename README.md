# EvoPatch

<!-- Chris: your intro goes here, in your own words: who it's for and what it does. -->

EvoPatch is a bug-fixing agent on [TrueForge](https://trueforge.dev). It attempts real bug fixes, tests its own patches in a sandbox, studies its failures, and rewrites its own skills.

## Run 1 vs run N

> Filled in from `runs/` at the end.

- **Task and score:** _21 real merged bug fixes (9 held out, from repos `improve` never sees); score = 100 × mean share of attempts that pass all of the maintainers' tests._
- **Baseline (3 runs, nothing changed):** _pending (`runs/spread.md`)._
- **After the change (2+ runs):** _pending (`runs/summary.csv`)._
- **The change that did it:** _pending: link to the commit with `Agent-Session:`, and what the agent learned._
- **Real gain?** _pending: the five checks (`runs/verdict.md`)._
- **What still fails:** _pending._

## How it works

```
freeze ─► 3 baseline runs ─► spread.md ─► ROUND: improve ─► train screen ─► keep, or git revert
                                            ▲______________________________________│ (at most 5 rounds)
                 final agent ─► 2+ counted runs (all tasks) ─► verdict.md
```

- **A run** is one TrueForge session. Each attempt is one root turn with a fresh sandbox: the agent reads its skills, unpacks the project, reproduces the bug, fixes it, runs the tests, gets a review from a subagent, and writes a patch.
- **The score** comes from outside the agent. The harness downloads the patch and applies it to a clean snapshot in a pinned Docker image with no network, then runs the maintainers' own test files, which the agent never sees.
- **Improving:** the agent reads traces of its failed training attempts. Analyst subagents look for what went wrong, a skeptic checks the cause against passing attempts, and the agent writes one root cause citing failures on 2+ tasks before making one small edit to its own skills. Host guards accept or reject the edit. Nobody edits `agent/` by hand after run 1.

The rules are in [docs/protocol.md](docs/protocol.md), and the tasks and their licences in [docs/tasks.md](docs/tasks.md).

## TrueForge features

| Feature | Where to see it |
|---|---|
| Skills | `agent/skills/`, registered as git skills pinned to a commit (`syncAgent` in `scripts/lib.ts`). Each attempt checks the pinned commit |
| Sandbox | Every fix is made and tested with `exec` in a fresh sandbox; see any `runs/run-NN/session.json` |
| Subagents | A reviewer in every solve (`agent/skills/patch-review`) and analysts in `improve`; counted in `runs/run-NN/feature-usage.json` |

## Run it

You need Node.js 22.14+, Docker, git, the `gh` CLI and a model key. Use your own fork, because skills are fetched from a public GitHub repo (`GITHUB_REPO` in `scripts/lib.ts`).

```bash
npm install
docker build -t evopatch-scorer:1 evals
cp .env.example .env                     # your model, and your key
scripts/start-trueforge.sh               # keep this running, always from this folder
npm run setup
npm run smoke                            # one real turn, nothing saved
npm run run-evals                        # one counted run
npm run score -- runs/run-01             # re-score a saved run from its patches
npm run spread -- 1,2,3                  # the baseline range
npm run evolve -- --baseline 1,2,3       # rounds of improve, screen, keep or revert
npm run verdict -- 1,2,3 6,7             # the five checks
npm run compare -- 1 7                   # two runs side by side
npm run rerun -- --at <sha> --tasks <id> --k 1   # a quick re-run of any agent commit, not counted
```

`npm run curate` rebuilds the fixtures from upstream, and `npm run score -- --selftest --all` attacks the scorer.

## Licence

MIT for this repo's own code, from the starter by NERDCONF and the Stranger Builds participants. `evals/fixtures/` and `evals/tools/pylib/` stay under their own licences: see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). The harness was written with AI assistance: see [docs/prior-work.md](docs/prior-work.md).
