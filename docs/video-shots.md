# Video shots

For the 2-minute video: what to show, in what order, and where each thing is. There's no narration here. The times are a guide.

## Before recording

- Run `npm run report`, and check that the site shows the final runs.
- Take the session ids from `docs/submission-facts.md`.
- Run the live demo first and keep its terminal output. It can take up to an hour, and it refuses to start until every counted run is done.
- Keep `.env` and TrueForge's provider settings off screen: they hold the model key.
- If `runs/verdict.md` says gain NOT shown, shots 1 and 7 show that line.

## Shots

| # | Time | Show | Where |
|---|---|---|---|
| 1 | 0:00-0:12 | The result first: the verdict line, the five checks and the tiles | https://cg-5228.github.io/EvoPatch/, "Is the gain real?" |
| 2 | 0:12-0:27 | The tasks: real merged fixes, split by repo, with the held-out group on top | Same page, "Every task, every run". Then `docs/tasks.md` on GitHub |
| 3 | 0:27-0:47 | One attempt on TrueForge: it reads its skills, works in the sandbox, starts the reviewer subagent, then runs `work/tools/finish` | The TrueForge UI on this machine (port 8790), a session from a final run in `docs/submission-facts.md` |
| 4 | 0:47-1:00 | The score comes from outside the agent: the scorer, then a saved run scored again with the same result | `evals/score.ts` on GitHub. Then `npm run score -- runs/run-01`, cut to its last line |
| 5 | 1:00-1:12 | Why attempts failed, and how many were voided | Results site, "Why attempts fail": the chart, then "The reviewer and the audit" |
| 6 | 1:12-1:30 | The agent's change: root cause, cited failures, the diff, and the `Agent-Session:` line at the end of the commit | Results site, "What the agent changed", with "The change" open. Then the commit on GitHub, linked from that card |
| 7 | 1:30-1:45 | Before and after against the baseline range, then the five checks | Results site, "Score by run". Then `runs/verdict.md` on GitHub |
| 8 | 1:45-2:00 | A live bug from outside the set: the "NOT COUNTED" line, the patch, the test run, and the network commands | Terminal output of `npm run fix`, from the recording made earlier |

## Live bug candidates

All three were open on 6 Nov 2026, in repos outside the eval set, each with an unmerged fix PR. Each commit below is the default branch that day, and the buggy code was read at that commit. The agent hasn't been run on these yet, and their test suites haven't been run here. Pick one, then:

```bash
gh api repos/<owner>/<name>/issues/<number> --jq '.title + "\n\n" + .body' > .tmp/bug.md
npm run fix -- --repo <owner>/<name> --sha <commit> --bug .tmp/bug.md --tests <tests>
```

| Bug | Filed | Commit | `--tests` | Fix PRs | Notes |
|---|---|---|---|---|---|
| [parse #247](https://github.com/r1chardj0n3s/parse/issues/247): `parse("{:#x}", "0xff")` raises `format spec '#x' not recognised` | 16 Sep 2026 | `616ac26ca4077266dee2479dc51a8d19feab0ada` | `tests` | [#248](https://github.com/r1chardj0n3s/parse/pull/248) | The shortest to show: one line reproduces it. One test file needs `typing_extensions` |
| [toolz #659](https://github.com/pytoolz/toolz/issues/659): `assoc_in` and `update_in` raise `StopIteration` for an empty key path | 5 Nov 2026 | `451af60dec590a6010e2babdbf391ea8f815122f` | `toolz/tests` | [#660](https://github.com/pytoolz/toolz/pull/660) | Filed the day before this list. The report leaves open whether to raise or return, so the agent has to choose |
| [tenacity #710](https://github.com/jd/tenacity/issues/710): a zero exponential multiplier overflows into the maximum wait | 12 Sep 2026 | `aac059c906170ee7b6ce1aa086a226f3aded5c99` | `tests` | [#711](https://github.com/jd/tenacity/pull/711), [#712](https://github.com/jd/tenacity/pull/712), [#718](https://github.com/jd/tenacity/pull/718), [#770](https://github.com/jd/tenacity/pull/770) | Four competing fixes to compare with. The tests that need `trio` or `tornado` won't load unless the agent installs them |

The sandbox can reach GitHub, so an agent could read those PRs. `npm run fix` lists every command that used the network or named the repo, and shot 8 should show that list.
