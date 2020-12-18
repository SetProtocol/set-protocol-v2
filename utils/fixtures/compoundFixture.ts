import { JsonRpcProvider, Web3Provider } from "ethers/providers";
import { BigNumber, BigNumberish } from "ethers/utils";
import { Signer } from "ethers";

import {
  CeRc20,
  CEther,
  Comp,
  CompoundGovernorAlpha,
  CompoundTimelock,
  CompoundPriceOracleMock,
  Comptroller,
  PriceOracleProxy,
  Unitroller,
  WhitePaperInterestRateModel,
} from "../contracts/compound";
import DeployHelper from "../deploys";
import {
  ether,
} from "../common";
import {
  Address,
} from "../types";
import {
  ADDRESS_ZERO,
  ONE_DAY_IN_SECONDS,
  ZERO
} from "../constants";

export class CompoundFixture {
  private _deployer: DeployHelper;
  private _ownerAddress: Address;
  private _ownerSigner: Signer;

  public unitroller: Unitroller;
  public comp: Comp;
  public compoundTimelock: CompoundTimelock;
  public compoundGovernorAlpha: CompoundGovernorAlpha;
  public comptroller: Comptroller;
  public interestRateModel: WhitePaperInterestRateModel;

  public priceOracle: CompoundPriceOracleMock;
  public priceOracleProxy: PriceOracleProxy;

  constructor(provider: Web3Provider | JsonRpcProvider, ownerAddress: Address) {
    this._ownerAddress = ownerAddress;
    this._ownerSigner = provider.getSigner(ownerAddress);
    this._deployer = new DeployHelper(this._ownerSigner);
  }

  public async initialize(): Promise<void> {
    this.priceOracle = await this._deployer.external.deployCompoundPriceOracleMock();

    // TODO - can fill with real addresses
    this.priceOracleProxy = await this._deployer.external.deployPriceOracleProxy(
      ADDRESS_ZERO,
      this.priceOracle.address,
      ADDRESS_ZERO,
      ADDRESS_ZERO,
      ADDRESS_ZERO,
      ADDRESS_ZERO,
      ADDRESS_ZERO,
    );

    this.unitroller = await this._deployer.external.deployUnitroller();
    this.comptroller = await this._deployer.external.deployComptroller();
    await this.unitroller._setPendingImplementation(this.comptroller.address);
    await this.comptroller._become(this.unitroller.address, ZERO, [], []);
    await this.comptroller._setPriceOracle(this.priceOracle.address);

    // deploy Interest rate model
    this.interestRateModel = await this._deployer.external.deployWhitePaperInterestRateModel(
        ether(1), // To change
        ether(1), // To change
    );

    // Deploy COMP governance
    this.comp = await this._deployer.external.deployComp(this._ownerAddress);
    this.compoundTimelock = await this._deployer.external.deployCompoundTimelock(
      this._ownerAddress,
      ONE_DAY_IN_SECONDS.mul(2),
    );
    this.compoundGovernorAlpha = await this._deployer.external.deployCompoundGovernorAlpha(
      this.compoundTimelock.address,
      this.comp.address,
      this._ownerAddress
    );
  }

  public async createAndEnableCToken(
    underlying: Address,
    initialExchangeRateMantissa: BigNumberish,
    comptroller: Address = this.unitroller.address,
    interestRateModel: Address = this.interestRateModel.address,
    name: string = "CToken",
    symbol: string = "CT",
    decimals: BigNumberish = 8,
    collateralFactor: BigNumber,
    currentPrice: BigNumber
  ): Promise<CeRc20> {
    const newCToken = await this._deployer.external.deployCeRc20(
      underlying,
      comptroller,
      interestRateModel,
      initialExchangeRateMantissa,
      name,
      symbol,
      decimals,
    );

    await this.comptroller._supportMarket(newCToken.address);

    // Set starting collateral factor
    await this.comptroller._setCollateralFactor(newCToken.address, collateralFactor);

    // Set starting price
    await this.priceOracle.setUnderlyingPrice(newCToken.address, currentPrice);

    return newCToken;
  }

  public async createAndEnableCEther(
    initialExchangeRateMantissa: BigNumberish,
    comptroller: Address = this.unitroller.address,
    interestRateModel: Address = this.interestRateModel.address,
    name: string = "CEther",
    symbol: string = "CETH",
    decimals: BigNumberish = 8,
    collateralFactor: BigNumber,
    currentPrice: BigNumber
  ): Promise<CEther> {
    const newCToken = await this._deployer.external.deployCEther(
      comptroller,
      interestRateModel,
      initialExchangeRateMantissa,
      name,
      symbol,
      decimals,
    );

    await this.comptroller._supportMarket(newCToken.address);

    // Set starting collateral factor
    await this.comptroller._setCollateralFactor(newCToken.address, collateralFactor);

    // Set starting price
    await this.priceOracle.setUnderlyingPrice(newCToken.address, currentPrice);

    return newCToken;
  }
}