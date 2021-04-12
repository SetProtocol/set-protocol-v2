require("dotenv").config();

import { HardhatUserConfig } from "hardhat/config";
import { privateKeys } from "./utils/wallets";

import "@nomiclabs/hardhat-waffle";
import "hardhat-typechain";
import "solidity-coverage";
import "hardhat-deploy";
import "hardhat-contract-sizer";
import "@eth-optimism/plugins/hardhat/compiler";
import "./tasks";

const OVM = process.env.OVM === "true";

const config: HardhatUserConfig = {
  solidity: {
    version: OVM ? "0.6.12" : "0.6.10",
    settings: {
      optimizer: { enabled: true, runs: 200 },
    },
  },
  ovm: {
    solcVersion: "0.6.12"
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
    optimism: {
      url: 'http://127.0.0.1:8545',
      accounts: {
        mnemonic: 'test test test test test test test test test test test junk'
      },
      ovm: true,
    }
  },
  typechain: {
    outDir: "typechain",
    target: "ethers-v5",
  },
  mocha: {
    timeout: 100000,
  },
  paths: {
    sources: OVM ? "./optimism" : "./contracts",
    artifacts: OVM ? "./artifacts-ovm" : "./artifacts",
    cache: OVM ? "./cache-ovm" : "./cache",
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
