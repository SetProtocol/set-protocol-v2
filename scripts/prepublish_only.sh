#!/usr/bin/env bash

# Run in the `prepublishOnly npm hook`. We publish a specially built version
# of the repo to the @hardhat tag which includes hardcoded gas values in the hardhat
# artifact abis and deposits type definitions alongside the js files in the dist.
# This build is necessary for Perp fixtures to run correctly at set-v2-strategies
set -o errexit

echo "Running prepublishOnly npm hook"
echo "PUBLISH_HARDHAT = $PUBLISH_HARDHAT"

# This hook is skipped when publishing in CI because semantic-release is discarding TS products of
# npm lifecycle hooks. In CI we re-write the tsconfig on the fly to generate the correct outputs.
if [[ -v CI ]]; then
  exit 0
elif [[ -v PUBLISH_HARDHAT ]]; then
  yarn build:npm:hardhat
else
  yarn build:npm:latest
fi
