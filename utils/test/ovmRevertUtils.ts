// Revert reason handling for Optimism Client
// ==========================================
// When geth was forked for Optimistic Ethereum, the geth client had not
// yet started returning revert reasons for eth_sendRawTransactions.
//
// Borrowed and adapted (via optimism docs) from Synthetix

import ethers, { ContractTransaction } from "ethers";
import { Provider } from "@ethersproject/providers";
import { Address } from "../types";
import { getWaffleExpect } from "./testingUtils";

const expect = getWaffleExpect();

type TxRequest = {
  to: Address,
  data: string,
};

function _hexToString(hex: string): string {
  let str = "";

  const terminator = "**zÛ";
  for (let i = 0; i < hex.length; i += 2) {
    str += String.fromCharCode(parseInt(hex.substr(i, 2), 16));

    if (str.includes(terminator)) {
      break;
    }
  }

  return str.substring(0, str.length - 4);
}

// Fetches revert reason by replaying tx as call
export async function getOVMRevertReason(tx: TxRequest, provider: Provider) {
  try {
    const code = (await provider.call(tx)).substr(138);
    const hex = `0x${code}`;

    let reason;
    if (code.length === 64) {
      reason = ethers.utils.parseBytes32String(hex);
    } else {
      reason = _hexToString(hex);
    }

    return reason;
  } catch (suberror) {
    throw new Error(`Unable to parse revert reason: ${suberror}`);
  }
}

// Revert handler for OVM/EVM
export async function assertRevertOVM(
  tx: Promise<ContractTransaction>,
  reason: string,
  provider: Provider
) {
  let receipt;
  // tslint:disable-next-line
  let revertReason = "";

  // Handle normally if Hardhat EVM
  if (process.env.HARDHAT_EVM) {
    await expect(tx).to.be.revertedWith(reason);
    return;
  }

  // OVM
  try {
    const response = await tx;
    receipt = await response.wait();
  } catch (error) {

    // tslint:disable-next-line
    const txRequest = {
      to: await error.transaction.to,
      data: await error.transaction.data,
    };

    // Temporarily disable reason checking for OVM because reasons not available (until 0.3.0)
    // See https://github.com/ethereum-optimism/optimism/issues/474
    //
    // revertReason = await getOptimismRevertReason(txRequest, provider );
  }

  if (receipt) {
    throw new Error(`Transaction was expected to revert with "${reason}", but it did not revert.`);
  } else {

    // if (!revertReason.includes(reason)) {
    //  throw new Error(
    //    `Transaction was expected to revert with "${reason}", `  +
    //    `but it reverted with "${revertReason}" instead.`
    //  );
    // }
  }
}
