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

const defaultMnemonic = "test test test test test test test test test test test junk";
const OVM = process.env.OVM === "true";
const HARDHAT_EVM = process.env.HARDHAT_EVM === "true";

// Runs subset of OVM tests minus those marked as necessary for HardhatEVM to skip
// Some tests rely on ETH/WETH balance specific logic that only works on the OVM
// client because WETH precompile address is hardcoded into the contracts
const hardhatEVMTestSelection = /(?!.*@ovm.*@hardhat-evm-skip)@ovm.*/;

const config: HardhatUserConfig = {
  solidity: {
    version: "0.6.12",
    settings: {
      optimizer: { enabled: true, runs: 1 },
    },
  },
  namedAccounts: {
    deployer: 0,
  },
  ovm: {
    solcVersion: "0.6.12",
  },
  networks: {
    hardhat: {
      hardfork: "istanbul",
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
    optimism: {
      url: "http://127.0.0.1:8545",
      accounts: { mnemonic: defaultMnemonic },
      gasPrice: 0,
      gas: 8999999,
      blockGasLimit: 8999999,
      // @ts-ignore
      ovm: true,
    },
  },
  typechain: {
    outDir: "typechain",
    target: "ethers-v5",
  },
  mocha: {
    grep: HARDHAT_EVM ? hardhatEVMTestSelection : "@ovm",
    timeout: 150000,
  },
  paths: {
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
