import { Signer } from "ethers";
import { BigNumber } from "@ethersproject/bignumber";

import { UniswapYieldHook } from "../contracts";
import { AssetLimitHook } from "../contracts";

import { UniswapYieldHook__factory } from "../../typechain/factories/UniswapYieldHook__factory";
import { AssetLimitHook__factory } from "../../typechain/factories/AssetLimitHook__factory";
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
    return await new UniswapYieldHook__factory(this._deployerSigner).deploy(_assets, _limits);
  }

  public async deployAssetLimitHook(
    _assets: Address[],
    _limits: BigNumber[]
  ): Promise<AssetLimitHook> {
    return await new AssetLimitHook__factory(this._deployerSigner).deploy(_assets, _limits);
  }

  public async getAssetLimitHook(assetLimitHookAddress: Address): Promise<AssetLimitHook> {
    return await new AssetLimitHook__factory(this._deployerSigner).attach(assetLimitHookAddress);
  }
}