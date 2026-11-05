# Pilot log

Everything tried before the freeze, in order, so nothing here is hidden. Pilot runs are never counted. They used the seed skills as committed, once each per task, and they don't appear in `runs/summary.csv`.

**The rule:** the pilot may change the model tier, the settings and the concurrency, and it may replace tasks that are broken in the environment. It never selects tasks by whether they passed. The target for the baseline was 35-65, so a gain has room to show.

## 5 Nov: first real attempt

Claude Haiku 4.5 fixed `boltons-458-addlist` in 3 minutes for $0.18, reading all three skills and spawning its reviewer subagent.

## 5 Nov: model tiers

Each model ran all 21 tasks once. Train, held-out and score are percentages of tasks resolved. "Tests only" ignores the audit.

| Model | Score | Train | Held-out | Tests only | Cost | Tokens | Session |
|---|---|---|---|---|---|---|---|
| GPT-6 Luna | 95.24 | 91.67 | 100 | 95.24 | $0.16 | 3.3M | `01m6psy71rf6t2nb1ryg4ybnec` |
| Claude Haiku 4.5 | 80.95 | 83.33 | 77.78 | 80.95 | $6.95 | 25.8M | `01m6pss3v34sb1kdf1hxspxhz0` |
| Kimi K2.7 Code | 80.95 | 75 | 88.89 | 80.95 | $11.41 | 30.1M | `01m6psy7140zqh02ytk8atrgnn` |
| MiMo v2.6 Flash | 42.86 | 50 | 33.33 | 66.67 | $0.74 | 17.9M | `01m6psy6ztq7zkt94pq12n2se8` |

- **GPT-6 Luna, Haiku and Kimi are too strong:** a baseline of 81-95 leaves little room, and a held-out score at 100 can't be beaten.
- **MiMo v2.6 Flash is in the target range,** and the cheapest per attempt after Luna.
- **`gpt-oss-120b`, DeepSeek v4 Flash and GLM 5.3 Flash couldn't run at all:** every model the gateway serves through `deepinfra` fails in TrueForge (see `friction-log.md`). No attempts were scored.

## 5 Nov: what MiMo's failures were

Reading the 7 `no_patch` attempts showed that none of them was a skill problem:

- **5 were cut off by our own 30-minute turn limit** while working normally. Four pilots were running at once, and MiMo is slow, so the limit turned provider speed into score noise. **Decision:** raise the limit to 3600 s.
- **2 ended in gibberish** (mixed-language random tokens) at the model's default sampling settings. **Decision:** set temperature 0.6 in `agent/agent.json` and test it.

MiMo's 5 `audit` results are real: the agent ran `pip download more-itertools`, or looked for a global `semver` copy, despite the prompt's rule. The audit voided those attempts even though their patches passed the tests.

## 5 Nov: harness fixes from the pilot

- Running out of the iteration limit is now a real failure, not an infrastructure retry.
- Skill registration is global, so two runs at different commits can't overlap. `run-evals` caught this and stopped the Haiku pilot; it resumed at one commit.
