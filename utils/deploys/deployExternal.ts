import { Signer } from "ethers";
import { BigNumberish, BigNumber } from "@ethersproject/bignumber";
import { ether } from "../common";

import {
  CompoundPriceOracleMock,
  Comp,
  CompoundGovernorAlpha,
  CompoundGovernorBravoDelegate,
  CompoundGovernorBravoDelegator,
  CompoundTimelock,
  Comptroller,
  CERc20,
  CEther,
  PriceOracleProxy,
  Unitroller,
  WhitePaperInterestRateModel
} from "./../contracts/compound";
import {
  WETH9,
  DelegateRegistry
} from "./../contracts";

import { Address } from "./../types";

import { CERc20__factory } from "../../typechain/factories/CERc20__factory";
import { CEther__factory } from "../../typechain/factories/CEther__factory";
import { CompoundPriceOracleMock__factory } from "../../typechain/factories/CompoundPriceOracleMock__factory";
import { Comp__factory } from "../../typechain/factories/Comp__factory";
import { CompoundGovernorAlpha__factory } from "../../typechain/factories/CompoundGovernorAlpha__factory";
import { CompoundGovernorBravoDelegator__factory } from "../../typechain/factories/CompoundGovernorBravoDelegator__factory";
import { CompoundGovernorBravoDelegate__factory } from "../../typechain/factories/CompoundGovernorBravoDelegate__factory";
import { CompoundTimelock__factory } from "../../typechain/factories/CompoundTimelock__factory";
import { Comptroller__factory } from "../../typechain/factories/Comptroller__factory";
import { PriceOracleProxy__factory } from "../../typechain/factories/PriceOracleProxy__factory";
import { Unitroller__factory } from "../../typechain/factories/Unitroller__factory";
import { WETH9__factory } from "../../typechain/factories/WETH9__factory";
import { WhitePaperInterestRateModel__factory } from "../../typechain/factories/WhitePaperInterestRateModel__factory";
import { LendingPoolAddressesProvider__factory } from "../../typechain/factories/LendingPoolAddressesProvider__factory";

import {
  AaveGovernanceV2,
  AavePropositionPower,
  AaveProtoGovernance,
  AaveTokenV2Mintable,
  AssetVotingWeightProvider,
  CoreLibrary,
  DefaultReserveInterestRateStrategy,
  Executor,
  GovernanceStrategy,
  GovernanceParamsProvider,
  LendingPool,
  LendingPoolAddressesProvider,
  LendingPoolConfigurator,
  LendingPoolCore,
  LendingRateOracle,
  LendToAaveMigrator
} from "../contracts/aave";

import { AaveGovernanceV2__factory } from "../../typechain/factories/AaveGovernanceV2__factory";
import { AaveTokenV2Mintable__factory } from "../../typechain/factories/AaveTokenV2Mintable__factory";
import { Executor__factory } from "../../typechain/factories/Executor__factory";
import { GovernanceStrategy__factory } from "../../typechain/factories/GovernanceStrategy__factory";
import { AavePropositionPower__factory } from "../../typechain/factories/AavePropositionPower__factory";
import { AaveProtoGovernance__factory } from "../../typechain/factories/AaveProtoGovernance__factory";
import { AssetVotingWeightProvider__factory } from "../../typechain/factories/AssetVotingWeightProvider__factory";
import { LendingPoolCore__factory, LendingPoolCoreLibraryAddresses } from "../../typechain/factories/LendingPoolCore__factory";
import { CoreLibrary__factory } from "../../typechain/factories/CoreLibrary__factory";
import { GovernanceParamsProvider__factory } from "../../typechain/factories/GovernanceParamsProvider__factory";
import { LendingPool__factory } from "../../typechain/factories/LendingPool__factory";
import { DefaultReserveInterestRateStrategy__factory } from "../../typechain/factories/DefaultReserveInterestRateStrategy__factory";
import { LendingPoolConfigurator__factory } from "../../typechain/factories/LendingPoolConfigurator__factory";
import { LendingRateOracle__factory } from "../../typechain/factories/LendingRateOracle__factory";
import { LendingPoolDataProvider__factory } from "../../typechain/factories/LendingPoolDataProvider__factory";
import { LendingPoolDataProvider } from "../../typechain/LendingPoolDataProvider";
import { LendToAaveMigrator__factory } from "../../typechain/factories/LendToAaveMigrator__factory";

import {
  CurveDeposit,
  CurvePoolERC20,
  CRVToken,
  GaugeController,
  LiquidityGauge,
  LiquidityGaugeReward,
  Minter,
  Stableswap,
} from "../contracts/curve";

