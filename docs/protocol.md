# Protocol

Written before run 1 and frozen by the tag `eval-v1`. It follows TrueFoundry's five checks: a gain counts only if all five hold, and if one fails the README and the video say the gain was not shown, even if a later run beat run 1.

## Frozen before run 1

`evals/` (tasks, fixtures, prompt, tools, scorer, audit, Docker image, `protocol.json`), `agent/agent.json`, the seed skills, TrueForge 0.182.0, and the improve prompt, bundle and guards in `scripts/improve.ts` and `scripts/guards.ts`. A later change to the harness is listed under "Changes after the freeze" below and never touches `agent/` or `evals/`.

| Setting | Value |
|---|---|
| Model | set at the freeze, recorded in `agent/agent.json` |
| Attempts per task (k) | `evals/protocol.json` |
| Concurrency | `evals/protocol.json` |
| Temperature | the model's default, so run-to-run spread is real |

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

None yet.
