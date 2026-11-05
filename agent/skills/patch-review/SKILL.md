---
name: patch-review
description: The independent review to run after the tests pass and before you finish. Use it on every task.
---

# Patch review

After the tests pass, before `work/tools/finish`, get a second opinion from someone who didn't write the fix.

Call `create_sub_agent` with the name `reviewer`. It sees only what you write, so give it this brief, filled in:

> You review a bug fix. Don't edit any files. The project is in `work/repo`. The bug report: <paste the report>. The fix: <say what changed, in which files>. Read the changed code. Reply with up to 3 concrete problems, each with a case that would fail. If you find none, say so.

Then decide for yourself. Fix what is real, run the tests again, and finish.
