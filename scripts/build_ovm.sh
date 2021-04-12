#!/usr/bin/env bash

yarn compile:ovm
yarn patch-hardhat-typechain:ovm
yarn typechain
yarn fix-typechain
yarn transpile-dist
