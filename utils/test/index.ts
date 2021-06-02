// These utils will be provider-aware of the hardhat interface
import { ethers } from "hardhat";
import { Address } from "../types";

import { AaveFixture, BalancerFixture, CompoundFixture, CurveFixture, SystemFixture, UniswapFixture, YearnFixture } from "../fixtures";
import { Blockchain, ProtocolUtils } from "../common";
import { UniswapV3Fixture } from "@utils/fixtures/uniswapV3Fixture";

// Hardhat-Provider Aware Exports
const provider = ethers.provider;
export const getSystemFixture = (ownerAddress: Address) => new SystemFixture(provider, ownerAddress);
export const getProtocolUtils = () => new ProtocolUtils(provider);
export const getBlockchainUtils = () => new Blockchain(provider);
export const getAaveFixture = (ownerAddress: Address) => new AaveFixture(provider, ownerAddress);
export const getBalancerFixture = (ownerAddress: Address) => new BalancerFixture(provider, ownerAddress);
export const getCurveFixture = (ownerAddress: Address) => new CurveFixture(provider, ownerAddress);
export const getCompoundFixture = (ownerAddress: Address) => new CompoundFixture(provider, ownerAddress);
export const getUniswapFixture = (ownerAddress: Address) => new UniswapFixture(provider, ownerAddress);
export const getYearnFixture = (ownerAddress: Address) => new YearnFixture(provider, ownerAddress);
export const getUniswapV3Fixture = (ownerAddress: Address) => new UniswapV3Fixture(provider, ownerAddress);

export {
  getAccounts,
  getEthBalance,
  getRandomAccount,
} from "./accountUtils";
export {
  addSnapshotBeforeRestoreAfterEach,
  getLastBlockTimestamp,
  getProvider,
  getTransactionTimestamp,
  getWaffleExpect,
  increaseTimeAsync,
  mineBlockAsync,
  cacheBeforeEach
} from "./testingUtils";
export {
  getRandomAddress
} from "../common";
