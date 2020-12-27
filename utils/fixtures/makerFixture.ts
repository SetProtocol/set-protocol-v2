import DeployHelper from "../deploys";
import { ethers, Signer } from "ethers";
import { JsonRpcProvider, Web3Provider } from "ethers/providers";
import { Address, Account } from "../types"

import {
  ether,
} from "@utils/index";

import {
  Mkr,
  PollingEmitter
} from "../contracts/maker";

export class MakerFixture {
  private _deployer: DeployHelper;
  private _provider: Web3Provider | JsonRpcProvider;
  private _ownerSigner: Signer;

  public owner: Account;

  public mkr: Mkr;

  public makerPollingEmitter: PollingEmitter;

  constructor(provider: Web3Provider | JsonRpcProvider, ownerAddress: Address) {
    this._ownerSigner = provider.getSigner(ownerAddress);
    this._provider = provider;
    this._deployer = new DeployHelper(this._ownerSigner);
  }

  public async initialize(_owner: Account): Promise<void> {
    this.owner = _owner;

    const mkrSymbol = ethers.utils.formatBytes32String('MKR');
    this.mkr = await this._deployer.external.deployMkr(mkrSymbol);
    await this.mkr.mint(this.owner.address, ether(20000000));

    this.makerPollingEmitter = await this._deployer.external.deployMakerPollingEmitter();
  }
}
