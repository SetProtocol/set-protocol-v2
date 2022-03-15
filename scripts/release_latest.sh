#!/usr/bin/env bash

set -o errexit

# Auto-publishes `latest` from master
echo '{
  "branches": [
    { "name": "master" }
  ]
}' > .releaserc.json

npx semantic-release --debug
