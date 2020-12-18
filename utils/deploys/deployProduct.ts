import { Signer } from "ethers";
import { BigNumber } from "ethers/utils";

import { UniswapYieldHook } from "../contracts";
import { AssetLimitHook } from "../contracts";

import { UniswapYieldHookFactory } from "../../typechain/UniswapYieldHookFactory";
import { AssetLimitHookFactory } from "../../typechain/AssetLimitHookFactory";
import { Address } from "@utils/types";

export default class DeployProduct {
  private _deployerSigner: Signer;

  constructor(deployerSigner: Signer) {
    this._deployerSigner = deployerSigner;
  }

  public async deployUniswapYieldHook(
    _assets: Address[],
    _limits: BigNumber[]
  ): Promise<UniswapYieldHook> {
    return await new UniswapYieldHookFactory(this._deployerSigner).deploy(_assets, _limits);
  }

  public async deployAssetLimitHook(
    _assets: Address[],
    _limits: BigNumber[]
  ): Promise<AssetLimitHook> {
    return await new AssetLimitHookFactory(this._deployerSigner).deploy(_assets, _limits);
  }

  public async getAssetLimitHook(assetLimitHookAddress: Address): Promise<AssetLimitHook> {
    return await new AssetLimitHookFactory(this._deployerSigner).attach(assetLimitHookAddress);
  }
}