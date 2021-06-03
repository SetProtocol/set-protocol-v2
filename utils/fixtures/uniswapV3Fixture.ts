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

  constructor(provider: Web3Provider | JsonRpcProvider, ownerAddress: Address) {
    this._ownerSigner = provider.getSigner(ownerAddress);
    this._deployer = new DeployHelper(this._ownerSigner);
  }

  public async initialize(_owner: Account, _weth: Address, _wbtc: Address, _dai: Address): Promise<void> {
    this.factory = await this._deployer.external.deployUniswapV3Factory();
    this.swapRouter = await this._deployer.external.deploySwapRouter(this.factory.address, _weth);
    this.nftDescriptor = await this._deployer.external.deployNFTDescriptor();
    this.nftPositionManager = await this._deployer.external.deployNftPositionManager(this.factory.address, _weth, this.nftDescriptor.address);
    this.quoter = await this._deployer.external.deployQuoter(this.factory.address, _weth);

    this.wethDaiPool = await this.createNewPair(_weth, _dai, 3000, BigNumber.from("1490848768284521510823413542"));
    this.wethWbtcPool = await this.createNewPair(_weth, _wbtc, 3000, BigNumber.from("29401863719336700257425437085560862"));
  }

  public async createNewPair(_token0: Address, _token1: Address, _fee: BigNumberish, _sqrtPriceX96: BigNumberish): Promise<UniswapV3Pool> {
    [ _token0, _token1 ] = this.getTokenOrder(_token0, _token1);

    await this.nftPositionManager.createAndInitializePoolIfNecessary(_token0, _token1, _fee, _sqrtPriceX96);

    return this.getPool(_token0, _token1, _fee);
  }

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

    const tickSpacing = _fee / 50;
    const maxTick = Math.floor(887272 / tickSpacing) * tickSpacing;
    const minTick = Math.ceil(-maxTick / tickSpacing) * tickSpacing;

    await this.nftPositionManager.connect(this._ownerSigner).mint({
      fee: _fee,
      token0: _token0,
      token1: _token1,
      tickLower: minTick,
      tickUpper: maxTick,
      amount0Desired: _amount0,
      amount1Desired: _amount1,
      amount0Min: 0,
      amount1Min: 0,
      deadline: MAX_UINT_256,
      recipient: _recipient,
    });
  }

  public async getPool(_token0: Address, _token1: Address, _fee: BigNumberish): Promise<UniswapV3Pool> {
    const poolAddress = await this.factory.getPool(_token0, _token1, _fee);
    return UniswapV3Pool__factory.connect(poolAddress, this._ownerSigner);
  }

  public getTokenOrder(_token0: Address, _token1: Address): [Address, Address] {
    return _token0.toLowerCase() < _token1.toLowerCase() ? [_token0, _token1] : [_token1, _token0];
  }
}