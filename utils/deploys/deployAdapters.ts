import { Signer } from "ethers";

import {
  AaveGovernanceAdapter,
  AaveGovernanceV2Adapter,
  BalancerV1IndexExchangeAdapter,
  CompoundLikeGovernanceAdapter,
  CurveStakingAdapter,
  KyberExchangeAdapter,
  OneInchExchangeAdapter,
  AaveMigrationWrapAdapter,
  AaveWrapAdapter,
  CompoundWrapAdapter,
  YearnWrapAdapter,
  UniswapPairPriceAdapter,
  UniswapV2ExchangeAdapter,
  UniswapV2ExchangeAdapterV2,
  UniswapV2IndexExchangeAdapter,
  UniswapV2TransferFeeExchangeAdapter,
  ZeroExApiAdapter,
  SnapshotGovernanceAdapter,
  SynthetixExchangeAdapter,
  CompoundBravoGovernanceAdapter
} from "../contracts";
import { convertLibraryNameToLinkId } from "../common";
import { Address, Bytes } from "./../types";

import { AaveGovernanceAdapter__factory } from "../../typechain/factories/AaveGovernanceAdapter__factory";
import { AaveGovernanceV2Adapter__factory } from "../../typechain/factories/AaveGovernanceV2Adapter__factory";
import { BalancerV1IndexExchangeAdapter__factory } from "../../typechain/factories/BalancerV1IndexExchangeAdapter__factory";
import { CompoundLikeGovernanceAdapter__factory } from "../../typechain/factories/CompoundLikeGovernanceAdapter__factory";
import { CurveStakingAdapter__factory } from "../../typechain/factories/CurveStakingAdapter__factory";
import { KyberExchangeAdapter__factory } from "../../typechain/factories/KyberExchangeAdapter__factory";
import { OneInchExchangeAdapter__factory } from "../../typechain/factories/OneInchExchangeAdapter__factory";
import { ZeroExApiAdapter__factory } from "../../typechain/factories/ZeroExApiAdapter__factory";
import { AaveMigrationWrapAdapter__factory } from "../../typechain/factories/AaveMigrationWrapAdapter__factory";
import { AaveWrapAdapter__factory } from "../../typechain/factories/AaveWrapAdapter__factory";
import { CompoundWrapAdapter__factory } from "../../typechain/factories/CompoundWrapAdapter__factory";
import { YearnWrapAdapter__factory } from "../../typechain/factories/YearnWrapAdapter__factory";
import { UniswapPairPriceAdapter__factory } from "../../typechain/factories/UniswapPairPriceAdapter__factory";
import { UniswapV2ExchangeAdapter__factory } from "../../typechain/factories/UniswapV2ExchangeAdapter__factory";
import { UniswapV2TransferFeeExchangeAdapter__factory } from "../../typechain/factories/UniswapV2TransferFeeExchangeAdapter__factory";
import { UniswapV2ExchangeAdapterV2__factory } from "../../typechain/factories/UniswapV2ExchangeAdapterV2__factory";
import { UniswapV2IndexExchangeAdapter__factory } from "../../typechain/factories/UniswapV2IndexExchangeAdapter__factory";
import { SnapshotGovernanceAdapter__factory } from "../../typechain/factories/SnapshotGovernanceAdapter__factory";
import { SynthetixExchangeAdapter__factory } from "../../typechain/factories/SynthetixExchangeAdapter__factory";
import { CompoundBravoGovernanceAdapter__factory } from "../../typechain/factories/CompoundBravoGovernanceAdapter__factory";

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

  public async deployUniswapV2TransferFeeExchangeAdapter(uniswapV2Router: Address): Promise<UniswapV2TransferFeeExchangeAdapter> {
    return await new UniswapV2TransferFeeExchangeAdapter__factory(this._deployerSigner).deploy(uniswapV2Router);
  }

  public async deployUniswapV2ExchangeAdapterV2(uniswapV2Router: Address): Promise<UniswapV2ExchangeAdapterV2> {
    return await new UniswapV2ExchangeAdapterV2__factory(this._deployerSigner).deploy(uniswapV2Router);
  }

  public async deployUniswapV2IndexExchangeAdapter(uniswapV2Router: Address): Promise<UniswapV2IndexExchangeAdapter> {
    return await new UniswapV2IndexExchangeAdapter__factory(this._deployerSigner).deploy(uniswapV2Router);
  }

  public async deployAaveGovernanceAdapter(aaveProtoGovernance: Address, aaveToken: Address): Promise<AaveGovernanceAdapter> {
    return await new AaveGovernanceAdapter__factory(this._deployerSigner).deploy(aaveProtoGovernance, aaveToken);
  }

  public async deployAaveGovernanceV2Adapter(aaveGovernanceV2: Address, aaveToken: Address): Promise<AaveGovernanceV2Adapter> {
    return await new AaveGovernanceV2Adapter__factory(this._deployerSigner).deploy(aaveGovernanceV2, aaveToken);
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

  public async deployCompoundWrapAdapter(libraryName: string, libraryAddress: Address): Promise<CompoundWrapAdapter> {
    const linkId = convertLibraryNameToLinkId(libraryName);
    return await new CompoundWrapAdapter__factory(
       // @ts-ignore
      {
        [linkId]: libraryAddress,
      },
      this._deployerSigner
    ).deploy();
  }

  public async deployYearnWrapAdapter(): Promise<YearnWrapAdapter> {
    return await new YearnWrapAdapter__factory(this._deployerSigner).deploy();
  }

  public async deployBalancerV1IndexExchangeAdapter(balancerProxy: Address): Promise<BalancerV1IndexExchangeAdapter> {
    return await new BalancerV1IndexExchangeAdapter__factory(this._deployerSigner).deploy(balancerProxy);
  }

  public async deployCompoundLikeGovernanceAdapter(governanceAlpha: Address, governanceToken: Address): Promise<CompoundLikeGovernanceAdapter> {
    return await new CompoundLikeGovernanceAdapter__factory(this._deployerSigner).deploy(governanceAlpha, governanceToken);
  }

  public async deployCompoundBravoGovernanceAdapter(governorBravo: Address, governanceToken: Address): Promise<CompoundBravoGovernanceAdapter> {
    return await new CompoundBravoGovernanceAdapter__factory(this._deployerSigner).deploy(governorBravo, governanceToken);
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

  public async deploySnapshotGovernanceAdapter(delegateRegistry: Address): Promise<SnapshotGovernanceAdapter> {
    return await new SnapshotGovernanceAdapter__factory(this._deployerSigner).deploy(delegateRegistry);
  }

  public async deploySynthetixExchangeAdapter(
    synthetixExchangerAddress: Address,
  ): Promise<SynthetixExchangeAdapter> {
    return await new SynthetixExchangeAdapter__factory(this._deployerSigner).deploy(
      synthetixExchangerAddress
    );
  }
}
