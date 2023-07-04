require("dotenv").config();
require("hardhat-contract-sizer");

import chalk from "chalk";
import { HardhatUserConfig, task } from "hardhat/config";
import { privateKeys } from "./utils/wallets";

import "@nomiclabs/hardhat-waffle";
import "@typechain/hardhat";
import "solidity-coverage";
import "hardhat-deploy";
import {
  TASK_COMPILE_SOLIDITY_GET_COMPILATION_JOB_FOR_FILE,
  TASK_COMPILE_SOLIDITY_GET_DEPENDENCY_GRAPH,
  TASK_COMPILE_SOLIDITY_COMPILE_JOB,
} from "hardhat/builtin-tasks/task-names";

import type { DependencyGraph, CompilationJob } from "hardhat/types/builtin-tasks";

import "./tasks";

export const forkingConfig = {
  url: `https://eth-mainnet.alchemyapi.io/v2/${process.env.ALCHEMY_TOKEN}`,
  blockNumber: 16889000,
};

const mochaConfig = {
  grep: "@forked-mainnet",
  invert: process.env.FORK ? false : true,
  timeout: 200000,
} as Mocha.MochaOptions;

checkForkedProviderEnvironment();

const hardhatNetworks = {
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
};

const config: HardhatUserConfig = {
  solidity: {
    compilers: [
      {
        version: "0.6.10",
        settings: { optimizer: { enabled: true, runs: 200 } },
      },
      {
        version: "0.8.17",
        settings: { optimizer: { enabled: true, runs: 200 } },
      },
    ],
  },
  networks: {
    hardhat: {
      allowUnlimitedContractSize: false,
      forking: process.env.FORK ? forkingConfig : undefined,
      accounts: getHardhatPrivateKeys(),
      gas: 12000000,
      blockGasLimit: 12000000,
    },
    localhost: {
      url: "http://127.0.0.1:8545",
      timeout: 200000,
      gas: 12000000,
      blockGasLimit: 12000000,
    },
    // To update coverage network configuration got o .solcover.js and update param in providerOptions field
    coverage: {
      url: "http://127.0.0.1:8555", // Coverage launches its own ganache-cli client
      timeout: 200000,
    },
    ...(process.env.KOVAN_DEPLOY_PRIVATE_KEY && hardhatNetworks),
  },
  // @ts-ignore
  typechain: {
    outDir: "typechain",
    target: "ethers-v5",
    externalArtifacts: ["external/**/*.json"],
  },
  // @ts-ignore
  contractSizer: {
    runOnCompile: false,
  },

  mocha: mochaConfig,

  // These are external artifacts we don't compile but would like to improve
  // test performance for by hardcoding the gas into the abi at runtime
  // @ts-ignore
  externalGasMods: ["external/abi/perp"],
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
  if (
    process.env.FORK &&
    (!process.env.ALCHEMY_TOKEN || process.env.ALCHEMY_TOKEN === "fake_alchemy_token")
  ) {
    console.log(
      chalk.red(
        "You are running forked provider tests with invalid Alchemy credentials.\n" +
          "Update your ALCHEMY_TOKEN settings in the `.env` file.",
      ),
    );
    process.exit(1);
  }
}

task("index:compile:one", "Compiles a single contract in isolation")
  .addPositionalParam("contractName")
  .setAction(async function (args, env) {
    const sourceName = env.artifacts.readArtifactSync(args.contractName).sourceName;

    const dependencyGraph: DependencyGraph = await env.run(
      TASK_COMPILE_SOLIDITY_GET_DEPENDENCY_GRAPH,
      { sourceNames: [sourceName] },
    );

    const resolvedFiles = dependencyGraph.getResolvedFiles().filter(resolvedFile => {
      return resolvedFile.sourceName === sourceName;
    });

    const compilationJob: CompilationJob = await env.run(
      TASK_COMPILE_SOLIDITY_GET_COMPILATION_JOB_FOR_FILE,
      {
        dependencyGraph,
        file: resolvedFiles[0],
      },
    );

    await env.run(TASK_COMPILE_SOLIDITY_COMPILE_JOB, {
      compilationJob,
      compilationJobs: [compilationJob],
      compilationJobIndex: 0,
      emitsArtifacts: true,
      quiet: true,
    });

    await env.run("typechain");
  });

task("index:compile:all", "Compiles all contracts in isolation").setAction(async function (
  _args,
  env,
) {
  const allArtifacts = await env.artifacts.getAllFullyQualifiedNames();
  for (const contractName of allArtifacts) {
    const sourceName = env.artifacts.readArtifactSync(contractName).sourceName;

    const dependencyGraph: DependencyGraph = await env.run(
      TASK_COMPILE_SOLIDITY_GET_DEPENDENCY_GRAPH,
      {
        sourceNames: [sourceName],
      },
    );

    const resolvedFiles = dependencyGraph.getResolvedFiles().filter(resolvedFile => {
      return resolvedFile.sourceName === sourceName;
    });

    const compilationJob: CompilationJob = await env.run(
      TASK_COMPILE_SOLIDITY_GET_COMPILATION_JOB_FOR_FILE,
      {
        dependencyGraph,
        file: resolvedFiles[0],
      },
    );

    await env.run(TASK_COMPILE_SOLIDITY_COMPILE_JOB, {
      compilationJob,
      compilationJobs: [compilationJob],
      compilationJobIndex: 0,
      emitsArtifacts: true,
      quiet: true,
    });
  }
});
export default config;
