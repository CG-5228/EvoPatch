#!/usr/bin/env python3
"""Runs inside the pinned scorer image: apply one patch to a clean snapshot, overlay the maintainers' tests, run them.

Input: /job/job.json with {"profile": {...}, "patch": "patches/x.diff" or null, "overlay_hidden": bool}. Fixture at /fixture.
Output: /job/result.json with per-test outcomes. Same input gives the same output: this file makes no pass/fail decision.
"""
import json
import os
import re
import shutil
import subprocess
import sys
import xml.etree.ElementTree as ET
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

TIME_LIMIT_S = 120
WORK = Path("/tmp/work")


def sections(patch: bytes):
    """Split a unified diff (git or plain `diff -ruN`) into per-file chunks: (path, bytes), path None when unknown."""
    out, cur = [], []

    def flush():
        if not cur:
            return
        path = None
        for line in cur:
            if line.startswith(b"+++ "):
                raw = line[4:].split(b"\t")[0].strip().decode("utf-8", "replace")
                if raw == "/dev/null":
                    continue
                path = raw.split("/", 1)[1] if "/" in raw else raw
                break
        if path is None:
            for line in cur:
                if line.startswith(b"--- "):
                    raw = line[4:].split(b"\t")[0].strip().decode("utf-8", "replace")
                    path = raw.split("/", 1)[1] if "/" in raw else raw
                    break
        out.append((path, b"".join(cur)))
        cur.clear()

    for line in patch.splitlines(keepends=True):
        if line.startswith(b"diff ") or line.startswith(b"Binary files "):
            flush()
        cur.append(line)
    flush()
    return out


def allowed(path, source_paths):
    return path is not None and any(path == p or (p.endswith("/") and path.startswith(p)) for p in source_paths)


def apply_patch(patch_file: Path, source_paths):
    """Apply only the chunks under source_paths. Everything else is dropped and reported."""
    kept, dropped = [], []
    for path, chunk in sections(patch_file.read_bytes()):
        if b"\n@@ " not in b"\n" + chunk:
            dropped.append(path or "(no path)")
        elif allowed(path, source_paths):
            kept.append(chunk)
        else:
            dropped.append(path or "(no path)")
    if not kept:
        return {"applied": True, "kept": 0, "dropped": dropped}
    merged = Path("/tmp/kept.diff")
    merged.write_bytes(b"".join(kept))
    res = subprocess.run(["git", "apply", "-p1", "--whitespace=nowarn", str(merged)], cwd=WORK, capture_output=True, text=True)
    return {"applied": res.returncode == 0, "kept": len(kept), "dropped": dropped, "apply_error": res.stderr[-800:]}


def overlay_hidden(profile):
    for test_path in profile["test_paths"]:
        target = WORK / test_path
        if target.is_symlink() or target.is_file():
            target.unlink()
        elif target.exists():
            shutil.rmtree(target)
        source = Path("/fixture/hidden") / test_path
        if source.exists():
            shutil.copytree(source, target, symlinks=True)


def run_pytest(profile):
    report = Path("/tmp/junit.xml")
    env = {**os.environ, "PYTHONPATH": profile.get("pythonpath", ".")}
    cmd = [sys.executable, "-m", "pytest", "-q", "-p", "no:cacheprovider", "--continue-on-collection-errors",
           f"--junitxml={report}", "-o", "junit_family=xunit2", *profile.get("pytest_args", []), *profile.get("targets", [])]
    try:
        proc = subprocess.run(cmd, cwd=WORK, env=env, capture_output=True, text=True, timeout=TIME_LIMIT_S)
    except subprocess.TimeoutExpired:
        return {"timed_out": True, "tests": {}, "failures": {}, "rc": None, "tail": ""}
    tests, failures, seen = {}, {}, {}
    if report.exists():
        for case in ET.parse(report).getroot().iter("testcase"):
            base = f"{case.get('classname', '')}::{case.get('name', '')}"
            seen[base] = seen.get(base, 0) + 1
            test_id = base if seen[base] == 1 else f"{base}#{seen[base]}"
            bad = next((c for c in case if c.tag in ("failure", "error")), None)
            skipped = next((c for c in case if c.tag == "skipped"), None)
            tests[test_id] = "fail" if bad is not None else "skip" if skipped is not None else "pass"
            if bad is not None:
                failures[test_id] = {"kind": bad.tag, "message": (bad.get("message") or "")[:400]}
    return {"timed_out": False, "tests": tests, "failures": failures, "rc": proc.returncode, "tail": proc.stdout[-1500:] + proc.stderr[-500:]}


