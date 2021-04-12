#!/usr/bin/env bash

yarn compile
yarn patch-hardhat-typechain
yarn typechain
yarn fix-typechain
yarn transpile-dist
