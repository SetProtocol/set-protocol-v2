import { ethers } from "hardhat";
import { BigNumber } from "@ethersproject/bignumber";
import { Address } from "../types";
import { Account } from "./types";
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/dist/src/signer-with-address";
import { IERC20__factory } from "../../typechain/factories/IERC20__factory";
import { OPTIMISM_WETH_ADDRESS } from "../constants";

const provider = ethers.provider;

export const getAccounts = async (): Promise<Account[]> => {
  const accounts: Account[] = [];

  const wallets = await getWallets();
  for (let i = 0; i < wallets.length; i++) {
    accounts.push({
      wallet: wallets[i],
      address: await wallets[i].getAddress(),
    });
  }

  return accounts;
};

export const getOptimismAccounts = async (): Promise<Account[]> => {
  const accounts: Account[] = [];

  const wallets = await getWallets();
  for (let i = 0; i < wallets.length; i++) {
    // Account #1 is empty on L2 because unfunded on L1.
    // It's the sequencer's wallet
    if (i === 1) continue;

    accounts.push({
      wallet: wallets[i],
      address: await wallets[i].getAddress(),
    });
  }

  return accounts;
};

// Use the last wallet to ensure it has Ether
export const getRandomAccount = async (): Promise<Account> => {
  const accounts = await getAccounts();
  return accounts[accounts.length - 1];
};

export const getWethBalance = async (signer: SignerWithAddress, account: Address): Promise<BigNumber> => {
  const weth = await IERC20__factory.connect(OPTIMISM_WETH_ADDRESS, signer);
  return await weth.balanceOf(account);
};

export const transferWeth = async (from: SignerWithAddress, to: Address, amount: BigNumber) => {
  const weth = await IERC20__factory.connect(OPTIMISM_WETH_ADDRESS, from);
  return await weth.transfer(to, amount, { gasLimit: 8000000});
};

export const getEthBalance = async (account: Address): Promise<BigNumber> => {
  return await provider.getBalance(account);
};

// NOTE ethers.signers may be a hardhat specific function
export const getWallets = async (): Promise<SignerWithAddress[]> => {
  return (await ethers.getSigners() as SignerWithAddress[]);
};
