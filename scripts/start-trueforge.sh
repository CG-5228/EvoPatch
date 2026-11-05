#!/usr/bin/env bash
# Start the pinned TrueForge server. Always from this folder: the sandbox's write denies are anchored at the
# server's working directory, and starting from $HOME breaks git inside every sandbox.
#   scripts/start-trueforge.sh         counted runs: port 8790, default data dir
#   scripts/start-trueforge.sh --dev   mock model: port 8791, separate data dir, 127.0.0.1 allowed as a provider
# Only one server at a time: each boot resets the shared $TMPDIR/tf_cms socket folder.
set -euo pipefail
cd "$(dirname "$0")/.."

export SERVER_EXECUTION_TIMEOUT_SECONDS=3600
export MODEL_HTTP_HEADERS_TIMEOUT_MS=300000
export MODEL_HTTP_BODY_TIMEOUT_MS=300000

if [ "${1:-}" = "--dev" ]; then
  export PORT=8791
  export APP_DATA_DIR_SUFFIX=-dev
  export OUTBOUND_URL_ALLOWED_HOSTS='["127.0.0.1"]'
fi

exec npx --yes @truefoundry/trueforge@0.182.0
