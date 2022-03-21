#!/usr/bin/env bash

set -o errexit

# Auto-publishes `latest` from master, updates package version on github
# Version format is `x.x.x` and installs with `yarn add @setprotocol/set-protocol-v2`
# `package.json` version field is updated and pushed to Github
echo '{
  "branches": [
    { "name": "master" }
  ],
  "plugins": [
    "@semantic-release/commit-analyzer",
    "@semantic-release/release-notes-generator",
    "@semantic-release/npm",
    "@semantic-release/git"
  ]
}' > .releaserc.json

# Regenerate artifacts to strip out hardcoded gas values in artifact ABIs
yarn build:npm:latest

npx semantic-release --debug
