import DeployHelper from "../deploys";
import { Signer } from "ethers";
import { JsonRpcProvider, Web3Provider } from "@ethersproject/providers";
import { Address } from "../types";
import { BigNumber, BigNumberish } from "@ethersproject/bignumber";

import {
  AaveV2Oracle,
  AaveV2PriceOracle,
  AaveV2LendingPool,
  AaveV2ProtocolDataProvider,
  AaveV2LendingPoolConfigurator,
  AaveV2LendingPoolAddressesProvider,
  AaveV2LendingPoolCollateralManager,
  AaveV2DefaultReserveInterestRateStrategy,
  AaveV2LendingRateOracle
} from "../contracts/aaveV2";

// import {
// 	Executor,
// 	AaveGovernanceV2,
// 	AaveTokenV2Mintable
// } from "../contracts/aave";

import { ether, getRandomAddress } from "../common";

import { ADDRESS_ZERO } from "../constants";

export class AaveV2Fixture {
  private _deployer: DeployHelper;
  private _ownerSigner: Signer;

  public marketId: string;
  public lendingPool: AaveV2LendingPool;
  public protocolDataProvider: AaveV2ProtocolDataProvider;
  public lendingPoolConfigurator: AaveV2LendingPoolConfigurator;
  public lendingPoolCollateralManager: AaveV2LendingPoolCollateralManager;
  public lendingPoolAddressesProvider: AaveV2LendingPoolAddressesProvider;
  public reserveInterestRateStrategy: AaveV2DefaultReserveInterestRateStrategy;

  public priceOracle: AaveV2Oracle;
  public fallbackOracle: AaveV2PriceOracle;
  public lendingRateOracle: AaveV2LendingRateOracle;

  public treasuryAddress: Address;
  public incentivesControllerAddress: Address;

  // TODO: move governance to this fixture
  // public executor: Executor;
  // public aaveGovernanceV2: AaveGovernanceV2;
  // public aaveToken: AaveTokenV2Mintable;
  // public stkAaveToken: AaveTokenV2Mintable;
  // public governanceStrategy: GovernanceStrategy;
  // public aaveProtoGovernance: AaveProtoGovernance;
  // public aavePropositionPower: AavePropositionPower;
  // public assetVotingWeightPower: AssetVotingWeightProvider;
  // public governanceParamsProvider: GovernanceParamsProvider;

  constructor(provider: Web3Provider | JsonRpcProvider, ownerAddress: Address) {
    this._ownerSigner = provider.getSigner(ownerAddress);
    this._deployer = new DeployHelper(this._ownerSigner);
  }

