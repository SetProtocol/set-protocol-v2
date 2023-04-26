import { Signer } from "ethers";
import { BigNumber } from "ethers";

import {
  APYRescue,
  AssetLimitHook,
  AMMSplitter,
  TokenEnabler
} from "../contracts";

import { APYRescue__factory } from "../../typechain/factories/APYRescue__factory";
import { AssetLimitHook__factory } from "../../typechain/factories/AssetLimitHook__factory";
import { AMMSplitter__factory } from "../../typechain/factories/AMMSplitter__factory";
import { TokenEnabler__factory } from "../../typechain/factories/TokenEnabler__factory";
import { Address } from "../types";

export default class DeployProduct {
  private _deployerSigner: Signer;

  constructor(deployerSigner: Signer) {
    this._deployerSigner = deployerSigner;
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

  public async deployAMMSplitter(
    uniRouter: Address,
    sushiRouter: Address,
    uniFactory: Address,
    sushiFactory: Address
  ): Promise<AMMSplitter> {
    return await new AMMSplitter__factory(this._deployerSigner).deploy(uniRouter, sushiRouter, uniFactory, sushiFactory);
  }

  public deployAPYRescue(
    apyToken: Address,
    recoveredTokens: Address[],
    basicIssuanceModule: Address
  ): Promise<APYRescue> {
    return new APYRescue__factory(this._deployerSigner).deploy(apyToken, recoveredTokens, basicIssuanceModule);
  }

  public deployTokenEnabler(
    controller: Address,
    tokensToEnable: Address[]
  ): Promise<TokenEnabler> {
    return new TokenEnabler__factory(this._deployerSigner).deploy(controller, tokensToEnable);
  }
}
