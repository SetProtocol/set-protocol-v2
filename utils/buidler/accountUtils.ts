import { ethers } from "@nomiclabs/buidler";
import { BigNumber } from "ethers/utils";
import { Account, Address, Wallet } from "../types";

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

// Use the last wallet to ensure it has Ether
export const getRandomAccount = async (): Promise<Account> => {
  const accounts = await getAccounts();
  return accounts[accounts.length - 1];
};

export const getRandomAddress = async (): Promise<Address> => {
  const wallet = ethers.Wallet.createRandom().connect(provider);
  return await wallet.getAddress();
};

export const getEthBalance = async (account: Address): Promise<BigNumber> => {
  return await provider.getBalance(account);
};

// NOTE ethers.signers may be a buidler specific function
export const getWallets = async (): Promise<Wallet[]> => {
  return (await ethers.signers() as Wallet[]);
};
