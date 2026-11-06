# Protocol

Written before run 1 and frozen by the tag `eval-v1`. It follows TrueFoundry's five checks: a gain counts only if all five hold, and if one fails the README and the video say the gain was not shown, even if a later run beat run 1.

## Frozen before run 1

`evals/` (tasks, fixtures, prompt, tools, scorer, audit, Docker image, `protocol.json`), `agent/agent.json`, the seed skills, TrueForge 0.182.0, and the improve prompt, bundle and guards in `scripts/improve.ts` and `scripts/guards.ts`. A later change to the harness is listed under "Changes after the freeze" below and never touches `agent/` or `evals/`.

| Setting | Value |
|---|---|
| Model | MiMo v2.6 Flash through the TrueFoundry gateway, chosen by the pilots (`docs/pilot.md`) |
| Model settings | its defaults, with thinking on. Its docs say temperature is fixed at 1.0 in thinking mode, so run-to-run spread is real |
| Attempts per task (k) | 3 |
| Concurrency | 8, with nothing else running on the machine |
| Output limit | 16,000 tokens per response |
| Turn limit | 3,600 s, and 120 iterations |

## The sequence

1. **Baseline:** runs 1-3 on the unchanged agent, then `npm run spread -- 1,2,3`.
2. **Rounds:** `npm run evolve -- --baseline 1,2,3`. Each round the agent makes one small change. Two train-only screens must both beat the bar, which is the highest baseline train score, then the last kept edit's score. Otherwise the edit is reverted with `git revert`. History is never rewritten. There are 5 rounds, fixed in advance, and none starts after `rounds_end` in `evals/protocol.json`, Saturday 7 Nov at 18:00 Dublin, so the final runs keep their time. A round that has made its edit always finishes, and a counted run refuses to start on an edit that was never screened.
3. **Final runs:** 2 or more counted runs on the final agent. Every counted run on that agent counts.
4. **Drift check:** one control run of the run 1 commit, after the final runs, in `runs/controls/`. It answers one question: did the model's service change while the agent was learning? It's never counted as a result.
5. **Verdict:** `npm run verdict -- 1,2,3 <every run on the final agent>`.

Holdout tasks run only in counted runs, never in screens, and never reach `improve`. Selection never uses holdout scores.

**Headline order:** holdout, then train (in-sample, learned with test feedback), then the blended score in `summary.csv`.

## Score

An attempt is resolved when every FAIL_TO_PASS and PASS_TO_PASS test passes and the audit has no hard hit. Task score = resolved attempts / k. A task passes when every attempt resolves. Run score = 100 × mean task score. `score.json` also reports the score without the audit, each attempt's failure class, and how many model responses were noise or cut off. Those two counts are never scored: they show whether the service moved between runs.

## Audit

Two tiers, in `evals/audit.ts`. A hard hit (fetching task content, or reading another copy of a task library) voids the attempt. Soft hits (`npm test`, `pip install pytest`) are logged and never scored. GitHub and PyPI can't be blocked on the local sandbox, so the audit, the session exports and a report-only similarity score to the upstream fix are the safeguards.

## Infrastructure failures

Provider errors, timeouts, abandoned turns and rejected requests aren't failed attempts. The attempt is retried as a new root turn, up to 2 times, and logged in `infra.json`. A run stops after 3 in a row or on an account error, and adds no row to `summary.csv`. An attempt that runs out of output (`Output truncated`) or time (`server-execution-timeout`) is a real failure. Every run is listed in `runs/registry.csv` before it starts, so aborted runs stay visible.

The line is drawn at the transport: anything the model returns is the agent's, even a response that is noise. A filter for bad responses would put a judgement call inside the scoring path, and it could retry away failures the agent should have survived. The cost is that a change in the service could look like a change in the agent, which is why noise is counted per run and step 4 above exists.

## Improve

The agent sees failed training attempts: the report, its patch, a trace of what it did, how the attempt ended, and which tests failed, with no test source and no expected values. Audit results never reach it, so it can't learn the audit. It must write a diagnosis citing failures on at least 2 tasks before it edits. Guards reject edits over 40 changed lines, over the size caps, or quoting task details. Rejected proposals are kept in `runs/rejected/`. A session that ends early counts as a rejected proposal, and each round gets 3 tries.

