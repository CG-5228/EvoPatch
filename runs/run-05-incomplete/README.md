# Run 5, incomplete: not counted

Run 5 was the second counted run on the final agent (agent tree `b077f60`, the same as run 4's). It started at 18:41 UTC on 8 Nov in TrueForge session `01m6y7ets1avfm8r9g76dkma98`. It stopped at 20:10 UTC, after 36 of its 63 attempts, when the gateway refused every model call with `Budget exceeded` (see `docs/protocol.md`, "8 Nov: run 5 stopped when the model credits ran out").

A run counts only with every task at k = 3, so these attempts aren't in `runs/summary.csv` and don't enter the verdict. They're here so the numbers in the README can be checked:

- 36 attempts saved, 28 resolved.
- Held out: 13 of 13 resolved.
- Failure classes: resolved 28, f2p_failed 3, audit 4, no_patch 1.

These are the attempts that finished first, not a random sample, so they don't estimate the run's score.

`attempts.json` holds each attempt's score record as the harness saved it: tests, audit, failure class, commands and turn id. `infra.jsonl` holds the one infrastructure retry, the start-of-run connection reset. The turn traces aren't copied. The full saved state stays on the machine that ran it, so the run can resume if the credits come back.
