import DeployHelper from "../deploys";
// import { MAX_UINT_256 } from "../constants";
import { Signer, providers } from "ethers";
import { Address } from "../types";
import { Account } from "../test/types";

import {
  ArrakisFactoryV1,
  GUniRouter,
  ArrakisVaultV1
} from "../contracts/arrakis";

// import { UniswapV3Pool } from "../contracts/uniswapV3";
import { UniswapV3Fixture } from "@utils/fixtures";
// import { UniswapV3Pool__factory } from "../../typechain/factories/UniswapV3Pool__factory";
// import { ether } from "../index";
import { StandardTokenMock } from "../../typechain/StandardTokenMock";
import { WETH9 } from "../../typechain/WETH9";
// import { parseEther } from "ethers/lib/utils";

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
    this.factory = await this._deployer.external.deployArrakisFactoryV1(_uniswapV3Setup.factory.address);
    this.router = await this._deployer.external.deployGUniRouter(_uniswapV3Setup.factory.address, _weth.address);

    this.wethDaiPool = await this.createNewPair(_owner, _uniswapV3Setup,  _weth, _dai, 3000, _wethPrice);
    this.wethWbtcPool = await this.createNewPair(_owner, _uniswapV3Setup, _weth, _wbtc, 3000, _wethPrice / _wbtcPrice);
  }

  /**
   * Creates and initializes a new arrakis vault pool
   *
   * @param _owner          the owner of the deployed Arrakis system
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
}
