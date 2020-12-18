import { Signer } from "ethers";

import {
  AirdropModule,
  AmmModule,
  BasicIssuanceModule,
  ClaimModule,
  GovernanceModule,
  IssuanceModule,
  NavIssuanceModule,
  SingleIndexModule,
  StakingModule,
  StreamingFeeModule,
  TradeModule,
  UniswapYieldStrategy,
  WrapModule
} from "../contracts";
import { Address } from "../types";

import { AirdropModuleFactory } from "../../typechain/AirdropModuleFactory";
import { AmmModuleFactory } from "../../typechain/AmmModuleFactory";
import { BasicIssuanceModuleFactory } from "../../typechain/BasicIssuanceModuleFactory";
import { ClaimModuleFactory } from "../../typechain/ClaimModuleFactory";
import { GovernanceModuleFactory } from "../../typechain/GovernanceModuleFactory";
import { IssuanceModuleFactory } from "../../typechain/IssuanceModuleFactory";
import { NavIssuanceModuleFactory } from "../../typechain/NavIssuanceModuleFactory";
import { SingleIndexModuleFactory } from "../../typechain/SingleIndexModuleFactory";
import { StakingModuleFactory } from "../../typechain/StakingModuleFactory";
import { StreamingFeeModuleFactory } from "../../typechain/StreamingFeeModuleFactory";
import { TradeModuleFactory } from "../../typechain/TradeModuleFactory";
import { UniswapYieldStrategyFactory } from "../../typechain/UniswapYieldStrategyFactory";
import { WrapModuleFactory } from "../../typechain/WrapModuleFactory";

export default class DeployModules {
  private _deployerSigner: Signer;

  constructor(deployerSigner: Signer) {
    this._deployerSigner = deployerSigner;
  }

  public async deployBasicIssuanceModule(controller: Address): Promise<BasicIssuanceModule> {
    return await new BasicIssuanceModuleFactory(this._deployerSigner).deploy(controller);
  }

  public async deployIssuanceModule(controller: Address): Promise<IssuanceModule> {
    return await new IssuanceModuleFactory(this._deployerSigner).deploy(controller);
  }

  public async deployAmmModule(controller: Address): Promise<AmmModule> {
    return await new AmmModuleFactory(this._deployerSigner).deploy(controller);
  }

  public async getBasicIssuanceModule(basicIssuanceModule: Address): Promise <BasicIssuanceModule> {
    return await new BasicIssuanceModuleFactory(this._deployerSigner).attach(basicIssuanceModule);
  }

  public async deployStreamingFeeModule(controller: Address): Promise<StreamingFeeModule> {
    return await new StreamingFeeModuleFactory(this._deployerSigner).deploy(controller);
  }

  public async getStreamingFeeModule(streamingFeeModule: Address): Promise <StreamingFeeModule> {
    return await new StreamingFeeModuleFactory(this._deployerSigner).attach(streamingFeeModule);
  }

  public async deployAirdropModule(controller: Address): Promise<AirdropModule> {
    return await new AirdropModuleFactory(this._deployerSigner).deploy(controller);
  }

  public async deployNavIssuanceModule(controller: Address, weth: Address): Promise<NavIssuanceModule> {
    return await new NavIssuanceModuleFactory(this._deployerSigner).deploy(controller, weth);
  }

  public async deployTradeModule(controller: Address): Promise<TradeModule> {
    return await new TradeModuleFactory(this._deployerSigner).deploy(controller);
  }

  public async deployWrapModule(controller: Address, weth: Address): Promise<WrapModule> {
    return await new WrapModuleFactory(this._deployerSigner).deploy(controller, weth);
  }

  public async deployClaimModule(controller: Address): Promise<ClaimModule> {
    return await new ClaimModuleFactory(this._deployerSigner).deploy(controller);
  }

  public async deployStakingModule(controller: Address): Promise<StakingModule> {
    return await new StakingModuleFactory(this._deployerSigner).deploy(controller);
  }

  public async deployUniswapYieldStrategy(
    _controller: Address,
    _uniswapRouter: Address,
    _lpToken: Address,
    _assetOne: Address,
    _assetTwo: Address,
    _uni: Address,
    _rewarder: Address,
    _feeRecipient: Address
  ): Promise<UniswapYieldStrategy> {
    return await new UniswapYieldStrategyFactory(this._deployerSigner).deploy(
      _controller,
      _uniswapRouter,
      _lpToken,
      _assetOne,
      _assetTwo,
      _uni,
      _rewarder,
      _feeRecipient
    );
  }

  public async getUniswapYieldStrategy(uniswapYieldStrategy: Address): Promise <UniswapYieldStrategy> {
    return await new UniswapYieldStrategyFactory(this._deployerSigner).attach(uniswapYieldStrategy);
  }

  public async getNavIssuanceModule(navIssuanceModule: Address): Promise <NavIssuanceModule> {
    return await new NavIssuanceModuleFactory(this._deployerSigner).attach(navIssuanceModule);
  }

  public async deploySingleIndexModule(
    controller: Address,
    weth: Address,
    uniswapRouter: Address,
    sushiswapRouter: Address,
    balancerProxy: Address
  ): Promise<SingleIndexModule> {
    return await new SingleIndexModuleFactory(this._deployerSigner).deploy(
      controller,
      weth,
      uniswapRouter,
      sushiswapRouter,
      balancerProxy,
    );
  }

  public async deployGovernanceModule(controller: Address): Promise<GovernanceModule> {
    return await new GovernanceModuleFactory(this._deployerSigner).deploy(controller);
  }
}
