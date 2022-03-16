#!/usr/bin/env bash

# Run in the `prepublishOnly npm hook`. We publish a specially built version
# of the repo to the @hardhat tag which includes hardcoded gas values in the hardhat
# artifact abis and deposits type definitions alongside the js files in the dist.
# This build is necessary for Perp fixtures to run correctly at set-v2-strategies
set -o errexit

echo "Running prepublishOnly npm hook"
echo "PUBLISH_HARDHAT = $PUBLISH_HARDHAT"

if [[ -v PUBLISH_HARDHAT ]]; then
  # Temporarily overwrite tsconfig.json. tsc command `--project` flag not working for unknown reasons
  cp tsconfig.json _temp_config
  cp tsconfig.hardhat.json tsconfig.json

  yarn build:npm:hardhat

  # Restore tsconfig to remove git changes
  cp _temp_config tsconfig.json
else
  yarn build:npm:latest
fi
