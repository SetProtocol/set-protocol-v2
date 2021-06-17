require("dotenv").config();

import chalk from "chalk";
import { HardhatUserConfig } from "hardhat/config";
import { privateKeys } from "./utils/wallets";

import "@nomiclabs/hardhat-waffle";
import "hardhat-typechain";
import "solidity-coverage";
import "hardhat-deploy";
import "./tasks";

const forkingConfig = {
  url: `https://eth-mainnet.alchemyapi.io/v2/${process.env.ALCHEMY_TOKEN}`,
  blockNumber: 12198000,
};

const mochaConfig = {
  grep: "@forked-mainnet",
  invert: (process.env.FORK) ? false : true,
  timeout: (process.env.FORK) ? 50000 : 20000,
} as Mocha.MochaOptions;

checkForkedProviderEnvironment();

const config: HardhatUserConfig = {
  solidity: {
    version: "0.6.10",
    settings: {
      optimizer: { enabled: true, runs: 200 },
    },
  },
  namedAccounts: {
    deployer: 0,
  },
  networks: {
    hardhat: {
      forking: (process.env.FORK) ? forkingConfig : undefined,
      accounts: getHardhatPrivateKeys(),
    },
    localhost: {
      url: "http://127.0.0.1:8545",
      timeout: 100000,
      gas: 9500000,
      blockGasLimit: 9500000,
    },
    kovan: {
      url: "https://kovan.infura.io/v3/" + process.env.INFURA_TOKEN,
      // @ts-ignore
      accounts: [`0x${process.env.KOVAN_DEPLOY_PRIVATE_KEY}`],
    },
    staging_mainnet: {
      url: "https://mainnet.infura.io/v3/" + process.env.INFURA_TOKEN,
      // @ts-ignore
      accounts: [`0x${process.env.STAGING_MAINNET_DEPLOY_PRIVATE_KEY}`],
    },
    production: {
      url: "https://mainnet.infura.io/v3/" + process.env.INFURA_TOKEN,
      // @ts-ignore
      accounts: [`0x${process.env.PRODUCTION_MAINNET_DEPLOY_PRIVATE_KEY}`],
    },
    // To update coverage network configuration got o .solcover.js and update param in providerOptions field
    coverage: {
      url: "http://127.0.0.1:8555", // Coverage launches its own ganache-cli client
      timeout: 100000,
    },
  },
  typechain: {
    outDir: "typechain",
    target: "ethers-v5",
  },
  mocha: mochaConfig,
};

function getHardhatPrivateKeys() {
  return privateKeys.map(key => {
    const ONE_MILLION_ETH = "1000000000000000000000000";
    return {
      privateKey: key,
      balance: ONE_MILLION_ETH,
    };
  });
}

function checkForkedProviderEnvironment() {
  if (process.env.FORK &&
      (!process.env.ALCHEMY_TOKEN || process.env.ALCHEMY_TOKEN === "fake_alchemy_token")
     ) {
    console.log(chalk.red(
      "You are running forked provider tests with invalid Alchemy credentials.\n" +
      "Update your ALCHEMY_TOKEN settings in the `.env` file."
    ));
    process.exit(1);
  }
}

export default config;
