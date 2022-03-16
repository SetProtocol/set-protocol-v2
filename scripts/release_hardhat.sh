#!/usr/bin/env bash

set -o errexit

# Auto-publishes a specially built release to the @hardhat tag using version schema `x.x.x-hardhat.1`
# See scripts/prepublish_only.sh for details about this build.
#
# The `release_default` branch config here is necessary to trick the semantic-release tool into publishing
# latest and hardhat builds from `master`. These are handled by separate jobs in CI (see circleci/config.yml)
echo '{
  "branches": [
    { "name": "release_default_do_not_delete" },
    { "name": "chris/test-semantic-release", "channel": "hardhat", "prerelease": "ccccccccccccccc"}
  ]
}' > .releaserc.json

# Copy custom config to default config. `tsc` is running somewhere we can't control, this seems to
# be the only way to get the correct compilation
cp tsconfig.hardhat.json tsconfig.json

npx semantic-release --debug
