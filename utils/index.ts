// These utils will be provider-aware of the buidler interface
import { ethers } from "@nomiclabs/buidler";
import { Address } from "./types";

import {
  AaveFixture,
  BalancerFixture,
  CompoundFixture,
  CurveFixture,
  MakerFixture,
  SystemFixture,
  UniswapFixture
} from "./fixtures";
import { Blockchain, ProtocolUtils } from "./common";

// Buidler-Provider Aware Exports
const provider = ethers.provider;
export const getSystemFixture = (ownerAddress: Address) => new SystemFixture(provider, ownerAddress);
export const getProtocolUtils = () => new ProtocolUtils(provider);
export const getBlockchainUtils = () => new Blockchain(provider);
export const getAaveFixture = (ownerAddress: Address) => new AaveFixture(provider, ownerAddress);
export const getBalancerFixture = (ownerAddress: Address) => new BalancerFixture(provider, ownerAddress);
export const getCurveFixture = (ownerAddress: Address) => new CurveFixture(provider, ownerAddress);
export const getCompoundFixture = (ownerAddress: Address) => new CompoundFixture(provider, ownerAddress);
export const getMakerFixture = (ownerAddress: Address) => new MakerFixture(provider, ownerAddress);
export const getUniswapFixture = (ownerAddress: Address) => new UniswapFixture(provider, ownerAddress);

export {
  addressToData,
  bigNumberToData,
  bitcoin,
  calculateEngageQuantities,
  calculateLPTokensIssued,
  calculateRebalanceFlows,
  calculateRebalanceQuantity,
  calculateTokensInReserve,
  divDown,
  ether,
  getExpectedIssuePositionMultiplier,
  getExpectedIssuePositionUnit,
  getExpectedPostFeeQuantity,
  getPostFeePositionUnits,
  getExpectedSetTokenIssueQuantity,
  getExpectedReserveRedeemQuantity,
  getExpectedRedeemPositionMultiplier,
  getExpectedRedeemPositionUnit,
  getReservesSafe,
  getStreamingFee,
  getStreamingFeeInflationAmount,
  gWei,
  hashAdapterName,
  min,
  preciseDiv,
  preciseDivCeil,
  preciseMul,
  preciseMulCeil,
  preciseMulCeilInt,
  preciseDivCeilInt,
  usdc,
} from "./common";
export {
  getAccounts,
  getEthBalance,
  getLastBlockTimestamp,
  getProvider,
  getTransactionTimestamp,
  getWaffleExpect,
  addSnapshotBeforeRestoreAfterEach,
  getRandomAccount,
  getRandomAddress,
  increaseTimeAsync,
  mineBlockAsync,
} from "./buidler";
