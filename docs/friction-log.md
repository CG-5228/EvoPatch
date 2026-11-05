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
| 5 Nov | Read `exec` results for a turn that wrote a long log | Stored `tool.response` events hold only the truncated preview, so full output can't be recovered afterwards | The full result, or a pointer to it | Harnesses must have the agent write logs to files and fetch them |
| 5 Nov | Sent a 429, 500, 401 and 402 through the mock provider | All end the turn as `error` with `Request failed (<status>)` after one try, and the agent's work is lost | A retry on 429 and 5xx, or a machine-readable error class | Every harness has to parse the message to tell a provider failure from an agent failure |
| 5 Nov | Ran an agent on gateway models served by `deepinfra` (`gpt-oss-120b`, `deepseek-v4-*`, `glm-5.3*`, `kimi-k3`, `minimax-m3`, `qwen3.8-max`, `nemotron-3-ultra`, `mimo-v2.6-pro`) | Every turn fails on the first model call: `[Model Error] JSON parsing failed`. Raw bytes show the gateway separates stream events with one `\n`, so SSE parsers read the whole reply as a single event. Models served by Anthropic, OpenAI, xAI and OpenRouter use `\n\n` and work. `x-tfy-forward-pings` makes no difference | Each `data:` event ended by a blank line | 11 of the 20 chat models on a hackathon key can't be used from TrueForge at all |
| 5 Nov | Read `totalCacheReadTokens` on a Haiku turn through the gateway | It stays 0 on a 480k-input turn, yet the billed cost is about a third of list price, so caching seems to work and go unreported (inferred from price, not confirmed) | Cached tokens in the turn metrics | Cost can't be explained from the metrics |

## What worked

| Date | What we did | Result |
|---|---|---|
| 5 Nov | Git skill pinned to a full pushed SHA in the local sandbox | Installs in seconds; `skills/.tfy-skill-downloader-state.json` records the ref. The starter marks this `TODO(verify)` |
| 5 Nov | File part upload, then `downloadSandboxFile` | Works; `createTurn` took 7-12 s including sandbox setup |
| 5 Nov | Four root turns at once in one session | All finished, each in its own sandbox, 21 s in total |
| 5 Nov | Non-streaming `createTurn` plus `getTurn` polling | Reliable for long unattended turns, with the turn id returned at once. A better default for harnesses than the SSE stream, which has no keepalive |
| 5 Nov | Heredocs, here-strings and `python3 - <<'PY'` under bash 3.2 | All work, from the root and from subfolders |
