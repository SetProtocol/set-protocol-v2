#!/usr/bin/env bash

set -o errexit

# Auto-publishes `latest` from master
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

npx semantic-release --debug
