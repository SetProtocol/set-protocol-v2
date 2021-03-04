import { Signer } from "ethers";

import {
  AaveGovernanceAdapter,
  CompoundLikeGovernanceAdapter,
  CurveStakingAdapter,
  KyberExchangeAdapter,
  OneInchExchangeAdapter,
  AaveMigrationWrapAdapter,
  AaveWrapAdapter,
  UniswapPairPriceAdapter,
  UniswapV2ExchangeAdapter,
  ZeroExApiAdapter,
} from "../contracts";

import { Address, Bytes } from "./../types";

import { AaveGovernanceAdapter__factory } from "../../typechain/factories/AaveGovernanceAdapter__factory";
import { CompoundLikeGovernanceAdapter__factory } from "../../typechain/factories/CompoundLikeGovernanceAdapter__factory";
import { CurveStakingAdapter__factory } from "../../typechain/factories/CurveStakingAdapter__factory";
import { KyberExchangeAdapter__factory } from "../../typechain/factories/KyberExchangeAdapter__factory";
import { OneInchExchangeAdapter__factory } from "../../typechain/factories/OneInchExchangeAdapter__factory";
import { ZeroExApiAdapter__factory } from "../../typechain/factories/ZeroExApiAdapter__factory";
import { AaveMigrationWrapAdapter__factory } from "../../typechain/factories/AaveMigrationWrapAdapter__factory";
import { AaveWrapAdapter__factory } from "../../typechain/factories/AaveWrapAdapter__factory";
import { UniswapPairPriceAdapter__factory } from "../../typechain/factories/UniswapPairPriceAdapter__factory";
import { UniswapV2ExchangeAdapter__factory } from "../../typechain/factories/UniswapV2ExchangeAdapter__factory";

export default class DeployAdapters {
  private _deployerSigner: Signer;

  constructor(deployerSigner: Signer) {
    this._deployerSigner = deployerSigner;
  }

  public async deployKyberExchangeAdapter(kyberNetworkProxy: Address): Promise<KyberExchangeAdapter> {
    return await new KyberExchangeAdapter__factory(this._deployerSigner).deploy(kyberNetworkProxy);
  }

  public async deployOneInchExchangeAdapter(
    approveAddress: Address,
    exchangeAddress: Address,
    swapFunctionSignature: Bytes
  ): Promise<OneInchExchangeAdapter> {
    return await new OneInchExchangeAdapter__factory(this._deployerSigner).deploy(
      approveAddress,
      exchangeAddress,
      swapFunctionSignature
    );
  }

  public async deployUniswapV2ExchangeAdapter(uniswapV2Router: Address): Promise<UniswapV2ExchangeAdapter> {
    return await new UniswapV2ExchangeAdapter__factory(this._deployerSigner).deploy(uniswapV2Router);
  }

  public async deployAaveGovernanceAdapter(aaveProtoGovernance: Address, aaveToken: Address): Promise<AaveGovernanceAdapter> {
    return await new AaveGovernanceAdapter__factory(this._deployerSigner).deploy(aaveProtoGovernance, aaveToken);
  }

  public async deployAaveMigrationWrapAdapter(
    aaveMigrationProxy: Address,
    lendToken: Address,
    aaveToken: Address
  ): Promise<AaveMigrationWrapAdapter> {
    return await new AaveMigrationWrapAdapter__factory(this._deployerSigner).deploy(aaveMigrationProxy, lendToken, aaveToken);
  }

  public async deployAaveWrapAdapter(aaveLendingPool: Address): Promise<AaveWrapAdapter> {
    return await new AaveWrapAdapter__factory(this._deployerSigner).deploy(aaveLendingPool);
  }

  public async deployCompoundLikeGovernanceAdapter(governanceAlpha: Address, governanceToken: Address): Promise<CompoundLikeGovernanceAdapter> {
    return await new CompoundLikeGovernanceAdapter__factory(this._deployerSigner).deploy(governanceAlpha, governanceToken);
  }

  public async deployCurveStakingAdapter(gaugeController: Address): Promise<CurveStakingAdapter> {
    return await new CurveStakingAdapter__factory(this._deployerSigner).deploy(gaugeController);
  }

  public async deployUniswapPairPriceAdapter(
    controller: Address,
    uniswapFactory: Address,
    uniswapPools: Address[]
  ): Promise<UniswapPairPriceAdapter> {
    return await new UniswapPairPriceAdapter__factory(this._deployerSigner).deploy(controller, uniswapFactory, uniswapPools);
  }

  public async getUniswapPairPriceAdapter(uniswapAdapterAddress: Address): Promise<UniswapPairPriceAdapter> {
    return await new UniswapPairPriceAdapter__factory(this._deployerSigner).attach(uniswapAdapterAddress);
  }

  public async deployZeroExApiAdapter(zeroExAddress: Address): Promise<ZeroExApiAdapter> {
    return await new ZeroExApiAdapter__factory(this._deployerSigner).deploy(zeroExAddress);
  }
}
