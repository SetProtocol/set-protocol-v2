#!/usr/bin/env bash

# Run in the `prepublishOnly npm hook`. We publish a specially built version
# of the repo to the @hardhat tag which includes hardcoded gas values in the hardhat
# artifact abis and deposits type definitions alongside the js files in the dist.
# This build is necessary for Perp fixtures to run correctly at set-v2-strategies
set -o errexit


# This hook is skipped when publishing in CI. All building has to be done before
# semantic-release runs because file changes don't persist in that execution context.
if [[ -v CI ]]; then
  echo "Skipping prepublishOnly hook in CI"
  exit 0
elif [[ -v PUBLISH_HARDHAT ]]; then
  echo "Running prepublishOnly hook for @hardhat"
  yarn build:npm:hardhat
else
  echo "Running prepublishOnly hook for @latest"
  yarn build:npm:latest
fi
