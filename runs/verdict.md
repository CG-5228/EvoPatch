# Verdict

Baseline: run-01, run-02, run-03. Post-edit: run-04.

| Check | Result | Detail |
|---|---|---|
| 1 Baseline spread | PASS | 3 runs: min 33.33, max 47.62, mean 40.21, median 39.68 |
| 2 Scorer and tasks unchanged | PASS | no changes to evals/ since run-01 |
| 3 Held-out gain | PASS | post-edit held-out 92.59 all beat the baseline max 44.44 |
| 4 The diff | MANUAL | 12 line(s) changed in agent/skills/fix-workflow/SKILL.md, agent/skills/patch-review/SKILL.md, no task ids, file names or buggy lines quoted. Read it yourself (small? a general rule?): git diff 1888a73 16311af -- agent/ |
| 5 Beats the spread, repeats | FAIL | 1 post-edit run; run at least 2 so one lucky run can't fool you |

Verdict: gain NOT shown (Beats the spread, repeats)

If any check fails, report the gain as not shown. Method: TrueFoundry's five checks (Anant Agarwal, 4 Nov 2026).
