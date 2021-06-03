import DeployHelper from "@utils/deploys";
import { JsonRpcProvider, Web3Provider } from "@ethersproject/providers";
import { BigNumber, BigNumberish, Signer } from "ethers";
import { Address } from "../types";
import { Account } from "../test/types";
import { UniswapV3Factory } from "../../typechain/UniswapV3Factory";
import { SwapRouter } from "../../typechain/SwapRouter";
import { NonfungiblePositionManager } from "../../typechain/NonfungiblePositionManager";
import { UniswapV3Pool } from "../../typechain/UniswapV3Pool";
import { UniswapV3Pool__factory } from "../../typechain/factories/UniswapV3Pool__factory";
import { Quoter } from "../../typechain/Quoter";

export class UniswapV3Fixture {

  private _deployer: DeployHelper;
  private _ownerSigner: Signer;

  public factory: UniswapV3Factory;
  public swapRouter: SwapRouter;
  public nftPositionManager: NonfungiblePositionManager;
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
    this.nftPositionManager = await this._deployer.external.deployNftPositionManager(this.factory.address, _weth);
    this.quoter = await this._deployer.external.deployQuoter(this.factory.address, _weth);

    this.wethDaiPool = await this.createNewPair(_weth, _dai, 3000, BigNumber.from("1490848768284521510823413542"));
    this.wethWbtcPool = await this.createNewPair(_weth, _wbtc, 3000, BigNumber.from("29401863719336700257425437085560862"));
  }

  public async createNewPair(_token0: Address, _token1: Address, _fee: BigNumberish, _sqrtPriceX96: BigNumberish): Promise<UniswapV3Pool> {
    if (BigNumber.from(_token0).gt(BigNumber.from(_token1))) {
      const tmp  = _token0;
      _token0 = _token1;
      _token1 = tmp;
    }

    await this.nftPositionManager.createAndInitializePoolIfNecessary(_token0, _token1, _fee, _sqrtPriceX96);
    const poolAddress = await this.factory.getPool(_token0, _token1, 3000);

    return UniswapV3Pool__factory.connect(poolAddress, this._ownerSigner);
  }
}