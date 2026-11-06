#!/usr/bin/env bash
# Runs the protocol unattended from the freeze to the end of the rounds: the 3 baseline runs, the spread, then evolve.
# Safe to run again at any point: it counts what's done and carries on.
#
# A run or round that stops is resumed after a wait, so a short outage doesn't end the night. It gives up after
# TRIES waits, and at once on an account error: those are a person's call. Nothing here changes what a run does.
#   caffeinate -dims scripts/run-protocol.sh
set -uo pipefail
cd "$(dirname "$0")/.."

WAIT=${WAIT:-600}
TRIES=${TRIES:-6}
BASELINES=3
LOG=${LOG:-.tmp/run-protocol.log}
mkdir -p "$(dirname "$LOG")"

say() { echo "[$(date -u +%H:%M:%S)] $*" | tee -a "$LOG"; }
rows() { tail -n +2 runs/summary.csv | grep -c .; }

# Runs a command until it succeeds. Everything is logged, so the reason for any stop can be read afterwards.
persist() {
  local tries=0
  until "$@" 2>&1 | tee -a "$LOG"; [ "${PIPESTATUS[0]}" -eq 0 ]; do
    if tail -n 8 "$LOG" | grep -q "provider refused"; then
      say "Account error: stopping for a person."
      exit 2
    fi
    tries=$((tries + 1))
    if [ "$tries" -gt "$TRIES" ]; then
      say "Still failing after $TRIES waits: stopping for a person."
      exit 1
    fi
    say "Stopped. Trying again in ${WAIT}s ($tries of $TRIES)."
    sleep "$WAIT"
  done
}

while [ "$(rows)" -lt "$BASELINES" ]; do
  say "Baseline run $(($(rows) + 1)) of $BASELINES"
  persist npx tsx scripts/run-evals.ts --resume
done

if [ ! -f runs/spread.md ]; then
  say "Baseline spread"
  npx tsx scripts/spread.ts 1,2,3 2>&1 | tee -a "$LOG"
  git add runs
  git commit -q -m "Record the baseline spread"
  git push -q origin HEAD:main
fi

say "Rounds"
persist npx tsx scripts/evolve.ts --baseline 1,2,3
say "Rounds finished. The final runs are next: npm run run-evals, then the drift check and the verdict."
