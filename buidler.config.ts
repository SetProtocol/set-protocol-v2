require("dotenv").config();

import { BuidlerConfig, usePlugin, internalTask } from "@nomiclabs/buidler/config";
import { TASK_COMPILE_RUN_COMPILER } from "@nomiclabs/buidler/builtin-tasks/task-names";
import { execSync } from "child_process";
import { privateKeys } from "./utils/wallets";

usePlugin("@nomiclabs/buidler-waffle");
usePlugin("buidler-typechain");
usePlugin("solidity-coverage");
usePlugin("buidler-deploy");

internalTask(TASK_COMPILE_RUN_COMPILER).setAction(setupNativeSolc);

const config: BuidlerConfig = {
  solc: {
    version: "0.6.10",
    optimizer: { enabled: true, runs: 200 },
  },
  namedAccounts: {
    deployer: 0,
  },
  networks: {
    buidlerevm: {
      hardfork: "istanbul",
      accounts: getBuidlerPrivateKeys(),
      timeout: 100000,
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
    target: "ethers-v4",
  },
  mocha: {
    timeout: 100000,
  }
};

function getBuidlerPrivateKeys() {
  return privateKeys.map(key => {
    const ONE_MILLION_ETH = "1000000000000000000000000";
    return {
      privateKey: key,
      balance: ONE_MILLION_ETH,
    };
  });
}

// @ts-ignore
async function setupNativeSolc({ input }, { config }, runSuper) {
  let solcVersionOutput = "";
  try {
    solcVersionOutput = execSync(`solc --version`).toString();
  } catch (error) {
    // Probably failed because solc wasn"t installed. We do nothing here.
  }

  console.log("Output", solcVersionOutput);

  if (!solcVersionOutput.includes(config.solc.version)) {
    console.log(`Using solcjs`);
    return runSuper();
  }

  console.log(`Using native solc`);
  const output = execSync(`solc --standard-json`, {
    input: JSON.stringify(input, undefined, 2),
  });

  return JSON.parse(output.toString(`utf8`));
}

export default config;
