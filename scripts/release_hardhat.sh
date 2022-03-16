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
    { "name": "chris/test-semantic-release", "channel": "hardhat", "prerelease": "hahahhh"}
  ]
}' > .releaserc.json

# Temporarily overwrite tsconfig.json. tsc command `--project` flag not working for unknown reasons
cp tsconfig.json _temp_config
cp tsconfig.hardhat.json tsconfig.json

echo "Modified tsconfig.json"
cat tsconfig.json

PUBLISH_HARDHAT=true npx semantic-release --debug
