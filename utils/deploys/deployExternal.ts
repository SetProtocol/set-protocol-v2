import { Signer } from "ethers";
import { BigNumberish, BigNumber } from "ethers/utils";
import { ether } from "../common";

import {
  CompoundPriceOracleMock,
  Comp,
  CompoundGovernorAlpha,
  CompoundTimelock,
  Comptroller,
  CeRc20,
  CEther,
  PriceOracleProxy,
  Unitroller,
  WhitePaperInterestRateModel
} from "./../contracts/compound";
import {
  Weth9
} from "./../contracts";

import { Address } from "./../types";

import { CeRc20Factory } from "../../typechain/CeRc20Factory";
import { CEtherFactory } from "../../typechain/CEtherFactory";
import { CompoundPriceOracleMockFactory } from "../../typechain/CompoundPriceOracleMockFactory";
import { CompFactory } from "../../typechain/CompFactory";
import { CompoundGovernorAlphaFactory } from "../../typechain/CompoundGovernorAlphaFactory";
import { CompoundTimelockFactory } from "../../typechain/CompoundTimelockFactory";
import { ComptrollerFactory } from "../../typechain/ComptrollerFactory";
import { PriceOracleProxyFactory } from "../../typechain/PriceOracleProxyFactory";
import { UnitrollerFactory } from "../../typechain/UnitrollerFactory";
import { Weth9Factory } from "../../typechain/Weth9Factory";
import { WhitePaperInterestRateModelFactory } from "../../typechain/WhitePaperInterestRateModelFactory";
import { LendingPoolAddressesProviderFactory } from "../../typechain/LendingPoolAddressesProviderFactory";

import {
  AavePropositionPower,
  AaveProtoGovernance,
  AssetVotingWeightProvider,
  CoreLibrary,
  DefaultReserveInterestRateStrategy,
  GovernanceParamsProvider,
  LendingPool,
  LendingPoolAddressesProvider,
  LendingPoolConfigurator,
  LendingPoolCore,
  LendingRateOracle,
  LendToAaveMigrator
} from "../contracts/aave";

import { AavePropositionPowerFactory } from "../../typechain/AavePropositionPowerFactory";
import { AaveProtoGovernanceFactory } from "../../typechain/AaveProtoGovernanceFactory";
import { AssetVotingWeightProviderFactory } from "../../typechain/AssetVotingWeightProviderFactory";
import { LendingPoolCoreFactory, LendingPoolCoreLibraryAddresses } from "../../typechain/LendingPoolCoreFactory";
import { CoreLibraryFactory } from "../../typechain/CoreLibraryFactory";
import { GovernanceParamsProviderFactory } from "../../typechain/GovernanceParamsProviderFactory";
import { LendingPoolFactory } from "../../typechain/LendingPoolFactory";
import { DefaultReserveInterestRateStrategyFactory } from "../../typechain/DefaultReserveInterestRateStrategyFactory";
import { LendingPoolConfiguratorFactory } from "../../typechain/LendingPoolConfiguratorFactory";
import { LendingRateOracleFactory } from "../../typechain/LendingRateOracleFactory";
import { LendingPoolDataProviderFactory } from "../../typechain/LendingPoolDataProviderFactory";
import { LendingPoolDataProvider } from "../../typechain/LendingPoolDataProvider";
import { LendToAaveMigratorFactory } from "../../typechain/LendToAaveMigratorFactory";

import {
  CurveDeposit,
  CurvePoolErc20,
  CrvToken,
  GaugeController,
  LiquidityGauge,
  LiquidityGaugeReward,
  Minter,
  Stableswap,
} from "../contracts/curve";

import { CurvePoolErc20Factory } from "../../typechain/CurvePoolErc20Factory";
import { StableswapFactory } from "../../typechain/StableswapFactory";
import { CurveDepositFactory } from "../../typechain/CurveDepositFactory";
import { CrvTokenFactory } from "../../typechain/CrvTokenFactory";
import { GaugeControllerFactory } from "../../typechain/GaugeControllerFactory";
import { LiquidityGaugeRewardFactory } from "../../typechain/LiquidityGaugeRewardFactory";
import { MinterFactory } from "../../typechain/MinterFactory";
import { LiquidityGaugeFactory } from "../../typechain/LiquidityGaugeFactory";

