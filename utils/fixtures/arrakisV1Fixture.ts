import DeployHelper from "../deploys";
import { Signer, providers, BigNumber } from "ethers";
import { Address } from "../types";
import { Account } from "../test/types";

import {
  ArrakisFactoryV1,
  GUniRouter,
  ArrakisVaultV1
} from "../contracts/arrakis";

import { UniswapV3Fixture } from "@utils/fixtures";
import { StandardTokenMock } from "../../typechain/StandardTokenMock";
import { WETH9 } from "../../typechain/WETH9";

type Token = StandardTokenMock | WETH9;

export class ArrakisV1Fixture {

  private _deployer: DeployHelper;
  private _ownerSigner: Signer;

  public factory: ArrakisFactoryV1;
  public router: GUniRouter;

  public wethDaiPool: ArrakisVaultV1;
  public wethWbtcPool: ArrakisVaultV1;

  /**
   * Instantiates a new ArrakisFixture
   *
   * @param provider      the ethers web3 provider to use
   * @param ownerAddress  the address of the owner
   */
  constructor(provider: providers.Web3Provider | providers.JsonRpcProvider, ownerAddress: Address) {
    this._ownerSigner = provider.getSigner(ownerAddress);
    this._deployer = new DeployHelper(this._ownerSigner);
  }

  /**
   * Deploys contracts and creates weth-dai and weth-wbtc arrakis pools
   *
   * @param _owner              the owner of the deployed Arrakis system
   * @param _uniswapV3Factory   uniswapV3 factory address
   * @param _weth               weth address
   * @param _wethPrice          weth price
   * @param _wbtc               wbtc address
   * @param _wbtcPrice          wbtc price
   * @param _dai                dai address
   */
  public async initialize(
    _owner: Account,
    _uniswapV3Setup: UniswapV3Fixture,
    _weth: Token,
    _wethPrice: number,
    _wbtc: Token,
    _wbtcPrice: number,
    _dai: Token
  ): Promise<void> {
    await this.deployVaultAndFactoryAndinitialize(_owner, _uniswapV3Setup);
    this.router = await this._deployer.external.deployGUniRouter(_uniswapV3Setup.factory.address, _weth.address);

    this.wethDaiPool = await this.createNewPair(_owner, _uniswapV3Setup,  _weth, _dai, 3000, _wethPrice);
    this.wethWbtcPool = await this.createNewPair(_owner, _uniswapV3Setup, _weth, _wbtc, 3000, _wethPrice / _wbtcPrice);
  }

  /**
   * Creates and initializes a new arrakis factory
   *
   * @param _owner          the owner of the deployed Arrakis system
   * @param _uniswapV3Setup uniswapV3Fixture
   * @returns               void promise
   */
  public async deployVaultAndFactoryAndinitialize(
    _owner: Account,
    _uniswapV3Setup: UniswapV3Fixture
  ): Promise<void> {
    const vaultImplementation = await this._deployer.external.deployArrakisVaultV1(_owner.address, _owner.address);
    this.factory = await this._deployer.external.deployArrakisFactoryV1(_uniswapV3Setup.factory.address);
    await this.factory.initialize(vaultImplementation.address, _owner.address);
  }

  /**
   * Creates and initializes a new arrakis vault pool
   *
   * @param _owner          the owner of the deployed Arrakis system
   * @param _uniswapV3Setup uniswapV3Fixture
   * @param _token0         first token
   * @param _token1         second token
   * @param _fee            fee tier of either 500, 3000, or 10000
   * @param _ratio          the initial price ratio of the pool equal to priceToken0 / priceToken1
   * @returns               a new Arrakis Vault holding UniswapV3 position on given tokens
   */
  public async createNewPair(
    _owner: Account,
    _uniswapV3Setup: UniswapV3Fixture,
    _token0: Token,
    _token1: Token,
    _fee: number,
    _ratio: number,
  ): Promise<ArrakisVaultV1> {
    await _uniswapV3Setup.createNewPair(_token0, _token1, _fee, _ratio);

    const tickSpacing = _fee / 50;  // ticks can only be initialized if they are a multiple of fee / 50
    const maxTick = 887272;   // the maximum tick index that Uniswap V3 allows
    const maxValidTick = Math.floor(maxTick / tickSpacing) * tickSpacing;   // valid ticks must be a multiple of tickSpacing
    const minValidTick = Math.ceil(-maxTick / tickSpacing) * tickSpacing;

    const txReceipt = await (
      await this.factory.deployVault(
        _token0.address,
        _token1.address,
        _fee,
        _owner.address,
        0,
        minValidTick,
        maxValidTick
      )
    ).wait();

    const poolAddress = txReceipt.events![2].args!.pool;
    return this._deployer.external.getArrakisVaultV1Instance(poolAddress);
  }

  /**
   * Sorts token amounts in order of token address
   *
   * @param _tokenOne     first token address
   * @param _tokenTwo     second token address
   * @param _amountOne    first token amount
   * @param _amountTwo    second token amount
   * @returns             amounts sorted in order of token address
   */
  public getOrderedAmount(_tokenOne: Address, _tokenTwo: Address, _amountOne: BigNumber, _amountTwo: BigNumber): [BigNumber, BigNumber, boolean] {
    return _tokenOne.toLowerCase() < _tokenTwo.toLowerCase() ? [_amountOne, _amountTwo, false] : [_amountTwo, _amountOne, true];
  }
}
