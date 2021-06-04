import DeployHelper from "@utils/deploys";
import { MAX_UINT_256 } from "@utils/constants";
import { JsonRpcProvider, Web3Provider } from "@ethersproject/providers";
import { BigNumber, BigNumberish, Signer } from "ethers";
import { Address } from "../types";
import { Account } from "../test/types";

import {
  UniswapV3Factory,
  SwapRouter,
  NonfungiblePositionManager,
  UniswapV3Pool,
  Quoter,
  NFTDescriptor
} from "../contracts/uniswapV3";

import { UniswapV3Pool__factory } from "../../typechain/factories/UniswapV3Pool__factory";

export class UniswapV3Fixture {

  private _deployer: DeployHelper;
  private _ownerSigner: Signer;

  public factory: UniswapV3Factory;
  public swapRouter: SwapRouter;
  public nftPositionManager: NonfungiblePositionManager;
  public nftDescriptor: NFTDescriptor;
  public quoter: Quoter;

  public wethDaiPool: UniswapV3Pool;
  public wethWbtcPool: UniswapV3Pool;

  /**
   * Instantiates a new UniswapV3Fixture
   *
   * @param provider      the ethers web3 provider to use
   * @param ownerAddress  the address of the owner
   */
  constructor(provider: Web3Provider | JsonRpcProvider, ownerAddress: Address) {
    this._ownerSigner = provider.getSigner(ownerAddress);
    this._deployer = new DeployHelper(this._ownerSigner);
  }

  /**
   * Deploys contracts and creates weth-dai and weth-wbtc pools
   *
   * @param _owner  the owner of the deployed Uniswap V3 system
   * @param _weth   weth address
   * @param _wbtc   wbtc address
   * @param _dai    dai address
   */
  public async initialize(_owner: Account, _weth: Address, _wbtc: Address, _dai: Address): Promise<void> {
    this.factory = await this._deployer.external.deployUniswapV3Factory();
    this.swapRouter = await this._deployer.external.deploySwapRouter(this.factory.address, _weth);
    this.nftDescriptor = await this._deployer.external.deployNFTDescriptor();
    this.nftPositionManager = await this._deployer.external.deployNftPositionManager(this.factory.address, _weth, this.nftDescriptor.address);
    this.quoter = await this._deployer.external.deployQuoter(this.factory.address, _weth);

    this.wethDaiPool = await this.createNewPair(_weth, _dai, 3000, BigNumber.from("1490848768284521510823413542"));
    this.wethWbtcPool = await this.createNewPair(_weth, _wbtc, 3000, BigNumber.from("29401863719336700257425437085560862"));
  }

  /**
   * Creates and initializes a new pool
   *
   * @param _token0         address of the first token
   * @param _token1         address of the second token
   * @param _fee            fee tier of either 500, 3000, or 10000
   * @param _sqrtPriceX96   the initial price parameter equal to sqrt(priceToken0 / priceToken1) * 2^96
   * @returns
   */
  public async createNewPair(_token0: Address, _token1: Address, _fee: BigNumberish, _sqrtPriceX96: BigNumberish): Promise<UniswapV3Pool> {
    [ _token0, _token1 ] = this.getTokenOrder(_token0, _token1);

    await this.nftPositionManager.createAndInitializePoolIfNecessary(_token0, _token1, _fee, _sqrtPriceX96);

    return this.getPool(_token0, _token1, _fee);
  }

  /**
   * Adds liquidity across the widest range, emulating a single Uniswap V2 LP
   *
   * @param _token0     address of token 1
   * @param _token1     address of token 2
   * @param _fee        the fee tier of either 500, 3000, or 10000
   * @param _amount0    maximum amount of token 1 used
   * @param _amount1    maximum amount of token 2 used
   * @param _recipient  the recipient of the LP NFT
   */
  public async addLiquidityWide(
    _token0: Address,
    _token1: Address,
    _fee: number,
    _amount0: BigNumber,
    _amount1: BigNumber,
    _recipient: Address
  ): Promise<void> {

    if (_token0.toLowerCase() > _token1.toLowerCase()) {
      [ _amount0, _amount1 ] = [ _amount1, _amount0 ];
    }

    [ _token0, _token1 ] = this.getTokenOrder(_token0, _token1);

    const tickSpacing = _fee / 50;  // ticks can only be initialized if they are a multiple of fee / 50
    const maxTick = 887272;   // the maximum tick index that Uniswap V3 allows
    const maxValidTick = Math.floor(maxTick / tickSpacing) * tickSpacing;   // valid ticks must be a multiple of tickSpacing
    const minValidTick = Math.ceil(-maxTick / tickSpacing) * tickSpacing;   // valid ticks must be a multiple of tickSpacing

    await this.nftPositionManager.connect(this._ownerSigner).mint({
      fee: _fee,
      token0: _token0,
      token1: _token1,
      tickLower: minValidTick,
      tickUpper: maxValidTick,
      amount0Desired: _amount0,
      amount1Desired: _amount1,
      amount0Min: 0,
      amount1Min: 0,
      deadline: MAX_UINT_256,
      recipient: _recipient,
    });
  }

  /**
   * Fetches a UniswapV3Pool
   *
   * @param _token0   address of the first token
   * @param _token1   address of the second token
   * @param _fee      fee tier of either 500, 3000, or 10000
   * @returns         the UniswapV3Pool
   */
  public async getPool(_token0: Address, _token1: Address, _fee: BigNumberish): Promise<UniswapV3Pool> {
    [ _token0, _token1 ] = this.getTokenOrder(_token0, _token1);
    const poolAddress = await this.factory.getPool(_token0, _token1, _fee);
    return UniswapV3Pool__factory.connect(poolAddress, this._ownerSigner);
  }

  /**
   * Gets the proper order of the tokens since Uniswap requires that
   * tokens be passed to it in a particular order for many of its functions
   *
   * @param _token0   first token
   * @param _token1   second token
   * @returns         [ first, second ]
   */
  public getTokenOrder(_token0: Address, _token1: Address): [Address, Address] {
    return _token0.toLowerCase() < _token1.toLowerCase() ? [_token0, _token1] : [_token1, _token0];
  }
}