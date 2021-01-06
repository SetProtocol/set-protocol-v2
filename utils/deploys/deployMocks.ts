import { Address } from "../types";
import { Signer } from "ethers";
import { BigNumberish, BigNumber } from "@ethersproject/bignumber";

import {
  AaveLendingPoolCoreMock,
  AaveLendingPoolMock,
  AddressArrayUtilsMock,
  AmmAdapterMock,
  ClaimAdapterMock,
  ContractCallerMock,
  ExplicitERC20Mock,
  GaugeControllerMock,
  GodModeMock,
  GovernanceAdapterMock,
  InvokeMock,
  KyberNetworkProxyMock,
  ManagerIssuanceHookMock,
  ModuleIssuanceHookMock,
  ModuleBaseMock,
  NAVIssuanceCaller,
  NAVIssuanceHookMock,
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

import { AaveLendingPoolCoreMock__factory } from "../../typechain/factories/AaveLendingPoolCoreMock__factory";
import { AaveLendingPoolMock__factory } from "../../typechain/factories/AaveLendingPoolMock__factory";
import { AddressArrayUtilsMock__factory } from "../../typechain/factories/AddressArrayUtilsMock__factory";
import { AmmAdapterMock__factory } from "../../typechain/factories/AmmAdapterMock__factory";
import { ClaimAdapterMock__factory } from "../../typechain/factories/ClaimAdapterMock__factory";
import { ContractCallerMock__factory } from "../../typechain/factories/ContractCallerMock__factory";
import { ExplicitERC20Mock__factory } from "../../typechain/factories/ExplicitERC20Mock__factory";
import { GaugeControllerMock__factory } from "../../typechain/factories/GaugeControllerMock__factory";
import { GodModeMock__factory } from "../../typechain/factories/GodModeMock__factory";
import { GovernanceAdapterMock__factory } from "../../typechain/factories/GovernanceAdapterMock__factory";
import { InvokeMock__factory } from "../../typechain/factories/InvokeMock__factory";
import { KyberNetworkProxyMock__factory } from "../../typechain/factories/KyberNetworkProxyMock__factory";
import { ManagerIssuanceHookMock__factory } from "../../typechain/factories/ManagerIssuanceHookMock__factory";
import { ModuleBaseMock__factory } from "../../typechain/factories/ModuleBaseMock__factory";
import { ModuleIssuanceHookMock__factory } from "../../typechain/factories/ModuleIssuanceHookMock__factory";
import { NAVIssuanceCaller__factory } from "../../typechain/factories/NAVIssuanceCaller__factory";
import { NAVIssuanceHookMock__factory } from "../../typechain/factories/NAVIssuanceHookMock__factory";
import { OneInchExchangeMock__factory } from "../../typechain/factories/OneInchExchangeMock__factory";
import { OracleAdapterMock__factory } from "../../typechain/factories/OracleAdapterMock__factory";
import { OracleMock__factory } from "../../typechain/factories/OracleMock__factory";
import { PositionMock__factory } from "../../typechain/factories/PositionMock__factory";
import { PreciseUnitMathMock__factory } from "../../typechain/factories/PreciseUnitMathMock__factory";
import { ResourceIdentifierMock__factory } from "../../typechain/factories/ResourceIdentifierMock__factory";
import { StakingAdapterMock__factory } from "../../typechain/factories/StakingAdapterMock__factory";
import { StandardTokenMock__factory } from "../../typechain/factories/StandardTokenMock__factory";
import { StandardTokenWithFeeMock__factory } from "../../typechain/factories/StandardTokenWithFeeMock__factory";
import { Uint256ArrayUtilsMock__factory } from "../../typechain/factories/Uint256ArrayUtilsMock__factory";
import { WrapAdapterMock__factory } from "../../typechain/factories/WrapAdapterMock__factory";

export default class DeployMocks {
  private _deployerSigner: Signer;

  constructor(deployerSigner: Signer) {
    this._deployerSigner = deployerSigner;
  }

  public async deployExplicitErc20Mock(): Promise<ExplicitERC20Mock> {
    return await new ExplicitERC20Mock__factory(this._deployerSigner).deploy();
  }

  public async deployInvokeMock(): Promise<InvokeMock> {
    return await new InvokeMock__factory(this._deployerSigner).deploy();
  }

  public async deployManagerIssuanceHookMock(): Promise<ManagerIssuanceHookMock> {
    return await new ManagerIssuanceHookMock__factory(this._deployerSigner).deploy();
  }

  public async deployModuleIssuanceHookMock(): Promise<ModuleIssuanceHookMock> {
    return await new ModuleIssuanceHookMock__factory(this._deployerSigner).deploy();
  }

  public async deployNavIssuanceHookMock(): Promise<NAVIssuanceHookMock> {
    return await new NAVIssuanceHookMock__factory(this._deployerSigner).deploy();
  }

  public async deployNAVIssuanceCaller(navIssuanceModule: Address): Promise<NAVIssuanceCaller> {
    return await new NAVIssuanceCaller__factory(this._deployerSigner).deploy(navIssuanceModule);
  }

  public async deployAddressArrayUtilsMock(): Promise<AddressArrayUtilsMock> {
    return await new AddressArrayUtilsMock__factory(this._deployerSigner).deploy();
  }

  public async deployUint256ArrayUtilsMock(): Promise<Uint256ArrayUtilsMock> {
    return await new Uint256ArrayUtilsMock__factory(this._deployerSigner).deploy();
  }

  public async deployKyberNetworkProxyMock(mockWethAddress: Address): Promise<KyberNetworkProxyMock> {
    return await new KyberNetworkProxyMock__factory(this._deployerSigner).deploy(mockWethAddress);
  }

  public async deployModuleBaseMock(controllerAddress: Address): Promise<ModuleBaseMock> {
    return await new ModuleBaseMock__factory(this._deployerSigner).deploy(controllerAddress);
  }

  public async deployGodModeMock(controllerAddress: Address): Promise<GodModeMock> {
    return await new GodModeMock__factory(this._deployerSigner).deploy(controllerAddress);
  }

  public async deployGovernanceAdapterMock(initialProposalId: BigNumberish): Promise<GovernanceAdapterMock> {
    return await new GovernanceAdapterMock__factory(this._deployerSigner).deploy(initialProposalId);
  }

  public async deployOneInchExchangeMock(
    sendToken: Address,
    receiveToken: Address,
    sendQuantity: BigNumber,
    receiveQuantity: BigNumber,
  ): Promise<OneInchExchangeMock> {
    return await new OneInchExchangeMock__factory(this._deployerSigner).deploy(
      sendToken,
      receiveToken,
      sendQuantity,
      receiveQuantity,
    );
  }

  public async deployOracleMock(initialValue: BigNumberish): Promise<OracleMock> {
    return await new OracleMock__factory(this._deployerSigner).deploy(initialValue);
  }

  public async deployOracleAdapterMock(
    asset: Address,
    dummyPrice: BigNumber
  ): Promise<OracleAdapterMock> {
    return await new OracleAdapterMock__factory(this._deployerSigner).deploy(asset, dummyPrice);
  }

  public async deployPositionMock(): Promise<PositionMock> {
    return await new PositionMock__factory(this._deployerSigner).deploy();
  }

  public async deployPreciseUnitMathMock(): Promise<PreciseUnitMathMock> {
    return await new PreciseUnitMathMock__factory(this._deployerSigner).deploy();
  }

  public async deployResourceIdentifierMock(): Promise<ResourceIdentifierMock> {
    return await new ResourceIdentifierMock__factory(this._deployerSigner).deploy();
  }

  public async deployStakingAdapterMock(stakingAsset: Address): Promise<StakingAdapterMock> {
    return await new StakingAdapterMock__factory(this._deployerSigner)
      .deploy(stakingAsset);
  }

  public async deployTokenMock(
    initialAccount: Address,
    initialBalance: BigNumberish = ether(1000000000),
    decimals: BigNumberish = 18,
    name: string = "Token",
    symbol: string = "Symbol"
  ): Promise<StandardTokenMock> {
    return await new StandardTokenMock__factory(this._deployerSigner)
      .deploy(initialAccount, initialBalance, name, symbol, decimals);
  }

  public async deployTokenWithFeeMock(
    initialAccount: Address,
    initialBalance: BigNumberish = ether(1000000000),
    fee: BigNumberish = ether(0.1),
    name: string = "Token",
    symbol: string = "Symbol"
  ): Promise<StandardTokenWithFeeMock> {
    return await new StandardTokenWithFeeMock__factory(this._deployerSigner)
      .deploy(initialAccount, initialBalance, name, symbol, fee);
  }

  public async deployAmmAdapterMock(_underlyingTokens: Address[]): Promise<AmmAdapterMock> {
    return await new AmmAdapterMock__factory(this._deployerSigner).deploy(_underlyingTokens);
  }

  public async deployWrapAdapterMock(): Promise<WrapAdapterMock> {
    return await new WrapAdapterMock__factory(this._deployerSigner).deploy();
  }

  public async deployAaveLendingPoolCoreMock(): Promise<AaveLendingPoolCoreMock> {
    return await new AaveLendingPoolCoreMock__factory(this._deployerSigner).deploy();
  }

  public async deployAaveLendingPoolMock(aaveLendingPoolCore: Address): Promise<AaveLendingPoolMock> {
    return await new AaveLendingPoolMock__factory(this._deployerSigner).deploy(aaveLendingPoolCore);
  }

  public async deployClaimAdapterMock(): Promise<ClaimAdapterMock> {
    return await new ClaimAdapterMock__factory(this._deployerSigner).deploy();
  }

  public async deployGaugeControllerMock(): Promise<GaugeControllerMock> {
    return await new GaugeControllerMock__factory(this._deployerSigner).deploy();
  }

  public async deployContractCallerMock(): Promise<ContractCallerMock> {
    return await new ContractCallerMock__factory(this._deployerSigner).deploy();
  }

  /*************************************
   * Instance getters
   ************************************/

  public async getTokenMock(token: Address): Promise<StandardTokenMock> {
    return await new StandardTokenMock__factory(this._deployerSigner).attach(token);
  }
}
