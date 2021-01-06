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

import { AirdropModule__factory } from "../../typechain/factories/AirdropModule__factory";
import { AmmModule__factory } from "../../typechain/factories/AmmModule__factory";
import { BasicIssuanceModule__factory } from "../../typechain/factories/BasicIssuanceModule__factory";
import { ClaimModule__factory } from "../../typechain/factories/ClaimModule__factory";
import { GovernanceModule__factory } from "../../typechain/factories/GovernanceModule__factory";
import { IssuanceModule__factory } from "../../typechain/factories/IssuanceModule__factory";
import { NavIssuanceModule__factory } from "../../typechain/factories/NavIssuanceModule__factory";
import { SingleIndexModule__factory } from "../../typechain/factories/SingleIndexModule__factory";
import { StakingModule__factory } from "../../typechain/factories/StakingModule__factory";
import { StreamingFeeModule__factory } from "../../typechain/factories/StreamingFeeModule__factory";
import { TradeModule__factory } from "../../typechain/factories/TradeModule__factory";
import { UniswapYieldStrategy__factory } from "../../typechain/factories/UniswapYieldStrategy__factory";
import { WrapModule__factory } from "../../typechain/factories/WrapModule__factory";

export default class DeployModules {
  private _deployerSigner: Signer;

  constructor(deployerSigner: Signer) {
    this._deployerSigner = deployerSigner;
  }

  public async deployBasicIssuanceModule(controller: Address): Promise<BasicIssuanceModule> {
    return await new BasicIssuanceModule__factory(this._deployerSigner).deploy(controller);
  }

  public async deployIssuanceModule(controller: Address): Promise<IssuanceModule> {
    return await new IssuanceModule__factory(this._deployerSigner).deploy(controller);
  }

  public async deployAmmModule(controller: Address): Promise<AmmModule> {
    return await new AmmModule__factory(this._deployerSigner).deploy(controller);
  }

  public async getBasicIssuanceModule(basicIssuanceModule: Address): Promise <BasicIssuanceModule> {
    return await new BasicIssuanceModule__factory(this._deployerSigner).attach(basicIssuanceModule);
  }

  public async deployStreamingFeeModule(controller: Address): Promise<StreamingFeeModule> {
    return await new StreamingFeeModule__factory(this._deployerSigner).deploy(controller);
  }

  public async getStreamingFeeModule(streamingFeeModule: Address): Promise <StreamingFeeModule> {
    return await new StreamingFeeModule__factory(this._deployerSigner).attach(streamingFeeModule);
  }

  public async deployAirdropModule(controller: Address): Promise<AirdropModule> {
    return await new AirdropModule__factory(this._deployerSigner).deploy(controller);
  }

  public async deployNavIssuanceModule(controller: Address, weth: Address): Promise<NavIssuanceModule> {
    return await new NavIssuanceModule__factory(this._deployerSigner).deploy(controller, weth);
  }

  public async deployTradeModule(controller: Address): Promise<TradeModule> {
    return await new TradeModule__factory(this._deployerSigner).deploy(controller);
  }

  public async deployWrapModule(controller: Address, weth: Address): Promise<WrapModule> {
    return await new WrapModule__factory(this._deployerSigner).deploy(controller, weth);
  }

  public async deployClaimModule(controller: Address): Promise<ClaimModule> {
    return await new ClaimModule__factory(this._deployerSigner).deploy(controller);
  }

  public async deployStakingModule(controller: Address): Promise<StakingModule> {
    return await new StakingModule__factory(this._deployerSigner).deploy(controller);
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
    return await new UniswapYieldStrategy__factory(this._deployerSigner).deploy(
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
    return await new UniswapYieldStrategy__factory(this._deployerSigner).attach(uniswapYieldStrategy);
  }

  public async getNavIssuanceModule(navIssuanceModule: Address): Promise <NavIssuanceModule> {
    return await new NavIssuanceModule__factory(this._deployerSigner).attach(navIssuanceModule);
  }

  public async deploySingleIndexModule(
    controller: Address,
    weth: Address,
    uniswapRouter: Address,
    sushiswapRouter: Address,
    balancerProxy: Address
  ): Promise<SingleIndexModule> {
    return await new SingleIndexModule__factory(this._deployerSigner).deploy(
      controller,
      weth,
      uniswapRouter,
      sushiswapRouter,
      balancerProxy,
    );
  }

  public async deployGovernanceModule(controller: Address): Promise<GovernanceModule> {
    return await new GovernanceModule__factory(this._deployerSigner).deploy(controller);
  }
}
