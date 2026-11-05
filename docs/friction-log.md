# TrueForge friction log

Raw entries, added as things happen. Each one was observed on this machine, not only read in source. Server and SDK 0.182.0, macOS 26 (arm64), standalone npx.

| Date | What we did | What happened | What we expected | Impact |
|---|---|---|---|---|
| 5 Nov | Read `docs/sandbox.mdx`, then started the server | Boot log: `Local sandbox fallback is available`, and `capabilities.sandbox.enabled` is true | Docs say Daytona is the only provider and list a local sandbox as roadmap | The local sandbox works but is undocumented |
| 5 Nov | Ran `sleep 65; echo finished` through `exec` | Tool result is `exitCode: 1`, `result: ""`, with no timeout text | A message saying the 60 s limit killed the command | A model can't tell a timeout from a failure |
| 5 Nov | Ran `mktemp` and `patch --version` in the sandbox | Both fail with `Operation not permitted`: `TMPDIR` is `/tmp/claude`, which the sandbox blocks, while `TEMP` points inside it. Node's `os.tmpdir()` returns `/tmp/claude` | `TMPDIR` to be writable | Ordinary tools fail until `TMPDIR` is reset |
| 5 Nov | Started an upload turn with a skill whose `path` doesn't exist | `createTurn` returns HTTP 500 `Internal server error`, and no turn is created. The reason appears only in the server log | A 4xx naming the skill | Hard to diagnose from a client |
| 5 Nov | Read the `exec` tool text, then ran `command -v genson helm` style checks | Tool text advertises Python 3.13, genson and helm; the sandbox has the host's Python 3.15.2 and no `python` or `pip` after `cd` | Tool text to match the local sandbox | The model is told things that aren't true here |
| 5 Nov | Bound a socket on 127.0.0.1 from Python | `PermissionError: Operation not permitted` | Documented limit | Tests that open local ports can't run in the sandbox |
| 5 Nov | Started the server with `PORT=8791` | It listens on `[::1]` only, so a `127.0.0.1` client gets connection refused while `localhost` works | Both to work | Readiness checks on IPv4 fail |

## What worked

| Date | What we did | Result |
|---|---|---|
| 5 Nov | Git skill pinned to a full pushed SHA in the local sandbox | Installs in seconds; `skills/.tfy-skill-downloader-state.json` records the ref. The starter marks this `TODO(verify)` |
| 5 Nov | File part upload, then `downloadSandboxFile` | Works; `createTurn` took 7-12 s including sandbox setup |
| 5 Nov | Four root turns at once in one session | All finished, each in its own sandbox, 21 s in total |
| 5 Nov | Heredocs, here-strings and `python3 - <<'PY'` under bash 3.2 | All work, from the root and from subfolders |
