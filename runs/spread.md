# Baseline spread

Runs: run-01, run-02, run-03 (3 runs, same agent, nothing changed between them).

| Run | Score | Held-out |
|---|---|---|
| run-01 | 33.33 | 40.74 |
| run-02 | 47.62 | 40.74 |
| run-03 | 39.68 | 44.44 |

- Score: min 33.33, max 47.62, mean 40.21, median 39.68
- Held-out: min 40.74, max 44.44, mean 41.97, median 40.74

The bar: a change counts only if every run after it scores above 47.62, and held-out above 44.44.
