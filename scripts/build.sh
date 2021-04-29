#!/usr/bin/env bash

set -o errexit

yarn patch-hardhat-typechain
yarn patch-ovm-compiler
yarn compile
yarn compile:ovm
yarn fix-typechain
yarn transpile-dist
