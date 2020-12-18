// Buidler automatically injects the waffle version into chai
import chai from "chai";

// Use BUIDLER version of providers
import { ethers } from "@nomiclabs/buidler";
import { BigNumber } from "ethers/utils";
import { JsonRpcProvider } from "ethers/providers";
import { Blockchain } from "../common";

const provider = ethers.provider;
// const blockchain = new Blockchain(provider);

// BUIDLER-SPECIFIC Provider
export const getProvider = (): JsonRpcProvider => {
  return ethers.provider;
};

// BUIDLER / WAFFLE
export const getWaffleExpect = (): Chai.ExpectStatic => {
  return chai.expect;
};

// And this is our test sandboxing. It snapshots and restores between each test.
// Note: if a test suite uses fastForward at all, then it MUST also use these snapshots,
// otherwise it will update the block time of the EVM and future tests that expect a
// starting timestamp will fail.
export const addSnapshotBeforeRestoreAfterEach = () => {
  const blockchain = new Blockchain(provider);
  beforeEach(async () => {
    await blockchain.saveSnapshotAsync();
  });

  afterEach(async () => {
    await blockchain.revertAsync();
  });
};

export async function getTransactionTimestamp(asyncTxn: any): Promise<BigNumber> {
  const txData = await asyncTxn;
  return new BigNumber((await provider.getBlock(txData.block)).timestamp);
}

export async function getLastBlockTimestamp(): Promise<BigNumber> {
  return new BigNumber((await provider.getBlock("latest")).timestamp);
}

export async function mineBlockAsync(): Promise<any> {
  await sendJSONRpcRequestAsync("evm_mine", []);
}

export async function increaseTimeAsync(
  duration: BigNumber,
): Promise<any> {
  await sendJSONRpcRequestAsync("evm_increaseTime", [duration.toNumber()]);
  await mineBlockAsync();
}

async function sendJSONRpcRequestAsync(
  method: string,
  params: any[],
): Promise<any> {
  return provider.send(
    method,
    params,
  );
}
