#!/usr/bin/env bash

set -o errexit

# Auto-publishes a specially built release to the @hardhat tag using version schema `x.x.x-hardhat.1`
# which can be installed with `yarn add @setprotocol/set-protocol-v2@hardhat`
# See scripts/prepublish_only.sh for details about this build.
#
# The `release_default...` branch config here is necessary to trick the semantic-release tool into publishing
# latest and hardhat builds from `master`. These are handled by separate jobs in CI (see circleci/config.yml)
echo '{
  "branches": [
    { "name": "release_default_do_not_delete" },
    { "name": "master", "channel": "hardhat", "prerelease": "hhat"}
  ]
}' > .releaserc.json

# `semantic-release` will discard any dist changes generated by npm lifecycle hooks (very mysterious)
# so we copy the custom config into the default config to produce correct build. This change *IS NOT*
# committed to the repo and this script does not update the package.json version.
cp tsconfig.hardhat.json tsconfig.json

npx semantic-release --debug
