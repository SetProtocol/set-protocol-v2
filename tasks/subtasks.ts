import {
  TASK_TEST_SETUP_TEST_ENVIRONMENT,
  TASK_COMPILE_SOLIDITY_GET_ARTIFACT_FROM_COMPILATION_OUTPUT,
} from "hardhat/builtin-tasks/task-names";

import { subtask, internalTask } from "hardhat/config";
import { addGasToAbiMethods } from "../utils/tasks";

// Injects network block limit (minus 1 million) in the abi so
// ethers uses it instead of running gas estimation.
subtask(TASK_COMPILE_SOLIDITY_GET_ARTIFACT_FROM_COMPILATION_OUTPUT)
  .setAction(async (_, { network }, runSuper) => {
    const artifact = await runSuper();

    // These changes should be skipped when publishing to npm.
    // They override ethers' gas estimation
    if (!process.env.SKIP_ABI_GAS_MODS){
      artifact.abi = addGasToAbiMethods(network.config, artifact.abi);
    }

    return artifact;
  }
);

// Fix gas to be string instead of number in typechain files
internalTask(TASK_TEST_SETUP_TEST_ENVIRONMENT)
  .setAction(async ({ input }, { config }, runSuper) => {
    if (process.env.NO_COMPILE === "true") return;

    const replace = require("replace-in-file");

    const options = {
      files: [ "./typechain/**/*.ts" ],
      from: /gas\: [0-9]+,/g,
      to: (match: string) => match.replace(/gas: ([0-9]+),/g, 'gas: "$1",'),
    };

    try {
      replace.sync(options);
      console.log("Fixing gas cost type from number to string...");
    } catch (error) {
      console.error("Error occurred:", error);
    }
});


export {};