import {
  StakingRewards,
  Uni,
  UniswapGovernorAlpha,
  UniswapTimelock,
  UniswapV2Factory,
  UniswapV2Pair,
  UniswapV2Router02
} from "../contracts/uniswap";

import { StakingRewardsFactory } from "../../typechain/StakingRewardsFactory";
import { UniFactory } from "../../typechain/UniFactory";
import { UniswapGovernorAlphaFactory } from "../../typechain/UniswapGovernorAlphaFactory";
import { UniswapTimelockFactory } from "../../typechain/UniswapTimelockFactory";
import { UniswapV2FactoryFactory } from "../../typechain/UniswapV2FactoryFactory";
import { UniswapV2PairFactory } from "../../typechain/UniswapV2PairFactory";
import { UniswapV2Router02Factory } from "../../typechain/UniswapV2Router02Factory";

import {
  BFactory,
  BRegistry,
  ExchangeProxy
} from "../contracts/balancer";
import { BFactoryFactory } from "../../typechain/BFactoryFactory";
import { BRegistryFactory } from "../../typechain/BRegistryFactory";
import { ExchangeProxyFactory } from "../../typechain/ExchangeProxyFactory";

export default class DeployExternalContracts {
  private _deployerSigner: Signer;

  constructor(deployerSigner: Signer) {
    this._deployerSigner = deployerSigner;
  }

  // COMPOUND
  public async deployComp(_account: Address): Promise<Comp> {
    return await new CompFactory(this._deployerSigner).deploy(_account);
  }

  public async deployCompoundTimelock(_admin: Address, _delay: BigNumber): Promise<CompoundTimelock> {
    return await new CompoundTimelockFactory(this._deployerSigner).deploy(_admin, _delay);
  }

  public async deployCompoundGovernorAlpha(_timelock: Address, _comp: Address, _guardian: Address): Promise<CompoundGovernorAlpha> {
    return await new CompoundGovernorAlphaFactory(this._deployerSigner).deploy(_timelock, _comp, _guardian);
  }

  public async deployCeRc20(
    underlying: Address,
    comptroller: Address,
    interestRateModel: Address,
    initialExchangeRateMantissa: BigNumberish,
    name: string,
    symbol: string,
    decimals: BigNumberish
  ): Promise<CeRc20> {
    return await new CeRc20Factory(this._deployerSigner).deploy(
      underlying,
      comptroller,
      interestRateModel,
      initialExchangeRateMantissa,
      name,
      symbol,
      decimals,
    );
  }

  public async deployCEther(
    comptroller: Address,
    interestRateModel: Address,
    initialExchangeRateMantissa: BigNumberish,
    name: string,
    symbol: string,
    decimals: BigNumberish
  ): Promise<CEther> {
    return await new CEtherFactory(this._deployerSigner).deploy(
      comptroller,
      interestRateModel,
      initialExchangeRateMantissa,
      name,
      symbol,
      decimals,
    );
  }

  public async deployCompoundPriceOracleMock(): Promise<CompoundPriceOracleMock> {
    return await new CompoundPriceOracleMockFactory(this._deployerSigner).deploy();
  }

  public async deployPriceOracleProxy(
    guardian: Address,
    v1PriceOracle: Address,
    cEthAddress: Address,
    cUsdcAddress: Address,
    cSaiAddress: Address,
    cDaiAddress: Address,
    cUsdtAddress: Address,
  ): Promise<PriceOracleProxy> {
    return await new PriceOracleProxyFactory(this._deployerSigner).deploy(
      guardian,
      v1PriceOracle,
      cEthAddress,
      cUsdcAddress,
      cSaiAddress,
      cDaiAddress,
      cUsdtAddress,
    );
  }

  public async deployComptroller(): Promise<Comptroller> {
    return await new ComptrollerFactory(this._deployerSigner).deploy();
  }

  public async deployUnitroller(): Promise<Unitroller> {
    return await new UnitrollerFactory(this._deployerSigner).deploy();
  }

  public async deployWhitePaperInterestRateModel(
    baseRate: BigNumberish,
    multiplier: BigNumberish
  ): Promise<WhitePaperInterestRateModel> {
    return await new WhitePaperInterestRateModelFactory(this._deployerSigner).deploy(baseRate, multiplier);
  }

