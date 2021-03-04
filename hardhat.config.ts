require("dotenv").config();
const replace = require("replace-in-file");

let changedFiles;

import { HardhatUserConfig, internalTask } from "hardhat/config";
import { TASK_COMPILE_SOLIDITY_COMPILE, TASK_TEST_SETUP_TEST_ENVIRONMENT } from "hardhat/builtin-tasks/task-names";
import { execSync } from "child_process";
import { privateKeys } from "./utils/wallets";

import "@nomiclabs/hardhat-waffle";
import "hardhat-typechain";
import "solidity-coverage";
import "hardhat-deploy";

internalTask(TASK_COMPILE_SOLIDITY_COMPILE).setAction(setupNativeSolc);
internalTask(TASK_TEST_SETUP_TEST_ENVIRONMENT).setAction(async function setupNativeSolc({ input }, { config }, runSuper) {
  // Fix gas to be string instead of number in typechain files
  const options = {
    // Glob(s)
    files: [
      "./typechain/**/*.ts",
    ],

    // Replacement to make (string or regex)
    from: /gas\: [0-9]+,/g,
    to: (match: string) => match.replace(/gas: ([0-9]+),/g, 'gas: "$1",'),
  };

  try {
    changedFiles = replace.sync(options);
    console.log("Fixing gas cost type from number to string...")
    ;
  }
  catch (error) {
    console.error("Error occurred:", error);
  }
});

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
  }
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

// @ts-ignore
async function setupNativeSolc({ input }, { config }, runSuper) {
  let solcVersionOutput = "";
  try {
    solcVersionOutput = execSync(`solc --version`).toString();
  } catch (error) {
    // Probably failed because solc wasn"t installed. We do nothing here.
  }

  console.log("Output", solcVersionOutput);

  if (!solcVersionOutput.includes(config.solidity.version)) {
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
