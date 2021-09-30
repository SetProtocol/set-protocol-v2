import {
  utils,
  providers,
  constants,
  Signer,
  BigNumber,
  BigNumberish
} from "ethers";

import { encodeSqrtRatioX96 } from "@uniswap/v3-sdk";
import JSBI from "jsbi";

import { ether } from "../common";
import { Account } from "../test/types";

import {
  PerpV2AccountBalance,
  PerpV2BaseToken,
  PerpV2ChainlinkPriceFeed,
  PerpV2ClearingHouseConfig,
  PerpV2Exchange,
  PerpV2InsuranceFund,
  PerpV2Vault,
  PerpV2OrderBook,
  PerpV2MarketRegistry,
  PerpV2ClearingHouse,
  PerpV2QuoteToken,
  PerpV2VirtualToken
} from "../contracts/perpV2";

import {
  UniswapV3Factory,
  UniswapV3Pool
} from "../contracts/uniswapV3";

import {
  StandardTokenMock,
  ChainlinkAggregatorMock
} from "../contracts";

import DeployHelper from "../deploys";
import { Address } from "../types";

export interface TokensFixture {
  token0: PerpV2BaseToken;
  token1: PerpV2QuoteToken;
  mockAggregator0: ChainlinkAggregatorMock;
  mockAggregator1: ChainlinkAggregatorMock;
}

export interface PoolFixture {
  factory: UniswapV3Factory;
  pool: UniswapV3Pool;
  baseToken: PerpV2BaseToken;
  quoteToken: PerpV2QuoteToken;
}

export interface BaseTokenFixture {
  baseToken: PerpV2BaseToken;
  mockAggregator: ChainlinkAggregatorMock;
}

const TEN_THOUSAND = "10000";
const ONE_MILLION = "1000000";

export class PerpV2Fixture {
  private _deployer: DeployHelper;
  private _ownerAddress: Address;
  private _ownerSigner: Signer;
  private _feeTier: number = 10000; // From perp fixtures
  private _oracleDecimals: number = 6; // From perp fixtures

  public usdc: StandardTokenMock;
  public clearingHouse: PerpV2ClearingHouse;
  public orderBook: PerpV2OrderBook;
  public accountBalance: PerpV2AccountBalance;
  public marketRegistry: PerpV2MarketRegistry;
  public clearingHouseConfig: PerpV2ClearingHouseConfig;

  public exchange: PerpV2Exchange;
  public vault: PerpV2Vault;
  public insuranceFund: PerpV2InsuranceFund;
  public uniV3Factory: UniswapV3Factory;
  public pool: UniswapV3Pool;
  public quoteToken: PerpV2QuoteToken;
  public baseToken: PerpV2BaseToken;
  public mockBaseAggregator: ChainlinkAggregatorMock;

  constructor(provider: providers.Web3Provider | providers.JsonRpcProvider, ownerAddress: Address) {
    this._ownerAddress = ownerAddress;
    this._ownerSigner = provider.getSigner(ownerAddress);
    this._deployer = new DeployHelper(this._ownerSigner);
  }

