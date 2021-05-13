#!/usr/bin/env bash

set -o errexit

cd optimism
git checkout dee74ef54b38750085a8cc2dfbcb67dc80d2a10f
cd ops
docker-compose up -d && ./scripts/wait-for-sequencer.sh
wget \
  --retry-connrefused \
  --waitretry=1 \
  --read-timeout=120 \
  --timeout=120 \
  -t 100 \
  http://localhost:8545
