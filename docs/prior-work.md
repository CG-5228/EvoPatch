# What existed before and what we used

- **Starter:** [nerdconf/trueforge-starter](https://github.com/nerdconf/trueforge-starter) at `6478cd1`, the head of its PR #2 (MIT). `spread`, `verdict` and `realgain` come from there, adapted to this task format.
- **Runtime:** TrueForge and `@truefoundry/trueforge-sdk` 0.182.0 (MIT), with `@anthropic-ai/sandbox-runtime` underneath.
- **Tools:** Docker images `python:3.15.2-slim` and `node:24.9.0-slim`, pytest and its dependencies (`THIRD_PARTY_NOTICES.md`), tap 16 (ISC), undici (MIT).
- **Tasks:** code and tests from five open-source projects, each under its own licence: see `docs/tasks.md`.
- **AI:** the harness, tasks and docs were written with Claude Code. After run 1, only the TrueForge agent changed `agent/`: every such commit ends with `Agent-Session:`.
- **Discarded:** an exploratory prototype made with Codex during the event. None of it was reused.