  public async initialize(): Promise<void> {
    this.usdc = await this._deployer.mocks.deployTokenMock(this._ownerAddress, ether("100000000000000"), 6);

    const { token0, mockAggregator0, token1 } = await this._tokensFixture();

    // we assume (base, quote) == (token0, token1)
    this.baseToken = token0;
    this.quoteToken = token1;
    this.mockBaseAggregator = mockAggregator0;

    // deploy UniV3 factory
    this.uniV3Factory = await this._deployer.external.deployUniswapV3Factory();

    this.clearingHouseConfig = await this._deployer.external.deployPerpV2ClearingHouseConfig();
    await this.clearingHouseConfig.initialize();

    // prepare uniswap factory
    await this.uniV3Factory.createPool(
      this.baseToken.address,
      this.quoteToken.address,
      this._feeTier
    );

    this.marketRegistry = await this._deployer.external.deployPerpV2MarketRegistry();
    await this.marketRegistry.initialize(this.uniV3Factory.address, this.quoteToken.address);

    this.orderBook = await this._deployer.external.deployPerpV2OrderBook();
    await this.orderBook.initialize(this.marketRegistry.address, this.quoteToken.address);

    this.insuranceFund = await this._deployer.external.deployPerpV2InsuranceFund();
    await this.insuranceFund.initialize(this.usdc.address);

    this.accountBalance = await this._deployer.external.deployPerpV2AccountBalance();
    this.exchange = await this._deployer.external.deployPerpV2Exchange();

    // deploy exchange
    await this.exchange.initialize(
      this.marketRegistry.address,
      this.orderBook.address,
      this.clearingHouseConfig.address,
      this.insuranceFund.address,
    );

    this.exchange.setAccountBalance(this.accountBalance.address);
    await this.orderBook.setExchange(this.exchange.address);

    await this.accountBalance.initialize(
      this.clearingHouseConfig.address,
      this.marketRegistry.address,
      this.exchange.address
    );

    this.vault = await this._deployer.external.deployPerpV2Vault();

    await this.vault.initialize(
        this.insuranceFund.address,
        this.clearingHouseConfig.address,
        this.accountBalance.address,
        this.exchange.address,
    );

    await this.insuranceFund.setBorrower(this.vault.address);
    await this.accountBalance.setVault(this.vault.address);

    // get pool instance
    const poolAddr = await this.uniV3Factory.getPool(
      this.baseToken.address,
      this.quoteToken.address,
      this._feeTier
    );

    this.pool = await this._deployer.external.getUniswapV3PoolInstance(poolAddr);

    await this.baseToken.addWhitelist(poolAddr);
    await this.quoteToken.addWhitelist(poolAddr);

    // deploy clearingHouse
    this.clearingHouse = await this._deployer.external.deployPerpV2ClearingHouse();

    await this.clearingHouse.initialize(
        this.clearingHouseConfig.address,
        this.vault.address,
        this.quoteToken.address,
        this.uniV3Factory.address,
        this.exchange.address,
        this.accountBalance.address,
    );

    await this.quoteToken.mintMaximumTo(this.clearingHouse.address);
    await this.baseToken.mintMaximumTo(this.clearingHouse.address);

    await this.quoteToken.addWhitelist(this.clearingHouse.address);
    await this.baseToken.addWhitelist(this.clearingHouse.address);

    await this.marketRegistry.setClearingHouse(this.clearingHouse.address);
    await this.orderBook.setClearingHouse(this.clearingHouse.address);
    await this.exchange.setClearingHouse(this.clearingHouse.address);
    await this.accountBalance.setClearingHouse(this.clearingHouse.address);
  }

  async deposit(sender: Account, amount: BigNumber, token: StandardTokenMock): Promise<void> {
    const decimals = await token.decimals();
    const parsedAmount = utils.parseUnits("1000", decimals);
    await token.connect(sender.wallet).approve(this.vault.address, parsedAmount);
    await this.vault.connect(sender.wallet).deposit(token.address, parsedAmount);
  }

  public async initializePoolWithLiquidityWide(
    maker: Account,
    baseTokenAmount: BigNumberish,
    quoteTokenAmount: BigNumberish
  ): Promise<void> {
      await this.mockBaseAggregator.setRoundData(0, utils.parseUnits("10", 6), 0, 0, 0 );

      await this.pool.initialize(
        this._encodePriceSqrt(quoteTokenAmount, baseTokenAmount)
      );

      const tickSpacing = await this.pool.tickSpacing();
      const lowerTick = this._getMinTick(tickSpacing);
      const upperTick = this._getMaxTick(tickSpacing);

      await this.marketRegistry.addPool(this.baseToken.address, 10000);
      await this.marketRegistry.setFeeRatio(this.baseToken.address, 10000);

      // prepare collateral for maker
      const makerCollateralAmount = utils.parseUnits(ONE_MILLION, this._oracleDecimals);
      const mintBufferAmount = utils.parseUnits(TEN_THOUSAND, this._oracleDecimals);
      await this.usdc.mint(maker.address, makerCollateralAmount.add(mintBufferAmount));
      await this.deposit(maker, makerCollateralAmount, this.usdc);

      // maker add liquidity at ratio
      await this.clearingHouse.connect(maker.wallet).addLiquidity({
          baseToken: this.baseToken.address,
          base: utils.parseEther(baseTokenAmount.toString()),
          quote: utils.parseEther(quoteTokenAmount.toString()),
          lowerTick,
          upperTick,
          minBase: 0,
          minQuote: 0,
          deadline: constants.MaxUint256,
      });
  }