  // WETH
  public async deployWETH(): Promise<Weth9> {
    return await new Weth9Factory(this._deployerSigner).deploy();
  }

  // AAVE
  public async deployAaveProtoGovernance(govParamsProvider: Address): Promise<AaveProtoGovernance> {
    return await new AaveProtoGovernanceFactory(this._deployerSigner).deploy(govParamsProvider);
  }

  public async deployGovernanceParamsProvider(
    propositionPowerThreshold: BigNumber,
    propositionPower: Address,
    assetVotingWeightProvider: Address
  ): Promise<GovernanceParamsProvider> {
    return await new GovernanceParamsProviderFactory(this._deployerSigner).deploy(
      propositionPowerThreshold,
      propositionPower,
      assetVotingWeightProvider
    );
  }

  public async deployAavePropositionPower(
    name: string,
    symbol: string,
    decimals: BigNumberish,
    council: Address[],
    cap: BigNumber,
  ): Promise<AavePropositionPower> {
    return await new AavePropositionPowerFactory(this._deployerSigner).deploy(
      name,
      symbol,
      decimals,
      council,
      cap
    );
  }

  public async deployAssetVotingWeightProvider(
    assets: Address[],
    weights: BigNumber[],
  ): Promise<AssetVotingWeightProvider> {
    return await new AssetVotingWeightProviderFactory(this._deployerSigner).deploy(
      assets,
      weights
    );
  }

  public async deployLendingPoolAddressesProvider(): Promise<LendingPoolAddressesProvider> {
    return await new LendingPoolAddressesProviderFactory(this._deployerSigner).deploy();
  }

  public async deployCoreLibrary(): Promise<CoreLibrary> {
    return await new CoreLibraryFactory(this._deployerSigner).deploy();
  }

  public async deployLendingPoolCore(coreLibraryAddress: Address): Promise<LendingPoolCore> {
    const lendingPoolCoreLibraryAddresses: LendingPoolCoreLibraryAddresses = {
      __CoreLibrary___________________________: coreLibraryAddress,
    };
    return await new LendingPoolCoreFactory(lendingPoolCoreLibraryAddresses, this._deployerSigner).deploy();
  }

  public async deployLendingPool(): Promise<LendingPool> {
    return await new LendingPoolFactory(this._deployerSigner).deploy();
  }

  public async deployLendingPoolConfigurator(): Promise<LendingPoolConfigurator> {
    return await new LendingPoolConfiguratorFactory(this._deployerSigner).deploy();
  }

  public async deployDefaultReserveInterestRateStrategy(
    _reserve: Address,
    _AddressProvider: Address,
    _baseVariableBorrowRate: BigNumberish = ether(1),
    _variableRateSlope1: BigNumberish = ether(1),
    _variableRateSlope2: BigNumberish = ether(1),
    _stableRateSlope1: BigNumberish = ether(1),
    _stableRateSlope2: BigNumberish = ether(1),
  ): Promise<DefaultReserveInterestRateStrategy> {
    return await new DefaultReserveInterestRateStrategyFactory(this._deployerSigner).deploy(
      _reserve,
      _AddressProvider,
      _baseVariableBorrowRate,
      _variableRateSlope1,
      _variableRateSlope2,
      _stableRateSlope1,
      _stableRateSlope2,
    );
  }

  public async deployLendingRateOracle(): Promise<LendingRateOracle> {
    return await new LendingRateOracleFactory(this._deployerSigner).deploy();
  }

  public async deployLendingPoolDataProvider(): Promise<LendingPoolDataProvider> {
    return await new LendingPoolDataProviderFactory(this._deployerSigner).deploy();
  }

  public async deployLendToAaveMigrator(
    _aaveToken: Address,
    _lendToken: Address,
    _aaveLendRatio: BigNumber,
  ): Promise<LendToAaveMigrator> {
    return await new LendToAaveMigratorFactory(this._deployerSigner).deploy(
      _aaveToken,
      _lendToken,
      _aaveLendRatio
    );
  }

  public async getLendToAaveMigrator(lendToAaveMigratorAddress: Address): Promise<LendToAaveMigrator> {
    return await new LendToAaveMigratorFactory(this._deployerSigner).attach(lendToAaveMigratorAddress);
  }