  public async initialize(weth: Address, dai: Address, marketId: string = "Commons"): Promise<void> {

    this.marketId = marketId;

    // deploy libraries
    const genericLogicLibraryAddress = (await this._deployer.external.deployGeneralLogic()).address;
    const reserveLogicAddress = (await this._deployer.external.deployReserveLogic()).address;
    const validationLogicAddress = (await this._deployer.external.deployValidationLogic(genericLogicLibraryAddress)).address;

    // deploy contracts
    this.lendingPoolConfigurator = await this._deployer.external.deployAaveV2LendingPoolConfigurator();
    this.lendingPoolCollateralManager = await this._deployer.external.deployAaveV2LendingPoolCollateralManager();
    this.lendingPool = await this._deployer.external.deployAaveV2LendingPool(validationLogicAddress, reserveLogicAddress);
    this.lendingPoolAddressesProvider = await this._deployer.external.deployAaveV2LendingPoolAddressesProvider(this.marketId);
    this.protocolDataProvider = await this._deployer.external.deployAaveV2ProtocolDataProvider(this.lendingPoolAddressesProvider.address);
    this.reserveInterestRateStrategy = await this._deployer.external.deployAaveV2DefaultReserveInterestRateStrategy(
      this.lendingPoolAddressesProvider.address
    );

    // deploy oracles
    this.lendingRateOracle = await this._deployer.external.deployAaveV2LendingRateOracle();
    // Aave V2 oracle relies on Chainlink oracle and their fallback oracle. For fixture, we would be deploying a mock fallback oracle
    // with ability to set asset prices on it, which is comparitively easier than deploying multiple chainlink aggregators.
    this.fallbackOracle = await this._deployer.external.deployAaveV2PriceOracle();
    this.priceOracle = await this._deployer.external.deployAaveV2Oracle([], [], this.fallbackOracle.address, weth);

    // set addresses in LendingPoolAddressProvider
    await this.lendingPoolAddressesProvider.setPriceOracle(this.priceOracle.address);
    await this.lendingPoolAddressesProvider.setLendingRateOracle(this.lendingRateOracle.address);
    await this.lendingPoolAddressesProvider.setPoolAdmin(await this._ownerSigner.getAddress());
    await this.lendingPoolAddressesProvider.setLendingPoolCollateralManager(this.lendingPoolCollateralManager.address);

    // LendingPoolAddressProvider creates a new proxy contract and sets the passed in address as the implementation.
    // We then fetch the proxy's address and attach it to the contract object, which allows us to use the contract object
    // to call functions on the proxy
    await this.lendingPoolAddressesProvider.setLendingPoolImpl(this.lendingPool.address);
    const proxyPool = await this.lendingPoolAddressesProvider.getLendingPool();
    this.lendingPool = this.lendingPool.attach(proxyPool);

    await this.lendingPoolAddressesProvider.setLendingPoolConfiguratorImpl(this.lendingPoolConfigurator.address);
    const proxyConfigurator = await this.lendingPoolAddressesProvider.getLendingPoolConfigurator();
    this.lendingPoolConfigurator = this.lendingPoolConfigurator.attach(proxyConfigurator);

    this.treasuryAddress = await getRandomAddress();	// Tokens are minted to the treasury, so it can't be zero address
    this.incentivesControllerAddress = ADDRESS_ZERO;

    // set initial asset prices in ETH
    await this.setAssetPriceInOracle(dai, ether(0.001));	// 1 ETH = 1000$ => 1 DAI = 0.001 ETH

    // set initial market rates
    const oneRay = BigNumber.from(10).pow(27);	// 1e27
    await this.setMarketBorrowRate(weth, oneRay.mul(3).div(100));
    await this.setMarketBorrowRate(dai, oneRay.mul(39).div(1000));

    // Deploy WETH reserve
    await this.deployReserve(weth, "WETH", BigNumber.from(18));
    await this.configureReserve(
            weth,
            BigNumber.from(8000),   // base LTV: 80%
            BigNumber.from(8250),   // liquidation threshold: 82.5%
            BigNumber.from(10500),  // liquidation bonus: 105.00%
            BigNumber.from(1000),   // reserve factor: 10%
            true,					// enable borrowing on reserve
            true					// enable stable debts
        );

    // Deploy DAI reserve
    await this.deployReserve(dai, "DAI", BigNumber.from(18));
    await this.configureReserve(
            dai,
            BigNumber.from(7500),   // base LTV: 75%
            BigNumber.from(8000),   // liquidation threshold: 80%
            BigNumber.from(10500),  // liquidation bonus: 105.00%
            BigNumber.from(1000),   // reserve factor: 10%
            true,					// enable borrowing on reserve
            true					// enable stable debts
        );

    /*
		TODO: Move governance to this fixture.
		// Deploy Executor
		this.executor = await this._deployer.external.deployExecutor(
			await this._ownerSigner.getAddress(),
			BigNumber.from(0),
			BigNumber.from(0),
			BigNumber.from(0),
			MAX_UINT_256,
			BigNumber.from(50),
			BigNumber.from(100),
			BigNumber.from(50),
			ether(100)
		);

		this.aaveToken = await this._deployer.external.deployAaveTokenV2Mintable();
		await this.aaveToken.mint(await this._ownerSigner.getAddress(), ether(100000));
		this.stkAaveToken = await this._deployer.external.deployAaveTokenV2Mintable();
		await this.stkAaveToken.mint(await this._ownerSigner.getAddress(), ether(100000));

		this.governanceStrategy = await this._deployer.external.deployGovernanceStrategy(this.aaveToken.address, this.stkAaveToken.address);
		this.aaveGovernanceV2 =  await this._deployer.external.deployAaveGovernanceV2(
		  this.governanceStrategy.address,
		  BigNumber.from(0),
		  await this._ownerSigner.getAddress(),
		  [this.executor.address]
		);

		this.aaveToken.connect(this._ownerSigner).transfer(await getRandomAddress(), 100);
		this.stkAaveToken.connect(this._ownerSigner).transfer(await getRandomAddress(), 100);
		await this._deployer.external.deployAaveV2StakedTokenIncentivesController(
			this.stkAaveToken.address, this.executor.address
		)

		this.incentivesControllerAddress = (await this._deployer.external.deployAaveV2StakedTokenIncentivesController(
			this.stkAaveToken.address, this.executor.address
		)).address;
		*/
  }

