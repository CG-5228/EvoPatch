# EvoPatch

<!-- Chris: your intro goes here, in your own words: who it's for and what it does. -->

EvoPatch is a bug-fixing agent on [TrueForge](https://trueforge.dev). It attempts real bug fixes, tests its own patches in a sandbox, studies its failures, and rewrites its own skills.

## Run 1 vs run N

> From `runs/`. Run 5 stopped when the model credits ran out: see "After the change".

- **Task and score:** 21 real merged bug fixes from 5 open-source repos, 3 attempts each. 9 are held out, from repos `improve` never sees. Score = 100 × the mean share of attempts that pass all of the maintainers' tests with a clean audit (no fetching the project's code or its fix).
- **Baseline (3 runs, nothing changed):** 33.33, 47.62 and 39.68; held out 40.74, 40.74 and 44.44. So every run after the change must score above 47.62, and above 44.44 held out ([`runs/spread.md`](runs/spread.md)).
- **After the change (2+ runs):** one counted run has finished on the final agent. Run 4 scored **84.13**, held out **92.59**, train 77.78, and 14 of 21 tasks passed every attempt, against 2 in each baseline run ([`runs/run-04`](runs/run-04)). Run 5 stopped after 36 of 63 attempts when the model credits ran out: the gateway answered `Budget exceeded` at 20:10 UTC on 8 Nov ([`docs/protocol.md`](docs/protocol.md)). So it isn't counted and isn't in `runs/summary.csv`. Of its 36 saved attempts, 28 were resolved, including all 13 held-out ones. Those are the attempts that finished first, so they aren't a fair sample ([`runs/run-05-incomplete`](runs/run-05-incomplete)).
- **The change that did it:** two edits the agent wrote to its own skills, both kept by the screens. Round 3, [`5eb33ef`](https://github.com/CG-5228/EvoPatch/commit/5eb33ef385c0d8a4ff70069b1ff893d7b75de66a) (+6 −1), adds an "Audit" step to `fix-workflow`: all evidence comes from the working tree, never the network or another copy of the library, in any thread; briefs to helpers say so, and a helper's commands are checked before its verdict is trusted. Round 4, [`6112307`](https://github.com/CG-5228/EvoPatch/commit/611230716342459a9e7fddfe0efcfc6fd53e5cab) (+9 −4), adds "re-read your diff and re-run the repro" when a local result is confusing, puts the ban word for word into helper briefs, and adds it to the reviewer's brief in `patch-review`. Each names one root cause and cites failed training attempts from the baseline runs and earlier screens: 4 for [round 3](runs/run-03/diagnosis-01m6sw0b9snm6ay62pmfkpj3dg.json) and 5 for [round 4](runs/run-03/diagnosis-01m6tc9kn7kpf2tv14dq2xpmh1.json). The training screens went from a baseline max of 52.78 to 77.78 and 88.89 after round 3, then 83.33 and 86.11 after round 4. Rounds 1 and 2 were reverted because their screens (47.22, 41.67) didn't beat 52.78.
- **Real gain?** **Gain not shown**, by the rule set before run 1. TrueFoundry's check 5 needs 2 or more runs after the change, and only one has finished ([`runs/verdict.md`](runs/verdict.md)). The other checks:
  - The baseline spread is recorded: 33.33 to 47.62.
  - The scorer and tasks are unchanged since run 1.
  - Held out, run 4 scored 92.59 against the baseline's best of 44.44.
  - The diff is 12 lines in two skills, with no task ids, file names or buggy lines quoted: `git diff 1888a73 16311af -- agent/`.

  Re-scored in the pinned image, runs 1 to 4 give their saved scores exactly ([`runs/rescore.md`](runs/rescore.md)).

  Most of the gain is fewer voided attempts: 31 in run 1, 3 in run 4. Reviewer briefs that tell the reviewer to stay in the working tree went from 2 of 246 in the baseline runs to 84 of 84. The tests-only score moved less: the maintainers' tests pass, with the audit ignored, in 79.37 for run 1, at most 84.13 for the baseline, and 88.89 for run 4.

  The drift check didn't run: it re-runs run 1's agent late, to catch the model changing, and needs credits.
- **What still fails:** in run 4, 10 of 63 attempts failed:
  - 4 ended without a patch: 3 hit the 16k output cap and 1 the 60-minute limit.
  - 3 patches didn't make the failing tests pass.
  - 3 were voided by the audit.

  `node-semver-757-subset`, `boltons-452-backoff` and `node-semver-606-diff` passed 1 attempt of 3, and four more tasks passed 2 of 3 ([`docs/results.md`](docs/results.md)).

## How it works

```
freeze ─► 3 baseline runs ─► spread.md ─► ROUND: improve ─► train screen ─► keep, or git revert
                                            ▲______________________________________│ (5 rounds)
                 final agent ─► 2+ counted runs (all tasks) ─► drift check ─► verdict.md
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
caffeinate -dims scripts/run-protocol.sh # or all of the above, unattended and resumable
npm run verdict -- 1,2,3 6,7             # the five checks
npm run compare -- 1 7                   # two runs side by side
npm run rerun -- --at <sha> --tasks <id> --k 1   # a quick re-run of any agent commit, not counted
npm run fix -- --repo <owner/name> --sha <commit> --bug report.md   # a live bug from outside the set, after every counted run, not counted
```

`npm run curate` rebuilds the fixtures from upstream, and `npm run score -- --selftest --all` attacks the scorer.

## Licence

MIT for this repo's own code, from the starter by NERDCONF and the Stranger Builds participants. `evals/fixtures/` and `evals/tools/pylib/` stay under their own licences: see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). The harness was written with AI assistance: see [docs/prior-work.md](docs/prior-work.md).
