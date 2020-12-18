import { Address } from "../types";
import { Signer } from "ethers";
import { BigNumberish, BigNumber } from "ethers/utils";

import {
  AaveLendingPoolCoreMock,
  AaveLendingPoolMock,
  AddressArrayUtilsMock,
  AmmAdapterMock,
  ClaimAdapterMock,
  ContractCallerMock,
  ExplicitErc20Mock,
  GaugeControllerMock,
  GodModeMock,
  GovernanceAdapterMock,
  InvokeMock,
  KyberNetworkProxyMock,
  ManagerIssuanceHookMock,
  ModuleIssuanceHookMock,
  ModuleBaseMock,
  NavIssuanceCaller,
  NavIssuanceHookMock,
  OneInchExchangeMock,
  OracleAdapterMock,
  OracleMock,
  PositionMock,
  PreciseUnitMathMock,
  ResourceIdentifierMock,
  StakingAdapterMock,
  StandardTokenMock,
  StandardTokenWithFeeMock,
  Uint256ArrayUtilsMock,
  WrapAdapterMock,
} from "../contracts";

import { ether } from "../common";

import { AaveLendingPoolCoreMockFactory } from "../../typechain/AaveLendingPoolCoreMockFactory";
import { AaveLendingPoolMockFactory } from "../../typechain/AaveLendingPoolMockFactory";
import { AddressArrayUtilsMockFactory } from "../../typechain/AddressArrayUtilsMockFactory";
import { AmmAdapterMockFactory } from "../../typechain/AmmAdapterMockFactory";
import { ClaimAdapterMockFactory } from "../../typechain/ClaimAdapterMockFactory";
import { ContractCallerMockFactory } from "../../typechain/ContractCallerMockFactory";
import { ExplicitErc20MockFactory } from "../../typechain/ExplicitErc20MockFactory";
import { GaugeControllerMockFactory } from "../../typechain/GaugeControllerMockFactory";
import { GodModeMockFactory } from "../../typechain/GodModeMockFactory";
import { GovernanceAdapterMockFactory } from "../../typechain/GovernanceAdapterMockFactory";
import { InvokeMockFactory } from "../../typechain/InvokeMockFactory";
import { KyberNetworkProxyMockFactory } from "../../typechain/KyberNetworkProxyMockFactory";
import { ManagerIssuanceHookMockFactory } from "../../typechain/ManagerIssuanceHookMockFactory";
import { ModuleBaseMockFactory } from "../../typechain/ModuleBaseMockFactory";
import { ModuleIssuanceHookMockFactory } from "../../typechain/ModuleIssuanceHookMockFactory";
import { NavIssuanceCallerFactory } from "../../typechain/NavIssuanceCallerFactory";
import { NavIssuanceHookMockFactory } from "../../typechain/NavIssuanceHookMockFactory";
import { OneInchExchangeMockFactory } from "../../typechain/OneInchExchangeMockFactory";
import { OracleAdapterMockFactory } from "../../typechain/OracleAdapterMockFactory";
import { OracleMockFactory } from "../../typechain/OracleMockFactory";
import { PositionMockFactory } from "../../typechain/PositionMockFactory";
import { PreciseUnitMathMockFactory } from "../../typechain/PreciseUnitMathMockFactory";
import { ResourceIdentifierMockFactory } from "../../typechain/ResourceIdentifierMockFactory";
import { StakingAdapterMockFactory } from "../../typechain/StakingAdapterMockFactory";
import { StandardTokenMockFactory } from "../../typechain/StandardTokenMockFactory";
import { StandardTokenWithFeeMockFactory } from "../../typechain/StandardTokenWithFeeMockFactory";
import { Uint256ArrayUtilsMockFactory } from "../../typechain/Uint256ArrayUtilsMockFactory";
import { WrapAdapterMockFactory } from "../../typechain/WrapAdapterMockFactory";

export default class DeployMocks {
  private _deployerSigner: Signer;

  constructor(deployerSigner: Signer) {
    this._deployerSigner = deployerSigner;
  }

  public async deployExplicitErc20Mock(): Promise<ExplicitErc20Mock> {
    return await new ExplicitErc20MockFactory(this._deployerSigner).deploy();
  }

  public async deployInvokeMock(): Promise<InvokeMock> {
    return await new InvokeMockFactory(this._deployerSigner).deploy();
  }

  public async deployManagerIssuanceHookMock(): Promise<ManagerIssuanceHookMock> {
    return await new ManagerIssuanceHookMockFactory(this._deployerSigner).deploy();
  }

  public async deployModuleIssuanceHookMock(): Promise<ModuleIssuanceHookMock> {
    return await new ModuleIssuanceHookMockFactory(this._deployerSigner).deploy();
  }

  public async deployNavIssuanceHookMock(): Promise<NavIssuanceHookMock> {
    return await new NavIssuanceHookMockFactory(this._deployerSigner).deploy();
  }

  public async deployNAVIssuanceCaller(navIssuanceModule: Address): Promise<NavIssuanceCaller> {
    return await new NavIssuanceCallerFactory(this._deployerSigner).deploy(navIssuanceModule);
  }