  public async deployReserve(
    underlyingAsset: Address,
    underlyingAssetSymbol: string,
    underlyingAssetDecimals: BigNumberish = 18,
    treasuryAddress: Address = this.treasuryAddress,
    incentivesControllerAddress: Address = this.incentivesControllerAddress,
    interestRateStrategyAddress: Address = this.reserveInterestRateStrategy.address
  ): Promise<void> {
    const aToken = await this._deployer.external.deployAaveV2AToken();
    const stableDebtToken = await this._deployer.external.deployAaveV2StableDebtToken();
    const variableDebtToken = await this._deployer.external.deployAaveV2VariableDebtToken();

    await this.lendingPoolConfigurator.batchInitReserve(
      [
        {
          "aTokenImpl": aToken.address,
          "stableDebtTokenImpl": stableDebtToken.address,
          "variableDebtTokenImpl": variableDebtToken.address,
          "underlyingAssetDecimals": underlyingAssetDecimals,
          "interestRateStrategyAddress": interestRateStrategyAddress,
          "underlyingAsset": underlyingAsset,
          "treasury": treasuryAddress,
          "incentivesController": incentivesControllerAddress,
          "underlyingAssetName": underlyingAssetSymbol,
          "aTokenName": `Aave interest bearing ${underlyingAssetSymbol}`,
          "aTokenSymbol": `a${underlyingAssetSymbol}`,
          "variableDebtTokenName": `Aave variable debt bearing ${underlyingAssetSymbol}`,
          "variableDebtTokenSymbol": `variableDebt${underlyingAssetSymbol}`,
          "stableDebtTokenName": `Aave stable debt bearing ${underlyingAssetSymbol}`,
          "stableDebtTokenSymbol": `stableDebt${underlyingAssetSymbol}`,
          "params": "0x",
        },
      ]
    );
  }

  public async configureReserve(
    asset: Address,
    baseLTV: BigNumberish,
    liquidationThreshold: BigNumberish,
    liquidationBonus: BigNumberish,
    reserveFactor: BigNumberish,
    borrowingEnabled: boolean,
    stableBorrowingEnabled: boolean
  ): Promise<void> {

    await this.lendingPoolConfigurator.configureReserveAsCollateral(
      asset,
      baseLTV,
      liquidationThreshold,
      liquidationBonus
    );
    if (borrowingEnabled) {
      await this.lendingPoolConfigurator.enableBorrowingOnReserve(asset, stableBorrowingEnabled);
    }
    await this.lendingPoolConfigurator.setReserveFactor(asset, reserveFactor);
  }

  public async setAssetPriceInOracle(asset: Address, price: BigNumberish): Promise<void> {
    await this.fallbackOracle.setAssetPrice(asset, price);
  }

  public async setMarketBorrowRate(asset: Address, rate: BigNumberish): Promise<void> {
    this.lendingRateOracle.setMarketBorrowRate(asset, rate);
  }
}
