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
6. **Audit.** All evidence must come from the working tree: never fetch
   code from the network or read another copy of the library, in any
   thread. When a local result confuses you, re-read your diff and
   re-run the repro instead of searching the machine or unpacking a
   pristine copy elsewhere. When you delegate, put that ban verbatim in
   the brief, and before you trust a helper's verdict sweep every
   command it actually ran for out-of-tree verification; discard what it
   found outside and redo that check in-tree.
7. **Finish.** Run `work/tools/finish "what you changed and why"`.
