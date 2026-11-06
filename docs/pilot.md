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

## 6 Nov: second MiMo pilot

All 21 tasks once more, with the turn limit at 3600 s, at concurrency 6. Session `01m6q21nxvh064wa404gh54gf8`.

| Score | Train | Held-out | Tests only | Cost | Tokens | Time |
|---|---|---|---|---|---|---|
| 47.62 | 50 | 44.44 | 76.19 | $0.90 | 20.0M | 87 min |

10 attempts resolved, 6 hit the audit, 5 sent no patch. None failed the tests: in both MiMo pilots, every patch that reached the scorer passed. The 5 attempts with no patch ended in two different ways, and in some of them the fix was already in the working tree when the turn died:

- **3 ended in noise.** One model response was random tokens in mixed scripts from its first token, so the turn stopped. `mit-1275-numeric-range` had just passed all 757 tests.
- **2 ended in rumination.** One response was 48-54k characters of honest reasoning, until the 16,000-token output limit ended the whole turn.

**Noise is specific to this model.** It hit 9 of 1,563 MiMo calls across both pilots, and 0 of 3,548 calls on the other three models. Each one came back as HTTP 200, usually with `finish_reason: stop`. Context size doesn't explain it: the smallest case was about 26k characters.

**The temperature change did nothing, so it's gone.** The second pilot set temperature 0.6 to stop the noise, and the noise rate didn't change. Xiaomi's docs then explained why: in thinking mode, `mimo-v2.6-flash` ignores `temperature` and `top_p`, which are "forcibly set" to 1.0 and 0.95. TrueForge and the gateway both accept the value silently. Both pilots almost certainly sampled the same way, so the difference in cut-off responses between them (1 and 6) is not a temperature effect. **Decision:** remove the setting, which also keeps this pilot's departure from the protocol out of the frozen config.

## 6 Nov: MiMo's thinking mode is out of spec on TrueForge

Xiaomi's docs say that with thinking on, which is this model's default, assistant messages with tool calls "must completely pass back the `reasoning_content` field", or "the model's context will be incomplete, which may result in decreased instruction following and increased hallucinations". TrueForge removes that field before every model call (`toContextAssistantMessage` in `AgentThread.js`, still present in 0.184.0). The documented 400 error never appeared in our runs.

So every MiMo attempt above ran with its earlier reasoning missing. That looked like the cause of the noise, so we tested it. `scripts/replay-reasoning.ts` sent 40 real conversation states from the pilots to the model 15 times each, both as TrueForge sends them and with the reasoning put back.

| | Calls | Noise | Mean prompt tokens |
|---|---|---|---|
| As TrueForge sends it | 600 | 11 | 14,017 |
| Reasoning restored | 600 | 9 | 23,192 |

**The theory was wrong:** Fisher's exact p = 0.82, so restoring the reasoning made no measurable difference to noise. The prompt tokens prove the reasoning reached the model. Noise wasn't tied to particular states either: the 4 states that gave noise in a pilot gave it in 3 of 120 calls, and the other 36 in 17 of 1,080.

What this does and doesn't settle:

- **The cause of the noise is still unknown.** In the replay it was always a run of `!`, half of it in the last sixth of the calls. In the pilots it was mixed tokens spread across each run. These may not be the same failure.
- **The replay measures noise only.** It can't show whether missing reasoning weakens instruction following, the effect Xiaomi warns about, because that needs whole attempts and TrueForge always removes the field.
- **Noise can change during a run,** which is one more reason to count it per run and to re-run the run 1 commit at the end.

The data is in `docs/data/reasoning-replay.json`.

## 6 Nov: why uploads failed

Every pilot lost 3-8 uploads to `fetch failed`. Retries recovered them, but at k=3 three in a row would have stopped a run overnight. The SDK hides the cause two levels down, so the harness now reports the whole chain. With a mock model producing real patches, it reproduced at no cost and aborted two runs:

- `ETIMEDOUT`: the harness connected to `localhost`, and the server listens on `::1` only, so Node raced both address families on a 250 ms timer.
- `ECONNRESET`: the request went out on a socket the server had already closed.

Both had one root cause in our harness: synchronous Docker scoring froze its event loop for seconds at a time. **Fix:** score without blocking, one attempt at a time as in curation, and connect to `[::1]`. Afterwards: 63 attempts at concurrency 8 with no failures.

## 6 Nov: two final pilots on the final harness

Before freezing, MiMo ran all 21 tasks twice more on the finished harness: once at its default settings, and once with `reasoning_effort: none`, the only switch that really turned thinking off. The rule was set beforehand: pick the variant in the 35-65 band with the most failures coming from the agent's own work, and on a tie keep the default. They ran side by side, with a scorer selftest running too, so the machine was under about twice the load of a real run.

