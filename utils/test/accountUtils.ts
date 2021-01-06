import { ethers } from "hardhat";
import { BigNumber } from "@ethersproject/bignumber";
import { Account, Address } from "../types";
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/dist/src/signer-with-address";

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

// NOTE ethers.signers may be a hardhat specific function
export const getWallets = async (): Promise<SignerWithAddress[]> => {
  return (await ethers.getSigners() as SignerWithAddress[]);
};
