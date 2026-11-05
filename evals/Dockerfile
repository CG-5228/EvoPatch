# The scorer's image: pinned Python and Node, matching the sandbox's versions, with every test dependency baked in,
# because tests run with --network none. Build: docker build -t evopatch-scorer:1 evals
FROM node:24.9.0-slim@sha256:3e69116c924bfcba6c6979aff60d966c37aef56d488ce091c69d442ebec9f103 AS node
RUN npm install --prefix /opt/tap --no-audit --no-fund tap@16.3.10

FROM python:3.15.2-slim@sha256:e97b88e416c3c01eb427b21fd8cd3ebf006e6ee38afcfcc3cae1c54ee2ab0a75
RUN apt-get update \
 && apt-get install -y --no-install-recommends git libstdc++6 \
 && rm -rf /var/lib/apt/lists/*
RUN pip install --no-cache-dir pytest==9.1.1
COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=node /opt/tap/node_modules /opt/tap/node_modules
ENV NODE_PATH=/opt/tap/node_modules \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONHASHSEED=0 \
    PYTHONUTF8=1 \
    TZ=UTC \
    LC_ALL=C.UTF-8