| Variant | Score | Train | Held-out | Tests only | Resolved | Audit | No patch | Noise | Cut off | Cost | Time |
|---|---|---|---|---|---|---|---|---|---|---|---|
| Default | 23.81 | 25 | 22.22 | 66.67 | 5 | 9 | 7 | 0 of 1,127 | 5 | $0.92 | 114 min |
| Thinking off | 14.29 | 8.33 | 22.22 | 66.67 | 3 | 12 | 6 | 0 of 1,834 | 0 | $0.69 | 100 min |

Sessions `01m6qgxqz6e4xvp60w262j0r9q` and `01m6qgxqz8rvrgtn6b7qaaxrbg`. Neither reached the band, so the tie rule applied: **the default stays.** Its three pilots average 38. This one is the lowest of the three, and it ran under the heaviest load: suspected command timeouts rose from 0.5% of commands at concurrency 3 to 1.4% at 6 and 2.1% here. Nothing else ran alongside the counted runs.

- **Thinking off is worse.** Without reasoning, 12 of 21 attempts went after the upstream code, and 6 others ended in loops at the iteration or time limit.
- **Most failures happen before the patch is saved.** 5 of the default's 7 no-patch attempts ran out the 60-minute limit in the review stage, before calling `finish`. Reviewers took a median of 10 minutes, some 25-50, and 14 of 34 ended in an error, mostly the output limit.
- **We nearly got the noise wrong twice.** The first two pilots had noise and this thinking-off pilot didn't, which looked like proof that noise comes from thinking mode, at p = 0.0009. But the default pilot, with thinking on, ran at the same time and had none either. Noise changes with time: 9 in 1,563 calls in the first two pilots, 20 in 1,200 in the replay, 0 in 2,961 here. Comparing across time periods proves nothing, so the same trap applies to baseline and final runs. That's why noise is counted per run, and why the run 1 commit is re-run at the end.
- **The gateway had a bad 16 minutes.** Between 05:36 and 05:52, 25 model calls failed (`terminated`, `LLM stream aborted`, `ECONNRESET`). On a root turn that's an infrastructure retry. On a subagent, the root sees an error and has to deal with it.

## 6 Nov: `improve` on real failures

`improve` had only run on the mock model, so it ran once for real before the freeze, on the training failures from the three MiMo pilots, with `--no-commit`. It took 9 minutes and $0.03: 3 analysts and a skeptic, then a diagnosis citing 5 attempts on 4 tasks, and an 8-line edit that passed every guard. Its rule was to bound optional work so it can't stand between a patch and `work/tools/finish`.

**That edit was thrown away.** `agent/` was restored straight after, so the seed skills are unchanged, and only the real loop can make such a change. The real rounds will see much of the same evidence, so they may reach a similar rule. A pilot failure is not a counted run, and no held-out task was involved.

## 6 Nov: audit changes

All 5,555 pilot commands went through the audit. It found real cheating: one attempt downloaded `boltons-26.2.0` from PyPI and diffed it against its own fix, and another fetched upstream's `zip_broadcast` "for comparison". Two changes came out of reading those hits:

- **One false positive removed.** `find / -path "*tools/test"` was an agent lost after a wrong `cd`, looking for its own tool. That attempt's fix passed every test, and the audit voided it.
- **One gap closed.** The rule named only today's upstream repos. It now covers a copy of a task library under any GitHub owner, which catches old names like `jmoiron/humanize` and forks, and `npx semver`. No pilot attempt did this.

## 6 Nov: harness changes from reading the failures

- **`improve` was blind to how attempts ended.** A trace of tool calls just stops. Each failure now says how the turn ended and how its last response began and ended, so an analyst can tell a cut-off from giving up.
- **A failed `improve` session would have stopped the whole loop.** It now counts as a rejected proposal, which gets 3 tries per round.
- **`evolve` can restart.** Run again, it finishes a round whose edit was never screened, and keeps screens that already ran.
- **Rounds are fixed at 5,** with no early stop, and none starts after Saturday 7 Nov, 18:00 Dublin. A fixed count is less adaptive, and it gives a real edit more chances against a noisy screen.
- **k=3 and concurrency 8.** Latency didn't change between concurrency 3 and 6 (median 8.6 s and 9.8 s per model call), so the gateway isn't the limit. A third attempt per task cuts noise in every score.

## 6 Nov: frozen settings

MiMo v2.6 Flash at its default settings, with thinking on, k=3, concurrency 8. The pilots cost about $22 in total. The baseline may land near the bottom of the 35-65 target or under it, since the three pilots gave 42.86, 47.62 and 23.81 on single attempts per task.
