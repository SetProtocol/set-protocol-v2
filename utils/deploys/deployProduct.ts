import { Signer } from "ethers";
import { BigNumber } from "@ethersproject/bignumber";
import { Address } from "@utils/types";

import {
  UniswapYieldHook,
  AssetLimitHook,
  AMMSplitter,
  LeverageTokenExchangeIssuance
} from "../contracts";

import { UniswapYieldHook__factory } from "../../typechain/factories/UniswapYieldHook__factory";
import { AssetLimitHook__factory } from "../../typechain/factories/AssetLimitHook__factory";
import { AMMSplitter__factory } from "../../typechain/factories/AMMSplitter__factory";
import { LeverageTokenExchangeIssuance__factory  } from "../../typechain/factories/LeverageTokenExchangeIssuance__factory";

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

  public async deployAMMSplitter(
    uniRouter: Address,
    sushiRouter: Address,
    uniFactory: Address,
    sushiFactory: Address
  ): Promise<AMMSplitter> {
    return await new AMMSplitter__factory(this._deployerSigner).deploy(uniRouter, sushiRouter, uniFactory, sushiFactory);
  }

  public async deployLeverageTokenExchangeIssuance(
    _debtIssuanceModule: Address,
    _compLeverageModule: Address,
    _aaveLeverageModule: Address,
    _aaveLendingPool: Address,
    _cEth: Address,
    _weth: Address
  ): Promise<LeverageTokenExchangeIssuance> {
    return await new LeverageTokenExchangeIssuance__factory(this._deployerSigner).deploy(
      _debtIssuanceModule,
      _compLeverageModule,
      _aaveLeverageModule,
      _aaveLendingPool,
      _cEth,
      _weth
    );
  }
}