## People

Nobody but the agent edits `agent/instructions.md` or `agent/skills/**` after run 1. Chris reads root causes against traces and samples patches, and may veto an edit for integrity before seeing its score, with the reason logged here.

## Changes after the freeze

### 6 Nov: one failed attempt can no longer stop the others

Harness only: `scripts/run-evals.ts` and `scripts/lib.ts`. `agent/` and `evals/` didn't change, and nothing the agent sees changed. It applies from the first run started after this commit, so run 3 finishes on the old code unless it has to resume.

**What happened in run 2.** Run 2 took from 10:30 to 15:56 UTC and stopped three times, resuming by itself after each stop.

- At 10:40 and 12:21, model streams were cut in bursts: 4 ended `[Model Error] terminated`, and 3 more ended `terminated` or a gateway 500. Each burst stopped the run under the frozen rule, and the attempts in flight finished and were saved first. That worked as designed.
- At 11:50 the scorer couldn't read `evals/fixtures/boltons-452-backoff/f2p.json`. That was a bug in the runner: the exception killed the process. One finished attempt lost its score and seven were cut off, and all eight started again on resume at 12:00. Two of the old turns were still running then, so up to ten turns ran at once until 12:48, against the frozen eight.

Run 2 started 78 turns for 63 attempts: 63 scored, 7 lost to infrastructure and 8 lost to the crash. Those 8 restarts aren't in its `infra.json`, which also lists only 5 of the 8 infrastructure events in the log, because events from attempts dropped by a stop weren't saved.

**The likely cause.** This repo sits in `~/Documents`, which iCloud Drive syncs. iCloud left 20 empty duplicate folders under `evals/fixtures/` (`repo 2`, `hidden 2`) and rewrote metadata on 531 frozen entries that day, and its link to `Documents` was rewritten within a minute of the crash. The system log for that minute has expired, so this is the best explanation and not a proven one.

**Why run 2 stands.**

- No file in `evals/` changed. `git diff eval-v1 -- evals` is empty, it was checked again at every resume, and no file was modified after the freeze.
- Each task's upload was byte-identical across all 126 attempts in runs 1 and 2, by the sha256 in `session.json`.
- Run 2's two test failures are real failures of the patches, not missing files.
- A restart can only help a baseline, and a higher baseline raises the bar for every later run.

Every attempt in every counted run is scored again in the pinned image at the end, which would show any score that came out wrong.

**What changed.**

- An exception in one attempt now stops the run cleanly: the others finish and are saved, and the stop is in the registry.
- A failed scoring is tried again after 5, 30 and 120 seconds. Scoring is safe to repeat, because the turn is over and the patch is saved.
- Every infrastructure event reaches `infra.json` as it happens, including events from attempts that are dropped.
- `duration_s` now covers a whole run across resumes. Run 2's row says 9,883 s, which is only its last stretch. Rows already in `summary.csv` are left as they are.

### 6 Nov: run 3 stopped once and finished on the fixed harness

This note changes nothing: it records what happened. `agent_tree` and `evals_tree` are the same in all three baseline runs' `score.json` and `env.json`.

Run 3 started at 15:56 UTC on the old code. At 17:38 five model streams were cut in a row, so it stopped under the frozen rule with 29 attempts saved. It resumed at 17:49 at commit `1888a73`, which includes the change above, and finished at 20:20. That was the first live use of the change. After the resume there were no scoring retries and no crashes, and three more stream cuts were retried and logged as they happened.

Two records stay incomplete, and rows already written are left as they are.

- **`duration_s`:** run 3's row says 9,044 s, which starts at the 17:49 resume. The run took 4 h 24 min from first start to finish. Run 2's row has the same gap: 9,883 s for 5 h 26 min. `runs/registry.csv` has the real times.
- **`infra.json`:** it misses events the old code lost when a stop dropped their attempts. Run 3's lists 6 of the 9 events in the run log, and run 2's lists 5 of 8. The missing ones are `humanize-359-metric-2`, `node-semver-757-subset-1` and `mit-1275-numeric-range-2` in run 3, and `boltons-452-backoff-1`, `boltons-458-addlist-1` and `node-semver-757-subset-1` in run 2. All were model errors and each attempt ran again, so none of them changes a score.
