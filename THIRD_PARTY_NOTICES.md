# Third-party notices

The root `LICENSE` (MIT) covers this repo's own code. It doesn't cover the following, which stay under their own terms:

- `evals/fixtures/**`: snapshots, tests and patches from upstream projects. Each `repo/` keeps its upstream licence file.

  | Project | Licence |
  |---|---|
  | [npm/node-semver](https://github.com/npm/node-semver) | ISC |
  | [mahmoud/boltons](https://github.com/mahmoud/boltons) | BSD-3-Clause style |
  | [python-humanize/humanize](https://github.com/python-humanize/humanize) | MIT |
  | [more-itertools/more-itertools](https://github.com/more-itertools/more-itertools) | MIT |
  | [python-semver/python-semver](https://github.com/python-semver/python-semver) | BSD-3-Clause |

- `evals/tools/pylib/**`: unpacked wheels of pytest (MIT), pluggy (MIT), iniconfig (MIT), packaging (Apache-2.0 or BSD-2-Clause) and Pygments (BSD-2-Clause). Each keeps its licence in its `.dist-info` folder.

Bug reports in `evals/tasks/` are our own wording. The originals are linked from `docs/tasks.md`.