  public async initializePoolWithLiquidityWithinTicks(
    maker: Account,
    baseTokenAmount: BigNumberish,
    quoteTokenAmount: BigNumberish,
    lowerTick: number = 0,
    upperTick: number = 10000
  ): Promise<void> {
      await this.pool.initialize(
        this._encodePriceSqrt(quoteTokenAmount, baseTokenAmount)
      );

      await this.marketRegistry.addPool(this.baseToken.address, baseTokenAmount);
      await this.marketRegistry.setFeeRatio(this.baseToken.address, baseTokenAmount);

      // prepare collateral for maker
      const makerCollateralAmount = utils.parseUnits(ONE_MILLION, this._oracleDecimals);
      await this.usdc.mint(maker.address, makerCollateralAmount);
      await this.vault.connect(maker.address).deposit(this.usdc.address, makerCollateralAmount);

      // maker add liquidity at ratio
      await this.clearingHouse.connect(maker.address).addLiquidity({
          baseToken: this.baseToken.address,
          base: utils.parseEther(baseTokenAmount.toString()),
          quote: utils.parseEther(quoteTokenAmount.toString()),
          lowerTick,
          upperTick,
          minBase: 0,
          minQuote: 0,
          deadline: constants.MaxUint256,
      });
  }

  public async setBaseTokenOraclePrice(price: string): Promise<void> {
    await this.mockBaseAggregator.setRoundData(0, utils.parseUnits(price, this._oracleDecimals), 0, 0, 0);
  }

  public async getAMMBaseTokenPrice(): Promise<String> {
    const sqrtPriceX96 = (await this.pool.slot0()).sqrtPriceX96;
    const priceX86 = JSBI.BigInt(sqrtPriceX96.toString());
    const squaredPrice = JSBI.multiply(priceX86, priceX86);
    const decimalsRatio = 1e18;
    const denominator = JSBI.exponentiate(JSBI.BigInt(2), JSBI.BigInt(192));
    const scaledPrice = JSBI.multiply(squaredPrice, JSBI.BigInt(decimalsRatio));
    return JSBI.divide(scaledPrice, denominator).toString();
  }

  // UniV3 AddLiquidity helpers
  private _getMinTick(tickSpacing: number) {
    return Math.ceil(-887272 / tickSpacing) * tickSpacing;
  }

  private _getMaxTick(tickSpacing: number) {
    return Math.floor(887272 / tickSpacing) * tickSpacing;
  }

  private _encodePriceSqrt(token1Amount: BigNumberish, token0Amount: BigNumberish): BigNumber {
    return BigNumber.from(
      encodeSqrtRatioX96(token1Amount.toString(), token0Amount.toString()).toString()
    );
  }

  // Base & Quote token helpers
  async _createQuoteTokenFixture(name: string, symbol: string): Promise<PerpV2QuoteToken> {
    const quoteToken = await this._deployer.external.deployPerpV2QuoteToken();
    await quoteToken.initialize(name, symbol);
    return quoteToken;
  }

  async _createBaseTokenFixture(name: string, symbol: string): Promise<BaseTokenFixture> {
    const mockAggregator = await this._deployer.mocks.deployChainlinkAggregatorMock(6);

    const chainlinkPriceFeed = await this._deployer.external.deployPerpV2ChainlinkPriceFeed();
    await chainlinkPriceFeed.initialize(mockAggregator.address);

    const baseToken = await this._deployer.external.deployPerpV2BaseToken();
    await baseToken.initialize(name, symbol, chainlinkPriceFeed.address);

    return { baseToken, mockAggregator };
  }

  async _tokensFixture(): Promise<TokensFixture> {
    const {
      baseToken: randomToken0,
      mockAggregator: randomMockAggregator0,
    } = await this._createBaseTokenFixture(
        "RandomTestToken0",
        "randomToken0",
    );

    const {
      baseToken: randomToken1,
      mockAggregator: randomMockAggregator1,
    } = await this._createBaseTokenFixture(
        "RandomTestToken1",
        "randomToken1",
    );

    let token0: PerpV2BaseToken;
    let token1: PerpV2QuoteToken;
    let mockAggregator0: ChainlinkAggregatorMock;
    let mockAggregator1: ChainlinkAggregatorMock;

    if (this._isAscendingTokenOrder(randomToken0.address, randomToken1.address)) {
        token0 = randomToken0;
        mockAggregator0 = randomMockAggregator0;
        token1 = randomToken1 as PerpV2VirtualToken as PerpV2QuoteToken;
        mockAggregator1 = randomMockAggregator1;
    } else {
        token0 = randomToken1;
        mockAggregator0 = randomMockAggregator1;
        token1 = randomToken0 as PerpV2VirtualToken as PerpV2QuoteToken;
        mockAggregator1 = randomMockAggregator0;
    }
    return {
        token0,
        mockAggregator0,
        token1,
        mockAggregator1,
    };
  }

  private _isAscendingTokenOrder(addr0: string, addr1: string): boolean {
      return addr0.toLowerCase() < addr1.toLowerCase();
  }
}
