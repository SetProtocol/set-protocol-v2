#!/usr/bin/env bash

# Run in the `prepublishOnly npm hook`. We publish a specially built version
# of the repo to the @hardhat tag which includes hardcoded gas values in the hardhat
# artifact abis and deposits type definitions alongside the js files in the dist.
# This build is necessary for Perp fixtures to run correctly at set-v2-strategies
set -o errexit

echo "Running prepublishOnly npm hook"
echo "PUBLISH_HARDHAT = $PUBLISH_HARDHAT"

# Can only use some package.json commands here because npm is the executor in this
# context (instead of yarn) and they have conflicting policies about how CLI
# flags work in package.json. npm requires: `command -- --flags`, yarn prohibits it.
if [[ -v PUBLISH_HARDHAT ]]; then
  yarn clean
  yarn compile
  yarn typechain
  tsc --project tsconfig.hardhat.json
  cp -rf typechain dist
else
  yarn clean
  yarn compile:latest
  yarn typechain
  tsc --project tsconfig.dist.json
fi
