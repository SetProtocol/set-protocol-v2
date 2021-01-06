import DeployHelper from "../deploys";
import { Signer } from "ethers";
import { JsonRpcProvider, Web3Provider } from "@ethersproject/providers";
import { Address } from "../types";
import { BigNumber, BigNumberish } from "@ethersproject/bignumber";

import {
  AavePropositionPower,
  AaveProtoGovernance,
  AssetVotingWeightProvider,
  AToken,
  CoreLibrary,
  DefaultReserveInterestRateStrategy,
  GovernanceParamsProvider,
  LendingPool,
  LendingPoolAddressesProvider,
  LendingPoolConfigurator,
  LendingPoolCore,
  LendingRateOracle,
  LendingPoolDataProvider,
  LendToAaveMigrator,
} from "../contracts/aave";

import { StandardTokenMock } from "../contracts";

import { ether } from "../common";

import { AToken__factory } from "../../typechain/factories/AToken__factory";

export class AaveFixture {
  private _deployer: DeployHelper;
  private _ownerSigner: Signer;

  public lendingPool: LendingPool;
  public lendingPoolCore: LendingPoolCore;
  public lendingPoolAddressesProvider: LendingPoolAddressesProvider;
  public coreLibrary: CoreLibrary;
  public lendingPoolConfigurator: LendingPoolConfigurator;
  public reserveInterestRateStrategy: DefaultReserveInterestRateStrategy;
  public lendingRateOracle: LendingRateOracle;
  public lendingPoolDataProvider: LendingPoolDataProvider;
  public lendToAaveMigrator: LendToAaveMigrator;
  public lendToken: StandardTokenMock;
  public aaveToken: StandardTokenMock;
  public aaveExchangeRatio: BigNumber;
  public ethTokenAddress: Address = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";
  public aaveProtoGovernance: AaveProtoGovernance;
  public aavePropositionPower: AavePropositionPower;
  public assetVotingWeightPower: AssetVotingWeightProvider;
  public governanceParamsProvider: GovernanceParamsProvider;

  constructor(provider: Web3Provider | JsonRpcProvider, ownerAddress: Address) {
    this._ownerSigner = provider.getSigner(ownerAddress);
    this._deployer = new DeployHelper(this._ownerSigner);
  }

  public async initialize(): Promise<void> {
    this.lendingPoolAddressesProvider = await this._deployer.external.deployLendingPoolAddressesProvider();
    this.lendingPool = await this._deployer.external.deployLendingPool();
    this.coreLibrary = await this._deployer.external.deployCoreLibrary();
    this.lendingPoolCore = await this._deployer.external.deployLendingPoolCore(this.coreLibrary.address);
    this.lendingPoolConfigurator = await this._deployer.external.deployLendingPoolConfigurator();
    this.lendingRateOracle = await this._deployer.external.deployLendingRateOracle();
    this.lendingPoolDataProvider = await this._deployer.external.deployLendingPoolDataProvider();

    await this.lendingPoolAddressesProvider.setLendingPoolManager(await this._ownerSigner.getAddress());
    await this.lendingPoolAddressesProvider.setLendingRateOracle(this.lendingRateOracle.address);

    await this.lendingPoolAddressesProvider.setLendingPoolCoreImpl(this.lendingPoolCore.address);
    const proxyCore = await this.lendingPoolAddressesProvider.getLendingPoolCore();
    this.lendingPoolCore = this.lendingPoolCore.attach(proxyCore);

    await this.lendingPoolAddressesProvider.setLendingPoolDataProviderImpl(this.lendingPoolDataProvider.address);
    const proxyDataProvider = await this.lendingPoolAddressesProvider.getLendingPoolDataProvider();
    this.lendingPoolDataProvider = this.lendingPoolDataProvider.attach(proxyDataProvider);

    await this.lendingPoolAddressesProvider.setLendingPoolImpl(this.lendingPool.address);
    const proxyPool = await this.lendingPoolAddressesProvider.getLendingPool();
    this.lendingPool = this.lendingPool.attach(proxyPool);

    await this.lendingPoolAddressesProvider.setLendingPoolConfiguratorImpl(this.lendingPoolConfigurator.address);
    const proxyConfigurator = await this.lendingPoolAddressesProvider.getLendingPoolConfigurator();
    this.lendingPoolConfigurator = this.lendingPoolConfigurator.attach(proxyConfigurator);

    await this.lendingPoolConfigurator.refreshLendingPoolCoreConfiguration();

    this.reserveInterestRateStrategy = await this._deployer.external.deployDefaultReserveInterestRateStrategy(
      this.lendingPoolCore.address,
      this.lendingPoolAddressesProvider.address
    );

    // Deploy migration
    this.lendToken = await this._deployer.mocks.deployTokenMock(await this._ownerSigner.getAddress(), ether(1000000), 18);
    this.aaveToken = await this._deployer.mocks.deployTokenMock(await this._ownerSigner.getAddress(), ether(10000), 18);
    this.aaveExchangeRatio = BigNumber.from(100); // 100:1 LEND to AAVE ratio
    this.lendToAaveMigrator = await this._deployer.external.deployLendToAaveMigrator(
      this.aaveToken.address,
      this.lendToken.address,
      this.aaveExchangeRatio
    );

    // Deploy Governance
    this.assetVotingWeightPower = await this._deployer.external.deployAssetVotingWeightProvider(
      [this.aaveToken.address, this.lendToken.address],
      [BigNumber.from(1), BigNumber.from(1)]
    );
    this.aavePropositionPower = await this._deployer.external.deployAavePropositionPower(
      "Aave Proposition Power",
      "APP",
      18,
      [await this._ownerSigner.getAddress()],
      BigNumber.from(1)
    );
    this.governanceParamsProvider = await this._deployer.external.deployGovernanceParamsProvider(
      BigNumber.from(1),
      this.aavePropositionPower.address,
      this.assetVotingWeightPower.address
    );
    this.aaveProtoGovernance = await this._deployer.external.deployAaveProtoGovernance(this.governanceParamsProvider.address);

    // Transfer tokens to contract for migration
    await this.lendToken.transfer(this.lendToAaveMigrator.address, ether(10000));
    await this.aaveToken.transfer(this.lendToAaveMigrator.address, ether(100));

    await this.lendToAaveMigrator.initialize();
  }

  public async deployAToken(_underlyingAsset: Address, _decimals: BigNumberish = 18): Promise<AToken> {
    await this.lendingPoolConfigurator.initReserve(_underlyingAsset, _decimals, this.reserveInterestRateStrategy.address);
    const aTokenAddress = await this.lendingPoolCore.getReserveATokenAddress(_underlyingAsset);
    return new AToken__factory(this._ownerSigner).attach(aTokenAddress);
  }

  public async deployETHAToken(
    _underlyingAsset: Address = this.ethTokenAddress,
    _name: string = "Aave Interest bearing ETH",
    _symbol: string = "aETH",
    _decimals: BigNumberish = 18,
  ): Promise<AToken> {
    await this.lendingPoolConfigurator.initReserveWithData(
      _underlyingAsset,
      _name,
      _symbol,
      _decimals,
      this.reserveInterestRateStrategy.address
    );
    const aTokenAddress = await this.lendingPoolCore.getReserveATokenAddress(_underlyingAsset);
    return new AToken__factory(this._ownerSigner).attach(aTokenAddress);
  }
}
