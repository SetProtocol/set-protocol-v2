#!/usr/bin/env bash

set -o errexit

echo '{
  "branches": [
    { "name": "ignore" },
    { "name": "chris/semantic-release", "channel": "hardhat", "prerelease": "hardhat"}
  ]
}' > .releaserc.json

PUBLISH_HARDHAT=true npx semantic-release --debug --dry-run --ci
