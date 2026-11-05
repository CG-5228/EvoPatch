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