import { CurvePoolERC20__factory } from "../../typechain/factories/CurvePoolERC20__factory";
import { Stableswap__factory } from "../../typechain/factories/Stableswap__factory";
import { CurveDeposit__factory } from "../../typechain/factories/CurveDeposit__factory";
import { CRVToken__factory } from "../../typechain/factories/CRVToken__factory";
import { GaugeController__factory } from "../../typechain/factories/GaugeController__factory";
import { LiquidityGaugeReward__factory } from "../../typechain/factories/LiquidityGaugeReward__factory";
import { Minter__factory } from "../../typechain/factories/Minter__factory";
import { LiquidityGauge__factory } from "../../typechain/factories/LiquidityGauge__factory";

import {
  StakingRewards,
  Uni,
  UniswapGovernorAlpha,
  UniswapTimelock,
  UniswapV2Factory,
  UniswapV2Pair,
  UniswapV2Router02
} from "../contracts/uniswap";

import { StakingRewards__factory } from "../../typechain/factories/StakingRewards__factory";
import { Uni__factory } from "../../typechain/factories/Uni__factory";
import { UniswapGovernorAlpha__factory } from "../../typechain/factories/UniswapGovernorAlpha__factory";
import { UniswapTimelock__factory } from "../../typechain/factories/UniswapTimelock__factory";
import { UniswapV2Factory__factory } from "../../typechain/factories/UniswapV2Factory__factory";
import { UniswapV2Pair__factory } from "../../typechain/factories/UniswapV2Pair__factory";
import { UniswapV2Router02__factory } from "../../typechain/factories/UniswapV2Router02__factory";

import {
  BFactory,
  BRegistry,
  ExchangeProxy
} from "../contracts/balancer";
import { BFactory__factory } from "../../typechain/factories/BFactory__factory";
import { BRegistry__factory } from "../../typechain/factories/BRegistry__factory";
import { ExchangeProxy__factory } from "../../typechain/factories/ExchangeProxy__factory";

import { DelegateRegistry__factory } from "../../typechain/factories/DelegateRegistry__factory";

export default class DeployExternalContracts {
  private _deployerSigner: Signer;

  constructor(deployerSigner: Signer) {
    this._deployerSigner = deployerSigner;
  }

  // COMPOUND
  public async deployComp(_account: Address): Promise<Comp> {
    return await new Comp__factory(this._deployerSigner).deploy(_account);
  }

  public async deployCompoundTimelock(_admin: Address, _delay: BigNumber): Promise<CompoundTimelock> {
    return await new CompoundTimelock__factory(this._deployerSigner).deploy(_admin, _delay);
  }

  public async deployCompoundGovernorAlpha(_timelock: Address, _comp: Address, _guardian: Address): Promise<CompoundGovernorAlpha> {
    return await new CompoundGovernorAlpha__factory(this._deployerSigner).deploy(_timelock, _comp, _guardian);
  }

  public async deployCompoundGovernorBravoDelegate(): Promise<CompoundGovernorBravoDelegate> {
    return await new CompoundGovernorBravoDelegate__factory(this._deployerSigner).deploy();
  }

  public async deployCompoundGovernorBravoDelegator(
    timelock: Address,
    comp: Address,
    admin: Address,
    implementation: Address,
    votingPeriod: BigNumberish,
    votingDelay: BigNumberish,
    proposalThreshold: BigNumberish
  ): Promise<CompoundGovernorBravoDelegator> {
    return await new CompoundGovernorBravoDelegator__factory(this._deployerSigner).deploy(
      timelock,
      comp,
      admin,
      implementation,
      votingPeriod,
      votingDelay,
      proposalThreshold
    );
  }

