#!/usr/bin/env bash
# Finishes the rounds (round 4's edit is pending), then runs the final counted runs.
# Same retry rule as scripts/run-protocol.sh, plus a push before each retry: on 7 Nov a push that failed in an outage
# left a local commit that blocked every retry ("isn't on GitHub yet"), and the chain gave up. Nothing here changes a run.
set -uo pipefail
cd "$(dirname "$0")/.."
WAIT=${WAIT:-600}; TRIES=${TRIES:-30}; FINAL=${FINAL:-2}; LOG=.tmp/run-protocol.log
say() { echo "[$(date -u +%H:%M:%S)] $*" | tee -a "$LOG"; }
rows() { tail -n +2 runs/summary.csv | grep -c .; }
persist() {
  local tries=0
  until "$@" 2>&1 | tee -a "$LOG"; [ "${PIPESTATUS[0]}" -eq 0 ]; do
    if tail -n 8 "$LOG" | grep -q "provider refused"; then say "Account error: stopping for a person."; exit 2; fi
    tries=$((tries + 1))
    if [ "$tries" -gt "$TRIES" ]; then say "Still failing after $TRIES waits: stopping for a person."; exit 1; fi
    say "Stopped. Trying again in ${WAIT}s ($tries of $TRIES)."
    sleep "$WAIT"
    git push -q origin HEAD:main 2>&1 | grep -v '^remote:' | tail -n 2 | tee -a "$LOG"
  done
}
say "Rounds, resumed"
persist npx tsx scripts/evolve.ts --baseline 1,2,3
base=$(rows)
while [ "$(rows)" -lt $((base + FINAL)) ]; do
  say "Final run $(( $(rows) - base + 1 )) of $FINAL"
  persist npx tsx scripts/run-evals.ts --resume
done
say "Final runs finished."
