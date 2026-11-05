# The tasks

21 real bug fixes, merged by each project's maintainers. Each task is the project at the fix's parent commit, a bug report in our own words, and the maintainers' test files at the fix commit, unmodified. Holdout repos never appear in `improve`.

Bug reports are paraphrased: the originals belong to their authors, linked here. `evals/issue-audit.json` holds each draft written before the tests were read, and each statement added afterwards.

| Task | Split | Repo | Licence | Merged | Bug class | Report by | Links |
|---|---|---|---|---|---|---|---|
| `boltons-348-lru` | train | mahmoud/boltons | BSD-3-Clause | 2023-10-30 | sibling code paths | nicoddemus | [PR](https://github.com/mahmoud/boltons/pull/349) [issue](https://github.com/mahmoud/boltons/issues/348) |
| `boltons-404-omd-eq` | train | mahmoud/boltons | BSD-3-Clause | 2026-06-17 | duplicated code | DucMinhNe | [PR](https://github.com/mahmoud/boltons/pull/404) |
| `boltons-423-indexedset` | train | mahmoud/boltons | BSD-3-Clause | 2026-07-17 | index boundaries | chuenchen309 | [PR](https://github.com/mahmoud/boltons/pull/424) [issue](https://github.com/mahmoud/boltons/issues/423) |
| `boltons-452-backoff` | train | mahmoud/boltons | BSD-3-Clause | 2026-07-18 | input edge cases | kmeasabingias-a11y | [PR](https://github.com/mahmoud/boltons/pull/428) [issue](https://github.com/mahmoud/boltons/issues/452) |
| `boltons-458-addlist` | train | mahmoud/boltons | BSD-3-Clause | 2026-09-07 | one-shot iterables | youdie006 | [PR](https://github.com/mahmoud/boltons/pull/458) |
| `humanize-329-naturalsize` | train | python-humanize/humanize | MIT | 2026-06-30 | rounding carry | patchwright | [PR](https://github.com/python-humanize/humanize/pull/329) |
| `humanize-359-metric` | train | python-humanize/humanize | MIT | 2026-09-16 | rounding carry | vidigoat | [PR](https://github.com/python-humanize/humanize/pull/359) |
| `mit-1250-value-chain` | holdout | more-itertools/more-itertools | MIT | 2026-09-03 | exception scope | onk3sh | [PR](https://github.com/more-itertools/more-itertools/pull/1251) [issue](https://github.com/more-itertools/more-itertools/issues/1250) |
| `mit-1275-numeric-range` | holdout | more-itertools/more-itertools | MIT | 2026-09-17 | numeric edge cases | emme1t | [PR](https://github.com/more-itertools/more-itertools/pull/1276) [issue](https://github.com/more-itertools/more-itertools/issues/1275) |
| `mit-1277-zip-broadcast` | holdout | more-itertools/more-itertools | MIT | 2026-09-14 | one-shot iterables | vitalivo | [PR](https://github.com/more-itertools/more-itertools/pull/1278) [issue](https://github.com/more-itertools/more-itertools/issues/1277) |
| `mit-1284-bucket` | holdout | more-itertools/more-itertools | MIT | 2026-09-17 | lookups must not mutate | onk3sh | [PR](https://github.com/more-itertools/more-itertools/pull/1285) [issue](https://github.com/more-itertools/more-itertools/issues/1284) |
| `mit-1308-validator` | holdout | more-itertools/more-itertools | MIT | 2026-10-07 | falsy vs None | widechaos | [PR](https://github.com/more-itertools/more-itertools/pull/1309) [issue](https://github.com/more-itertools/more-itertools/issues/1308) |
| `node-semver-226-dotted-inc` | train | npm/node-semver | ISC | 2026-06-04 | prerelease ordering | stephenlacy | [PR](https://github.com/npm/node-semver/pull/870) [issue](https://github.com/npm/node-semver/issues/226) |
| `node-semver-512-tilde` | train | npm/node-semver | ISC | 2026-06-19 | sibling code paths | WalkerCodeRanger | [PR](https://github.com/npm/node-semver/pull/878) [issue](https://github.com/npm/node-semver/issues/512) |
| `node-semver-606-diff` | train | npm/node-semver | ISC | 2025-01-29 | prerelease ordering | erikjalevik | [PR](https://github.com/npm/node-semver/pull/755) [issue](https://github.com/npm/node-semver/issues/606) |
| `node-semver-757-subset` | train | npm/node-semver | ISC | 2026-05-21 | prerelease ordering | rrosenshain-sc | [PR](https://github.com/npm/node-semver/pull/867) [issue](https://github.com/npm/node-semver/issues/757) |
| `node-semver-775-coerce` | train | npm/node-semver | ISC | 2025-05-08 | parsing edge cases | nhedger | [PR](https://github.com/npm/node-semver/pull/781) [issue](https://github.com/npm/node-semver/issues/775) |
| `pysemver-484-rc` | holdout | python-semver/python-semver | BSD-3-Clause | 2026-09-24 | prerelease ordering | jzaia18 | [PR](https://github.com/python-semver/python-semver/pull/485) [issue](https://github.com/python-semver/python-semver/issues/484) |
| `pysemver-487-long` | holdout | python-semver/python-semver | BSD-3-Clause | 2026-10-01 | unbounded input | fitness-trener | [PR](https://github.com/python-semver/python-semver/pull/488) [issue](https://github.com/python-semver/python-semver/issues/487) |
| `pysemver-497-token` | holdout | python-semver/python-semver | BSD-3-Clause | 2026-10-19 | prerelease ordering | Debasishhh | [PR](https://github.com/python-semver/python-semver/pull/498) [issue](https://github.com/python-semver/python-semver/issues/497) |
| `pysemver-499-rollover` | holdout | python-semver/python-semver | BSD-3-Clause | 2026-10-21 | prerelease ordering | pabszero | [PR](https://github.com/python-semver/python-semver/pull/500) [issue](https://github.com/python-semver/python-semver/issues/499) |

## Notes

- `pysemver-487-long`: one maintainer test pins eager errors on invalid digits, which a sound lazy fix would fail. The report's request for the same results and errors covers it, so the test stays, and we disclose it here.
- `more-itertools` tasks leave out `TestConcurrentTee`: it deadlocks in about a third of runs on Python 3.15 with or without the fix (`evals/profiles.json`).
- `boltons-348-lru` runs with `--noconftest`: its 2023 `conftest.py` uses a hook argument pytest 9 removed.
- humanize tasks use `tests/test_number.py` and `tests/test_filesize.py`, and get a generated `_version.py`, which isn't in git.
- Fixed copies of node-semver exist in this machine's global npm folder, which the sandbox can read. node-semver is a training repo, and the audit voids any attempt that reads them.
