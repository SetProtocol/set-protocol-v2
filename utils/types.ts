import { BigNumber } from "ethers";
import {
  ContractTransaction as ContractTransactionType,
  Wallet as WalletType
} from "ethers";

export type Address = string;
export type Bytes = string;

export type Position = {
  component: Address;
  module: Address;
  unit: BigNumber;
  positionState: number;
  data: string;
};

export type ContractTransaction = ContractTransactionType;
export type Wallet = WalletType;

export interface StreamingFeeState {
  feeRecipient: Address;
  streamingFeePercentage: BigNumber;
  maxStreamingFeePercentage: BigNumber;
  lastStreamingFeeTimestamp: BigNumber;
}

export interface AirdropSettings {
  airdrops: Address[];
  feeRecipient: Address;
  airdropFee: BigNumber;
  anyoneAbsorb: boolean;
}

export interface NAVIssuanceSettings {
  managerIssuanceHook: Address;
  managerRedemptionHook: Address;
  reserveAssets: Address[];
  feeRecipient: Address;
  managerFees: [BigNumber, BigNumber];
  maxManagerFee: BigNumber;
  premiumPercentage: BigNumber;
  maxPremiumPercentage: BigNumber;
  minSetTokenSupply: BigNumber;
}

export interface CustomOracleNAVIssuanceSettings extends NAVIssuanceSettings {
  setValuer: Address;
}
