import DeployHelper from "@utils/deploys";
import { JsonRpcProvider, Web3Provider } from "@ethersproject/providers";
import { BigNumberish, Signer } from "ethers";
import { Address } from "../types";
import { Account } from "../test/types";
import { UniswapV3Factory } from "@typechain/UniswapV3Factory";
import { SwapRouter } from "@typechain/SwapRouter";

export class UniswapV3Fixture {

  private _deployer: DeployHelper;
  private _ownerSigner: Signer;
  public factory: UniswapV3Factory;
  public swapRouter: SwapRouter;

  constructor(provider: Web3Provider | JsonRpcProvider, ownerAddress: Address) {
    this._ownerSigner = provider.getSigner(ownerAddress);
    this._deployer = new DeployHelper(this._ownerSigner);
  }

  public async initialize(_owner: Account, _weth: Address): Promise<void> {
    this.factory = await this._deployer.external.deployUniswapV3Factory();
    this.swapRouter = await this._deployer.external.deploySwapRouter(this.factory.address, _weth);
  }

  public async createNewPair(_tokenOne: Address, _tokenTwo: Address, _fee: BigNumberish): Promise<void> {
    const tx = await this.factory.createPool(_tokenOne, _tokenTwo, _fee);
    tx.data;
  }
}