  // Curve
  public async deployCurveDeposit(
    _coins: string[],
    _underlying_coins: string[],
    _curve: string,
    _token: string,
  ): Promise<CurveDeposit> {
    return await new CurveDepositFactory(this._deployerSigner).deploy(_coins, _underlying_coins, _curve, _token);
  }

  public async deployCurvePoolERC20(
    _name: string,
    _symbol: string,
    _decimals: BigNumberish = 18,
    _supply: BigNumberish
  ): Promise<CurvePoolErc20> {
    return await new CurvePoolErc20Factory(this._deployerSigner).deploy(_name, _symbol, _decimals, _supply);
  }

  public async deployStableswap(
    _coins: string[],
    _underlying_coins: string[],
    _pool_token: string,
    _aCoefficient: BigNumberish = 1,
    _fee: BigNumberish = 0
  ): Promise<Stableswap> {
    return await new StableswapFactory(this._deployerSigner).deploy(
      _coins,
      _underlying_coins,
      _pool_token,
      _aCoefficient,
      _fee
    );
  }

  public async deployCrvToken(_name: string, _symbol: string, _decimals: BigNumberish = 18): Promise<CrvToken> {
    return await new CrvTokenFactory(this._deployerSigner).deploy(_name, _symbol, _decimals);
  }

  public async deployGaugeController(_token: string, _voting_escrow: string): Promise<GaugeController> {
    return await new GaugeControllerFactory(this._deployerSigner).deploy(_token, _voting_escrow);
  }

  public async deployLiquidityGaugeReward(
    _lpAddr: string,
    _minter: string,
    _reward_contract: string,
    _rewarded_token: string
  ): Promise<LiquidityGaugeReward> {
    return await new LiquidityGaugeRewardFactory(this._deployerSigner).deploy(
      _lpAddr,
      _minter,
      _reward_contract,
      _rewarded_token
    );
  }

  public async deployLiquidityGauge(_lpAddr: string, _minter: string): Promise<LiquidityGauge> {
    return await new LiquidityGaugeFactory(this._deployerSigner).deploy(_lpAddr, _minter);
  }

  public async deployMinter(_token: string, _controller: string): Promise<Minter> {
    return await new MinterFactory(this._deployerSigner).deploy(_token, _controller);
  }

  // Uniswap
  public async deployUni(_account: Address, _minter: Address, _mintingAllowedAfter: BigNumber): Promise<Uni> {
    return await new UniFactory(this._deployerSigner).deploy(_account, _minter, _mintingAllowedAfter);
  }

  public async deployUniswapTimelock(_admin: Address, _delay: BigNumber): Promise<UniswapTimelock> {
    return await new UniswapTimelockFactory(this._deployerSigner).deploy(_admin, _delay);
  }

  public async deployUniswapGovernorAlpha(_timelock: Address, _uni: Address): Promise<UniswapGovernorAlpha> {
    return await new UniswapGovernorAlphaFactory(this._deployerSigner).deploy(_timelock, _uni);
  }

  public async deployUniswapV2Factory(_feeToSetter: string): Promise<UniswapV2Factory> {
    return await new UniswapV2FactoryFactory(this._deployerSigner).deploy(_feeToSetter);
  }

  public async deployUniswapV2Router02(_factory: Address, _weth: Address): Promise<UniswapV2Router02> {
    return await new UniswapV2Router02Factory(this._deployerSigner).deploy(_factory, _weth);
  }

  public async deployUniswapV2Pair(_factory: Address, _weth: Address): Promise<UniswapV2Pair> {
    return await new UniswapV2PairFactory(this._deployerSigner).deploy();
  }

  public async deployStakingRewards(
    _rewardsDistribution: Address,
    _rewardsToken: Address,
    _stakingToken: Address
  ): Promise<StakingRewards> {
    return await new StakingRewardsFactory(this._deployerSigner).deploy(
      _rewardsDistribution,
      _rewardsToken,
      _stakingToken
    );
  }

  public async deployBFactory(): Promise<BFactory> {
    return await new BFactoryFactory(this._deployerSigner).deploy();
  }

  public async deployExchangeProxy(weth: Address): Promise<ExchangeProxy> {
    return await new ExchangeProxyFactory(this._deployerSigner).deploy(weth);
  }

  public async deployBRegistry(factory: Address): Promise<BRegistry> {
    return await new BRegistryFactory(this._deployerSigner).deploy(factory);
  }
}
