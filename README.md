[![CircleCI](https://dl.circleci.com/status-badge/img/gh/IndexCoop/index-protocol/tree/master.svg?style=svg)](https://dl.circleci.com/status-badge/redirect/gh/IndexCoop/index-protocol/tree/master)
[![Coverage Status](https://coveralls.io/repos/github/IndexCoop/index-protocol/badge.svg?branch=master)](https://coveralls.io/github/IndexCoop/index-protocol?branch=master)

# Index Protocol Contract Repository

An overview of Index Protocol is available in our [Gitbook docs][11]

[11]: https://index-coop.gitbook.io/index-coop-community-handbook/protocols/index-protocol

## Contracts
This repo was originally forked from [Set Protocol v2](https://github.com/indexcoop/index-protocol) with permission from Set Labs. It is intended to house both original code (including most of this README) *and* new code that extends the protocol. Not all of the original contracts will be deployed as part of Index Protocol, and in time we will clean up unused code.

[Set Protocol](https://setprotocol.com/) is a specification for tokenized asset management strategies on the ethereum blockchain written in the Solidity programming language. We use [Hardhat](https://hardhat.org/) as a development environment for compiling, testing, and deploying our contracts.

## Development

To use console.log during Solidity development, follow the [guides](https://hardhat.org/guides/hardhat-console.html).

## Available Functionality

### Run Hardhat EVM

`yarn chain`

### Build Contracts

`yarn compile`

To speed up compilation, install solc 0.6.10 natively with the following command.
```
brew install https://raw.githubusercontent.com/ethereum/homebrew-ethereum/06d13a8499801dc3ea4f19b2d24ed2eeb3072ebb/solidity.rb
```

### Generate TypeChain Typings

`yarn build`

### Run Contract Tests

`yarn test` to run compiled contracts

OR `yarn test:clean` if contracts have been typings need to be updated

### Run Coverage Report for Tests

`yarn coverage`

## Installing from `npm`

We publish our contracts as well as [hardhat][22] and [typechain][23] compilation artifacts to npm.

```
npm install @indexcoop/index-protocol
```

The distribution also comes with fixtures for mocking and testing SetProtocol's interactions with
other protocols including Uniswap, Balancer, Compound (and many more.) To use these you'll need to install the peer dependencies listed in `package.json`.

#### Example Usage

```ts
import { PerpV2Fixture } from "@indexcoop/index-protocol/dist/utils/fixtures/PerpV2Fixture";
import { getPerpV2Fixture } from "@indexcoop/index-protocol/dist/utils/test";

let perpSetup: PerpV2Fixture;
perpSetup = getPerpV2Fixture(...);
```

[22]: https://www.npmjs.com/package/hardhat
[23]: https://www.npmjs.com/package/typechain

## Semantic Release

This repository uses [semantic-release][10] to automatically publish in CI on merge to master. To trigger
a release, use the following naming convention in your PR description (or in your squash & merge commit
description):

+ patch release (e.g 1.0.1 -> 1.0.2): `fix(topic): description`
  + example: `fix(perpV2Viewer): return uint256 instead of int256`
+ feature release (e.g 1.1.0 -> 1.2.0): `feat(feature_name): description`
  + example: `feat(PerpV2BasisTrading): Add PerpV2 Basis Trading Module`


## Contributing
We encourage participation from the community to help shape the development of Index Protocol. If you are interested in developing on top of Set Protocol or have any questions, please ping us on [Discord](https://discord.gg/ZWY66aR).

## Security Audits

Set Protocol V2 has undergone several audits. For more information see https://index-coop.gitbook.io/index-coop-community-handbook/protocols/security-and-audits

We have also audited recent changes  and additions to the protocol post-fork.

## Vulnerability Reporting ##

If you believe you’ve found a security vulnerability in one of our contracts or platforms, we encourage you to submit it through our [ImmuneFi Bug Bounty][32] program.

[32]: https://immunefi.com/bounty/indexcoop/