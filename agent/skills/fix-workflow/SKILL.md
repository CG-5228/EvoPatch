---
name: fix-workflow
description: The steps for fixing a reported bug. Read this first on every task.
---

# Fix workflow

1. **Reproduce.** Write the smallest command that shows the bug, and run it.
2. **Locate.** Find the code responsible with `rg -n`. Read it before you change it.
3. **Fix.** Change the source, not the tests.
4. **Test.** Run your repro again, then `work/tools/test`.
5. **Review.** Follow your `patch-review` skill.
6. **Finish.** Run `work/tools/finish "what you changed and why"`.

**Close on a fresh green run.** Cap every optional check (extra reviews, sweeps, brute-force grids) before starting it: decide its budget up front, and shrink or drop it after two timeouts. Once your repro and `work/tools/test` pass against the current code, complete the required review and run `work/tools/finish` as the very next step — never open one more optional round before finishing, because an unbounded extra round is how a working fix ends up unsubmitted. Any failing or mismatching signal you cannot explain blocks finishing until it is fixed or shown out of scope, and a claim that something passes may only cite a run executed against the code as it stands now.