TAP_LINE = re.compile(r"^(not )?ok \d+(?: - (.*?))?(?: # (.*))?$")


def parse_tap(file_id, text):
    tests, failures, seen, stack, in_yaml = {}, {}, {}, [], None
    for raw in text.splitlines():
        stripped = raw.lstrip(" ")
        depth = (len(raw) - len(stripped)) // 4
        if in_yaml is not None:
            if stripped == "..." and len(raw) - len(stripped) == in_yaml:
                in_yaml = None
            continue
        if stripped == "---":
            in_yaml = len(raw) - len(stripped)
            continue
        if stripped.startswith("# Subtest:"):
            del stack[depth:]
            stack.append(stripped[len("# Subtest:"):].strip())
            continue
        match = TAP_LINE.match(stripped)
        if not match:
            continue
        name = (match.group(2) or "").strip()
        directive = (match.group(3) or "").lower()
        base = "::".join([file_id, *stack[:depth], name])
        seen[base] = seen.get(base, 0) + 1
        test_id = base if seen[base] == 1 else f"{base}#{seen[base]}"
        if directive.startswith(("skip", "todo")):
            tests[test_id] = "skip"
        elif match.group(1):
            tests[test_id] = "fail"
            failures[test_id] = {"kind": "failure", "message": ""}
        else:
            tests[test_id] = "pass"
    return tests, failures


def run_node(profile, node_path):
    env = {**os.environ, **({"NODE_PATH": node_path} if node_path else {})}
    excluded = tuple(profile.get("test_exclude", []))
    files = sorted(
        str(p.relative_to(WORK))
        for root in profile["test_paths"]
        for p in (WORK / root).rglob("*.js")
        if not str(p.relative_to(WORK)).startswith(excluded)
    )

    def one(rel):
        try:
            proc = subprocess.run(["node", rel], cwd=WORK, env=env, capture_output=True, text=True, timeout=TIME_LIMIT_S)
        except subprocess.TimeoutExpired:
            return rel, {}, {f"{rel}::(file)": {"kind": "timeout", "message": ""}}, None
        return (rel, *parse_tap(rel, proc.stdout), proc.returncode)

    tests, failures = {}, {}
    with ThreadPoolExecutor(max_workers=4) as pool:
        for rel, file_tests, file_failures, rc in pool.map(one, files):
            tests.update(file_tests)
            failures.update(file_failures)
            tests[f"{rel}::(file)"] = "pass" if rc == 0 else "fail"
    return {"timed_out": False, "tests": tests, "failures": failures, "rc": 0, "tail": ""}


def main():
    job = json.loads(Path("/job/job.json").read_text())
    profile = job["profile"]
    shutil.copytree("/fixture/repo", WORK, symlinks=True)
    result = {"applied": True, "kept": 0, "dropped": []}
    if job.get("patch"):
        result.update(apply_patch(Path("/job") / job["patch"], profile["source_paths"]))
    if not result["applied"]:
        result.update({"timed_out": False, "tests": {}, "failures": {}, "rc": None, "tail": ""})
    else:
        if job.get("overlay_hidden", True):
            overlay_hidden(profile)
        result.update(run_node(profile, job.get("node_path")) if profile["language"] == "js" else run_pytest(profile))
    Path("/job/result.json").write_text(json.dumps(result, indent=1, sort_keys=True))


if __name__ == "__main__":
    main()
