import DeployHelper from "../deploys";
import { Signer, providers, BigNumber } from "ethers";
import { Address } from "../types";
import { Account } from "../test/types";

import dependencies from "../deploys/dependencies";
import { Uni } from "../../typechain/Uni";
import { VelodromeFactory } from "../../typechain/VelodromeFactory";
import { VelodromePair } from "../../typechain/VelodromePair";
import { VelodromeRouter } from "../../typechain/VelodromeRouter";
import { VelodromePair__factory } from "../../typechain/factories/VelodromePair__factory";

export class VelodromeFixture {
  private _deployer: DeployHelper;
  private _provider: providers.Web3Provider | providers.JsonRpcProvider;
  private _ownerSigner: Signer;

  public owner: Account;
  public uni: Uni;
  public factory: VelodromeFactory;
  public pair: VelodromePair;
  public router: VelodromeRouter;

  public uniWethPool: VelodromePair;

  constructor(provider: providers.Web3Provider | providers.JsonRpcProvider, ownerAddress: Address) {
    this._ownerSigner = provider.getSigner(ownerAddress);
    this._provider = provider;
    this._deployer = new DeployHelper(this._ownerSigner);
  }

  public async initialize(_owner: Account, _weth: Address): Promise<void> {
    this.owner = _owner;
    this.factory = await this._deployer.external.deployVelodromeFactory();
    this.router = await this._deployer.external.deployVelodromeRouter(this.factory.address, _weth);

    const lastBlock = await this._provider.getBlock("latest");
    this.uni = await this._deployer.external.deployUni(
      this.owner.address,
      this.owner.address,
      BigNumber.from(lastBlock.timestamp).add(2),
    );

    this.uniWethPool = await this.createNewPair(_weth, this.uni.address, false);
  }

  public async createNewPair(
    _tokenOne: Address,
    _tokenTwo: Address,
    stable: boolean,
  ): Promise<VelodromePair> {
    await this.factory.createPair(_tokenOne, _tokenTwo, stable);
    const poolAddress = await this.factory.allPairs((await this.factory.allPairsLength()).sub(1));
    return await new VelodromePair__factory(this._ownerSigner).attach(poolAddress);
  }

  public getTokenOrder(_tokenOne: Address, _tokenTwo: Address): [Address, Address] {
    return _tokenOne.toLowerCase() < _tokenTwo.toLowerCase()
      ? [_tokenOne, _tokenTwo]
      : [_tokenTwo, _tokenOne];
  }

  public getForkedVelodromeRouter(): VelodromeRouter {
    return this._deployer.external.getForkedVelodromeRouter(dependencies.VELODROME_ROUTER[10]);
  }
}
