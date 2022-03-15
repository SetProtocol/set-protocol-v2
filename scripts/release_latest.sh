#!/usr/bin/env bash

set -o errexit

echo '{
  "branches": [
    { "name": "master" }
  ]
}' > .releaserc.json

npx semantic-release --debug --dry-run --ci
