import { Signer } from "@ethersproject/abstract-signer";
import { JsonRpcProvider, Web3Provider } from "@ethersproject/providers";
import { ether } from "@utils/common";
import DeployHelper from "@utils/deploys";
import { Account } from "@utils/test/types";
import { Address } from "@utils/types";

import { StandardTokenMock, WETH9 } from "../contracts/index";
import { BVault, WeightedPoolFactory } from "../contracts/balancerV2";
import { BPoolV2__factory } from "../../typechain/factories/BPoolV2__factory";
import { BigNumber } from "@ethersproject/bignumber";

export class BalancerV2Fixture {
  private _deployer: DeployHelper;
  private _ownerSigner: Signer;

  public owner: Account;

  public vault: BVault;
  public weightedPoolFactory: WeightedPoolFactory;
  public wethDaiPoolId: string;

  constructor(provider: Web3Provider | JsonRpcProvider, ownerAddress: Address) {
    this._ownerSigner = provider.getSigner(ownerAddress);
    this._deployer = new DeployHelper(this._ownerSigner);
  }

  public async initialize(_owner: Account, _weth: WETH9, _dai: StandardTokenMock): Promise<void> {
    this.owner = _owner;

    this.vault = await this._deployer.external.deployBVault(_weth.address);
    this.weightedPoolFactory = await this._deployer.external.deployWeightedPoolFactory(this.vault.address);

    const tokens = [ _weth.address, _dai.address ];
    tokens.sort((a, b) => parseInt(a) - parseInt(b));

    this.wethDaiPoolId = await this.createPool(
      [ _weth.address, _dai.address ],
      [ ether(0.5), ether(0.5) ]
    );
  }

  public async createPool(tokens: Address[], weights: BigNumber[]): Promise<string> {

    const tokenAndWeights = tokens.map((token, i) => { return {address: token, weight: weights[i]}; });
    tokenAndWeights.sort((a, b) => parseInt(a.address) - parseInt(b.address));

    const tx = await this.weightedPoolFactory.create(
      "name",
      "symbol",
      tokenAndWeights.map(tw => tw.address),
      tokenAndWeights.map(tw => tw.weight),
      ether(0.001),
      this.owner.address
    );

    const receipt = await tx.wait();
    const events = receipt.events?.filter(e => e.event === "PoolCreated");
    if (events) {
      const poolAddress = events[0].args?.pool;
      return await new BPoolV2__factory(this._ownerSigner).attach(poolAddress).getPoolId();
    }

    return "";
  }
}