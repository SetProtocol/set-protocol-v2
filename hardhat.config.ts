require("dotenv").config();

import { HardhatUserConfig } from "hardhat/config";
import { privateKeys } from "./utils/wallets";

import "@nomiclabs/hardhat-waffle";
import "hardhat-typechain";
import "solidity-coverage";
import "hardhat-deploy";
import "./tasks";

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
      hardfork: "istanbul",
      accounts: getHardhatPrivateKeys(),
    },
    localhost: {
      url: "http://127.0.0.1:8545",
      timeout: 100000,
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
  mocha: {
    timeout: 100000,
  },
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

export default config;
