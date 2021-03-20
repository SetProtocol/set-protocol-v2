import {
  TASK_COMPILE_SOLIDITY_GET_ARTIFACT_FROM_COMPILATION_OUTPUT,
} from "hardhat/builtin-tasks/task-names";

import { subtask } from "hardhat/config";
import { addGasToAbiMethods } from "../utils/tasks";

// Injects network block limit (minus 1 million) in the abi so
// ethers uses it instead of running gas estimation.
subtask(TASK_COMPILE_SOLIDITY_GET_ARTIFACT_FROM_COMPILATION_OUTPUT)
  .setAction(async (_, { network }, runSuper) => {
    const artifact = await runSuper();
    artifact.abi = addGasToAbiMethods(network.config, artifact.abi);
    return artifact;
  }
);


export {};
