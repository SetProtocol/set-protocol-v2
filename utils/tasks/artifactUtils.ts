import type { ethers } from "ethers";
import { NetworkConfig } from "hardhat/types";

// Adds a `gas` field to the ABI function elements so that ethers doesn't
// automatically estimate gas limits on every call (since these duplicate vm execution costs).
// (Borrowed from hardhat-ethers/src/internal/helpers.ts)
export function addGasToAbiMethods(
  networkConfig: NetworkConfig,
  abi: any[]
): any[] {
  const { BigNumber } = require("ethers") as typeof ethers;

  // Stay well under network limit b/c ethers adds a margin
  const gasLimit = BigNumber.from(networkConfig.gas).sub(1000000).toHexString();

  const modifiedAbi: any[] = [];

  for (const abiElement of abi) {
    if (abiElement.type !== "function") {
      modifiedAbi.push(abiElement);
      continue;
    }

    modifiedAbi.push({
      ...abiElement,
      gas: gasLimit,
    });
  }

  return modifiedAbi;
}
