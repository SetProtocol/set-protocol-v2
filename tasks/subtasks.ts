import {
  TASK_COMPILE_SOLIDITY_COMPILE,
  TASK_TEST_SETUP_TEST_ENVIRONMENT,
  TASK_COMPILE_SOLIDITY_GET_ARTIFACT_FROM_COMPILATION_OUTPUT,
} from "hardhat/builtin-tasks/task-names";

import { subtask, internalTask } from "hardhat/config";
import { addGasToAbiMethods, setupNativeSolc } from "../utils/tasks";

// Injects network block limit (minus 1 million) in the abi so
// ethers uses it instead of running gas estimation.
subtask(TASK_COMPILE_SOLIDITY_GET_ARTIFACT_FROM_COMPILATION_OUTPUT)
  .setAction(async (_, { network }, runSuper) => {
    const artifact = await runSuper();
    artifact.abi = addGasToAbiMethods(network.config, artifact.abi);
    return artifact;
  }
);

// Use native solc if available locally at config specified version
internalTask(TASK_COMPILE_SOLIDITY_COMPILE).setAction(setupNativeSolc);

// Fix gas to be string instead of number in typechain files
internalTask(TASK_TEST_SETUP_TEST_ENVIRONMENT)
  .setAction(async function setupNativeSolc({ input }, { config }, runSuper) {
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
