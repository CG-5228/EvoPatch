# Re-scoring

Every counted run was scored again from its saved patches on 8 Nov 2026, between 20:15 and 20:50 UTC. The scorer ran in the same pinned image as the runs, `evopatch-scorer:1` (`sha256:cae1ae1ea9161c79d28130911c3673fadf3dbc29c8b328a1bb884bc6e2bce231`, the `scorer_image_id` in each run's `env.json`), with no network.

`npm run score -- runs/run-NN` applies each saved patch to a clean snapshot, runs the maintainers' tests and the audit again, and compares the new score with the run's `score.json`.

| Run | Saved | Re-scored | Held out | Train | Same as saved |
|---|---|---|---|---|---|
| 1 | 33.33 | 33.33 | 40.74 | 27.78 | yes |
| 2 | 47.62 | 47.62 | 40.74 | 52.78 | yes |
| 3 | 39.68 | 39.68 | 44.44 | 36.11 | yes |
| 4 | 84.13 | 84.13 | 92.59 | 77.78 | yes |

Held out and train match `runs/summary.csv` as well. The output, as printed:

```
== run-01 20:15:45
{"score":33.33,"tasks_passed":2,"tasks_total":21,"holdout_score":40.74,"train_score":27.78}
✓ matches score.json (33.33)
== run-04 20:25:51
{"score":84.13,"tasks_passed":14,"tasks_total":21,"holdout_score":92.59,"train_score":77.78}
✓ matches score.json (84.13)
== run-02 20:33:55
{"score":47.62,"tasks_passed":2,"tasks_total":21,"holdout_score":40.74,"train_score":52.78}
✓ matches score.json (47.62)
== run-03 20:40:04
{"score":39.68,"tasks_passed":2,"tasks_total":21,"holdout_score":44.44,"train_score":36.11}
✓ matches score.json (39.68)
```
