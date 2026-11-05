---
name: sandbox-recipes
description: Commands that work in this sandbox for reading, editing and testing code. Use them when you edit files or run tests.
---

# Sandbox recipes

Read part of a file:

    cd work/repo && sed -n '120,180p' path/to/file

Replace exact text in a file:

    python3 - <<'PY'
    from pathlib import Path
    p = Path("work/repo/path/to/file")
    s = p.read_text()
    assert s.count("old text") == 1
    p.write_text(s.replace("old text", "new text"))
    PY

Run one test file, or one test:

    work/tools/test tests/test_something.py
    work/tools/test tests/test_something.py -k test_name

Keep long output in a file:

    work/tools/test > out/test.log 2>&1; tail -n 30 out/test.log
