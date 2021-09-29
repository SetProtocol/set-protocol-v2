import { providers, Signer } from "ethers";
import { ether } from "../common";
import { MockContract, smockit } from "@eth-optimism/smock";

import {
  PerpV2AccountBalance,
  PerpV2BaseToken,
  PerpV2ChainlinkPriceFeed,
  PerpV2ClearingHouseConfig,
  PerpV2Exchange,
  PerpV2InsuranceFund,
  PerpV2TestAggregatorV3,
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
} from "../contracts";

import DeployHelper from "../deploys";
import { Address } from "../types";

export interface TokensFixture {
  token0: PerpV2BaseToken;
  token1: PerpV2QuoteToken;
  mockedAggregator0: MockContract;
  mockedAggregator1: MockContract;
}

export interface PoolFixture {
  factory: UniswapV3Factory;
  pool: UniswapV3Pool;
  baseToken: PerpV2BaseToken;
  quoteToken: PerpV2QuoteToken;
}

export interface BaseTokenFixture {
  baseToken: PerpV2BaseToken;
  mockedAggregator: MockContract;
}

export class PerpV2Fixture {
  private _deployer: DeployHelper;
  private _ownerAddress: Address;
  private _ownerSigner: Signer;
  private _feeTier: number = 10000;

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
  public mockedBaseAggregator: MockContract;

  constructor(provider: providers.Web3Provider | providers.JsonRpcProvider, ownerAddress: Address) {
    this._ownerAddress = ownerAddress;
    this._ownerSigner = provider.getSigner(ownerAddress);
    this._deployer = new DeployHelper(this._ownerSigner);
  }

  public async initialize(): Promise<void> {
    this.usdc = await this._deployer.mocks.deployTokenMock(this._ownerAddress, ether(10000), 6);

    const { token0, mockedAggregator0, token1 } = await this._tokensFixture();

    // we assume (base, quote) == (token0, token1)
    this.baseToken = token0;
    this.quoteToken = token1;
    this.mockedBaseAggregator = mockedAggregator0;

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

    this.insuranceFund = await this._deployer.external.deployPerpV2InsuranceFund();
    await this.insuranceFund.initialize(this.usdc.address);

    this.vault = await this._deployer.external.deployPerpV2Vault();

    await this.vault.initialize(
        this.insuranceFund.address,
        this.clearingHouseConfig.address,
        this.accountBalance.address,
        this.exchange.address,
    );

    await this.insuranceFund.setBorrower(this.vault.address);
    await this.accountBalance.setVault(this.vault.address);

    // deploy a pool
    const poolAddr = await this.uniV3Factory.getPool(
      this.baseToken.address,
      this.quoteToken.address,
      this._feeTier
    );

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

  _isAscendingTokenOrder(addr0: string, addr1: string): boolean {
      return addr0.toLowerCase() < addr1.toLowerCase();
  }

  async _createQuoteTokenFixture(name: string, symbol: string): Promise<PerpV2QuoteToken> {
    const quoteToken = await this._deployer.external.deployPerpV2QuoteToken();
    await quoteToken.initialize(name, symbol);
    return quoteToken;
  }

  async _createBaseTokenFixture(name: string, symbol: string): Promise<BaseTokenFixture> {
    const aggregator = await this._deployer.external.deployPerpV2TestAggregatorV3();
    const mockedAggregator = await smockit(aggregator);

    mockedAggregator.smocked.decimals.will.return.with(async () => 6);

    const chainlinkPriceFeed = await this._deployer.external.deployPerpV2ChainlinkPriceFeed();
    await chainlinkPriceFeed.initialize(mockedAggregator.address);

    const baseToken = await this._deployer.external.deployPerpV2BaseToken();
    await baseToken.initialize(name, symbol, chainlinkPriceFeed.address);

    return { baseToken, mockedAggregator };
  }


  async _tokensFixture(): Promise<TokensFixture> {
    const {
      baseToken: randomToken0,
      mockedAggregator: randomMockedAggregator0,
    } = await this._createBaseTokenFixture(
        "RandomTestToken0",
        "randomToken0",
    );

    const {
      baseToken: randomToken1,
      mockedAggregator: randomMockedAggregator1,
    } = await this._createBaseTokenFixture(
        "RandomTestToken1",
        "randomToken1",
    );

    let token0: PerpV2BaseToken;
    let token1: PerpV2QuoteToken;
    let mockedAggregator0: MockContract;
    let mockedAggregator1: MockContract;

    if (this._isAscendingTokenOrder(randomToken0.address, randomToken1.address)) {
        token0 = randomToken0;
        mockedAggregator0 = randomMockedAggregator0;
        token1 = randomToken1 as PerpV2VirtualToken as PerpV2QuoteToken;
        mockedAggregator1 = randomMockedAggregator1;
    } else {
        token0 = randomToken1;
        mockedAggregator0 = randomMockedAggregator1;
        token1 = randomToken0 as PerpV2VirtualToken as PerpV2QuoteToken;
        mockedAggregator1 = randomMockedAggregator0;
    }
    return {
        token0,
        mockedAggregator0,
        token1,
        mockedAggregator1,
    };
  }
}