  public async deployAddressArrayUtilsMock(): Promise<AddressArrayUtilsMock> {
    return await new AddressArrayUtilsMockFactory(this._deployerSigner).deploy();
  }

  public async deployUint256ArrayUtilsMock(): Promise<Uint256ArrayUtilsMock> {
    return await new Uint256ArrayUtilsMockFactory(this._deployerSigner).deploy();
  }

  public async deployKyberNetworkProxyMock(mockWethAddress: Address): Promise<KyberNetworkProxyMock> {
    return await new KyberNetworkProxyMockFactory(this._deployerSigner).deploy(mockWethAddress);
  }

  public async deployModuleBaseMock(controllerAddress: Address): Promise<ModuleBaseMock> {
    return await new ModuleBaseMockFactory(this._deployerSigner).deploy(controllerAddress);
  }

  public async deployGodModeMock(controllerAddress: Address): Promise<GodModeMock> {
    return await new GodModeMockFactory(this._deployerSigner).deploy(controllerAddress);
  }

  public async deployGovernanceAdapterMock(initialProposalId: BigNumberish): Promise<GovernanceAdapterMock> {
    return await new GovernanceAdapterMockFactory(this._deployerSigner).deploy(initialProposalId);
  }

  public async deployOneInchExchangeMock(
    sendToken: Address,
    receiveToken: Address,
    sendQuantity: BigNumber,
    receiveQuantity: BigNumber,
  ): Promise<OneInchExchangeMock> {
    return await new OneInchExchangeMockFactory(this._deployerSigner).deploy(
      sendToken,
      receiveToken,
      sendQuantity,
      receiveQuantity,
    );
  }

  public async deployOracleMock(initialValue: BigNumberish): Promise<OracleMock> {
    return await new OracleMockFactory(this._deployerSigner).deploy(initialValue);
  }

  public async deployOracleAdapterMock(
    asset: Address,
    dummyPrice: BigNumber
  ): Promise<OracleAdapterMock> {
    return await new OracleAdapterMockFactory(this._deployerSigner).deploy(asset, dummyPrice);
  }

  public async deployPositionMock(): Promise<PositionMock> {
    return await new PositionMockFactory(this._deployerSigner).deploy();
  }

  public async deployPreciseUnitMathMock(): Promise<PreciseUnitMathMock> {
    return await new PreciseUnitMathMockFactory(this._deployerSigner).deploy();
  }

  public async deployResourceIdentifierMock(): Promise<ResourceIdentifierMock> {
    return await new ResourceIdentifierMockFactory(this._deployerSigner).deploy();
  }

  public async deployStakingAdapterMock(stakingAsset: Address): Promise<StakingAdapterMock> {
    return await new StakingAdapterMockFactory(this._deployerSigner)
      .deploy(stakingAsset);
  }

  public async deployTokenMock(
    initialAccount: Address,
    initialBalance: BigNumberish = ether(1000000000),
    decimals: BigNumberish = 18,
    name: string = "Token",
    symbol: string = "Symbol"
  ): Promise<StandardTokenMock> {
    return await new StandardTokenMockFactory(this._deployerSigner)
      .deploy(initialAccount, initialBalance, name, symbol, decimals);
  }

  public async deployTokenWithFeeMock(
    initialAccount: Address,
    initialBalance: BigNumberish = ether(1000000000),
    fee: BigNumberish = ether(0.1),
    name: string = "Token",
    symbol: string = "Symbol"
  ): Promise<StandardTokenWithFeeMock> {
    return await new StandardTokenWithFeeMockFactory(this._deployerSigner)
      .deploy(initialAccount, initialBalance, name, symbol, fee);
  }

  public async deployAmmAdapterMock(_underlyingTokens: Address[]): Promise<AmmAdapterMock> {
    return await new AmmAdapterMockFactory(this._deployerSigner).deploy(_underlyingTokens);
  }

  public async deployWrapAdapterMock(): Promise<WrapAdapterMock> {
    return await new WrapAdapterMockFactory(this._deployerSigner).deploy();
  }

  public async deployAaveLendingPoolCoreMock(): Promise<AaveLendingPoolCoreMock> {
    return await new AaveLendingPoolCoreMockFactory(this._deployerSigner).deploy();
  }

  public async deployAaveLendingPoolMock(aaveLendingPoolCore: Address): Promise<AaveLendingPoolMock> {
    return await new AaveLendingPoolMockFactory(this._deployerSigner).deploy(aaveLendingPoolCore);
  }

  public async deployClaimAdapterMock(): Promise<ClaimAdapterMock> {
    return await new ClaimAdapterMockFactory(this._deployerSigner).deploy();
  }

  public async deployGaugeControllerMock(): Promise<GaugeControllerMock> {
    return await new GaugeControllerMockFactory(this._deployerSigner).deploy();
  }

  public async deployContractCallerMock(): Promise<ContractCallerMock> {
    return await new ContractCallerMockFactory(this._deployerSigner).deploy();
  }

  /*************************************
   * Instance getters
   ************************************/

  public async getTokenMock(token: Address): Promise<StandardTokenMock> {
    return await new StandardTokenMockFactory(this._deployerSigner).attach(token);
  }
}
