#!/usr/bin/env bash

git clone https://github.com/ethereum-optimism/optimism.git
cd optimism
git checkout dee74ef54b38750085a8cc2dfbcb67dc80d2a10f
cp ../scripts/optimism/docker-compose.yml ./ops/docker-compose.yml
cd ops
docker-compose pull