  public async deployCeRc20(
    underlying: Address,
    comptroller: Address,
    interestRateModel: Address,
    initialExchangeRateMantissa: BigNumberish,
    name: string,
    symbol: string,
    decimals: BigNumberish
  ): Promise<CERc20> {
    return await new CERc20__factory(this._deployerSigner).deploy(
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
    return await new CEther__factory(this._deployerSigner).deploy(
      comptroller,
      interestRateModel,
      initialExchangeRateMantissa,
      name,
      symbol,
      decimals,
    );
  }

  public async deployCompoundPriceOracleMock(): Promise<CompoundPriceOracleMock> {
    return await new CompoundPriceOracleMock__factory(this._deployerSigner).deploy();
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
    return await new PriceOracleProxy__factory(this._deployerSigner).deploy(
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
    return await new Comptroller__factory(this._deployerSigner).deploy();
  }

  public async deployUnitroller(): Promise<Unitroller> {
    return await new Unitroller__factory(this._deployerSigner).deploy();
  }

  public async deployWhitePaperInterestRateModel(
    baseRate: BigNumberish,
    multiplier: BigNumberish
  ): Promise<WhitePaperInterestRateModel> {
    return await new WhitePaperInterestRateModel__factory(this._deployerSigner).deploy(baseRate, multiplier);
  }

  // WETH
  public async deployWETH(): Promise<WETH9> {
    return await new WETH9__factory(this._deployerSigner).deploy();
  }

  // AAVE
  public async deployAaveProtoGovernance(govParamsProvider: Address): Promise<AaveProtoGovernance> {
    return await new AaveProtoGovernance__factory(this._deployerSigner).deploy(govParamsProvider);
  }

  public async deployGovernanceParamsProvider(
    propositionPowerThreshold: BigNumber,
    propositionPower: Address,
    assetVotingWeightProvider: Address
  ): Promise<GovernanceParamsProvider> {
    return await new GovernanceParamsProvider__factory(this._deployerSigner).deploy(
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
    return await new AavePropositionPower__factory(this._deployerSigner).deploy(
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
    return await new AssetVotingWeightProvider__factory(this._deployerSigner).deploy(
      assets,
      weights
    );
  }

  public async deployLendingPoolAddressesProvider(): Promise<LendingPoolAddressesProvider> {
    return await new LendingPoolAddressesProvider__factory(this._deployerSigner).deploy();
  }

  public async deployCoreLibrary(): Promise<CoreLibrary> {
    return await new CoreLibrary__factory(this._deployerSigner).deploy();
  }

  public async deployLendingPoolCore(coreLibraryAddress: Address): Promise<LendingPoolCore> {
    const lendingPoolCoreLibraryAddresses: LendingPoolCoreLibraryAddresses = {
      __CoreLibrary___________________________: coreLibraryAddress,
    };
    return await new LendingPoolCore__factory(lendingPoolCoreLibraryAddresses, this._deployerSigner).deploy();
  }

  public async deployLendingPool(): Promise<LendingPool> {
    return await new LendingPool__factory(this._deployerSigner).deploy();
  }

  public async deployLendingPoolConfigurator(): Promise<LendingPoolConfigurator> {
    return await new LendingPoolConfigurator__factory(this._deployerSigner).deploy();
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
    return await new DefaultReserveInterestRateStrategy__factory(this._deployerSigner).deploy(
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
    return await new LendingRateOracle__factory(this._deployerSigner).deploy();
  }

  public async deployLendingPoolDataProvider(): Promise<LendingPoolDataProvider> {
    return await new LendingPoolDataProvider__factory(this._deployerSigner).deploy();
  }

  public async deployLendToAaveMigrator(
    _aaveToken: Address,
    _lendToken: Address,
    _aaveLendRatio: BigNumber,
  ): Promise<LendToAaveMigrator> {
    return await new LendToAaveMigrator__factory(this._deployerSigner).deploy(
      _aaveToken,
      _lendToken,
      _aaveLendRatio
    );
  }

  public async getLendToAaveMigrator(lendToAaveMigratorAddress: Address): Promise<LendToAaveMigrator> {
    return await new LendToAaveMigrator__factory(this._deployerSigner).attach(lendToAaveMigratorAddress);
  }

  public async deployAaveGovernanceV2(
    _governanceStrategy: Address,
    _votingDelay: BigNumber,
    _guardian: Address,
    _executors: Address[]
  ): Promise<AaveGovernanceV2> {
    return await new AaveGovernanceV2__factory(this._deployerSigner).deploy(_governanceStrategy, _votingDelay, _guardian, _executors);
  }

  public async deployExecutor(
    _admin: Address,
    _delay: BigNumber,
    _gracePeriod: BigNumber,
    _minimumDelay: BigNumber,
    _maximumDelay: BigNumber,
    _propositionThreshold: BigNumber,
    _voteDuration: BigNumber,
    _voteDifferential: BigNumber,
    _minmumQuorum: BigNumber
  ): Promise<Executor> {
    return await new Executor__factory(this._deployerSigner).deploy(
      _admin,
      _delay,
      _gracePeriod,
      _minimumDelay,
      _maximumDelay,
      _propositionThreshold,
      _voteDuration,
      _voteDifferential,
      _minmumQuorum,
    );
  }

  public async deployGovernanceStrategy(_aave: Address, _stkaave: Address): Promise<GovernanceStrategy> {
    return await new GovernanceStrategy__factory(this._deployerSigner).deploy(_aave, _stkaave);
  }

  public async deployAaveTokenV2Mintable(): Promise<AaveTokenV2Mintable> {
    return await new AaveTokenV2Mintable__factory(this._deployerSigner).deploy();
  }

  // Curve
  public async deployCurveDeposit(
    _coins: [string, string, string, string],
    _underlying_coins: [string, string, string, string],
    _curve: string,
    _token: string,
  ): Promise<CurveDeposit> {
    return await new CurveDeposit__factory(this._deployerSigner).deploy(_coins, _underlying_coins, _curve, _token);
  }

  public async deployCurvePoolERC20(
    _name: string,
    _symbol: string,
    _decimals: BigNumberish = 18,
    _supply: BigNumberish
  ): Promise<CurvePoolERC20> {
    return await new CurvePoolERC20__factory(this._deployerSigner).deploy(_name, _symbol, _decimals, _supply);
  }

  public async deployStableswap(
    _coins: [string, string, string, string],
    _underlying_coins: [string, string, string, string],
    _pool_token: string,
    _aCoefficient: BigNumberish = 1,
    _fee: BigNumberish = 0
  ): Promise<Stableswap> {
    return await new Stableswap__factory(this._deployerSigner).deploy(
      _coins,
      _underlying_coins,
      _pool_token,
      _aCoefficient,
      _fee
    );
  }

  public async deployCrvToken(_name: string, _symbol: string, _decimals: BigNumberish = 18): Promise<CRVToken> {
    return await new CRVToken__factory(this._deployerSigner).deploy(_name, _symbol, _decimals);
  }

  public async deployGaugeController(_token: string, _voting_escrow: string): Promise<GaugeController> {
    return await new GaugeController__factory(this._deployerSigner).deploy(_token, _voting_escrow);
  }

  public async deployLiquidityGaugeReward(
    _lpAddr: string,
    _minter: string,
    _reward_contract: string,
    _rewarded_token: string
  ): Promise<LiquidityGaugeReward> {
    return await new LiquidityGaugeReward__factory(this._deployerSigner).deploy(
      _lpAddr,
      _minter,
      _reward_contract,
      _rewarded_token
    );
  }

  public async deployLiquidityGauge(_lpAddr: string, _minter: string): Promise<LiquidityGauge> {
    return await new LiquidityGauge__factory(this._deployerSigner).deploy(_lpAddr, _minter);
  }

  public async deployMinter(_token: string, _controller: string): Promise<Minter> {
    return await new Minter__factory(this._deployerSigner).deploy(_token, _controller);
  }

  // Uniswap
  public async deployUni(_account: Address, _minter: Address, _mintingAllowedAfter: BigNumber): Promise<Uni> {
    return await new Uni__factory(this._deployerSigner).deploy(_account, _minter, _mintingAllowedAfter);
  }

  public async deployUniswapTimelock(_admin: Address, _delay: BigNumber): Promise<UniswapTimelock> {
    return await new UniswapTimelock__factory(this._deployerSigner).deploy(_admin, _delay);
  }

  public async deployUniswapGovernorAlpha(_timelock: Address, _uni: Address): Promise<UniswapGovernorAlpha> {
    return await new UniswapGovernorAlpha__factory(this._deployerSigner).deploy(_timelock, _uni);
  }

  public async deployUniswapV2Factory(_feeToSetter: string): Promise<UniswapV2Factory> {
    return await new UniswapV2Factory__factory(this._deployerSigner).deploy(_feeToSetter);
  }

  public async deployUniswapV2Router02(_factory: Address, _weth: Address): Promise<UniswapV2Router02> {
    return await new UniswapV2Router02__factory(this._deployerSigner).deploy(_factory, _weth);
  }

  public async deployUniswapV2Pair(_factory: Address, _weth: Address): Promise<UniswapV2Pair> {
    return await new UniswapV2Pair__factory(this._deployerSigner).deploy();
  }

  public async deployStakingRewards(
    _rewardsDistribution: Address,
    _rewardsToken: Address,
    _stakingToken: Address
  ): Promise<StakingRewards> {
    return await new StakingRewards__factory(this._deployerSigner).deploy(
      _rewardsDistribution,
      _rewardsToken,
      _stakingToken
    );
  }

  public async deployB__factory(): Promise<BFactory> {
    return await new BFactory__factory(this._deployerSigner).deploy();
  }

  public async deployExchangeProxy(weth: Address): Promise<ExchangeProxy> {
    return await new ExchangeProxy__factory(this._deployerSigner).deploy(weth);
  }

  public async deployBRegistry(factory: Address): Promise<BRegistry> {
    return await new BRegistry__factory(this._deployerSigner).deploy(factory);
  }

  public async deployDelegateRegistry(): Promise<DelegateRegistry> {
    return await new DelegateRegistry__factory(this._deployerSigner).deploy();
  }
}
