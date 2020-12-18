import DeployHelper from "../deploys";
import { Signer } from "ethers";
import { JsonRpcProvider, Web3Provider } from "ethers/providers";
import { Address, Account } from "../types";
import { BigNumber } from "ethers/utils";

import {
  StakingRewards,
  Uni,
  UniswapTimelock,
  UniswapGovernorAlpha,
  UniswapV2Factory,
  UniswapV2Pair,
  UniswapV2Router02
} from "../contracts/uniswap";
import { UniswapV2PairFactory } from "../../typechain/UniswapV2PairFactory";
import { ether } from "../index";
import { ONE_DAY_IN_SECONDS } from "../constants";

export class UniswapFixture {
  private _deployer: DeployHelper;
  private _provider: Web3Provider | JsonRpcProvider;
  private _ownerSigner: Signer;

  public owner: Account;
  public uni: Uni;
  public uniswapGovernorAlpha: UniswapGovernorAlpha;
  public uniswapTimelock: UniswapTimelock;
  public factory: UniswapV2Factory;
  public pair: UniswapV2Pair;
  public router: UniswapV2Router02;

  public wethDaiPool: UniswapV2Pair;
  public wethDaiStakingRewards: StakingRewards;
  public wethWbtcPool: UniswapV2Pair;
  public wethWbtcStakingRewards: StakingRewards;
  public uniWethPool: UniswapV2Pair;

  constructor(provider: Web3Provider | JsonRpcProvider, ownerAddress: Address) {
    this._ownerSigner = provider.getSigner(ownerAddress);
    this._provider = provider;
    this._deployer = new DeployHelper(this._ownerSigner);
  }

  public async initialize(_owner: Account, _weth: Address, _wbtc: Address, _dai: Address): Promise<void> {
    this.owner = _owner;
    this.factory = await this._deployer.external.deployUniswapV2Factory(this.owner.address);
    this.router = await this._deployer.external.deployUniswapV2Router02(this.factory.address, _weth);

    const lastBlock = await this._provider.getBlock("latest");
    this.uni = await this._deployer.external.deployUni(
      this.owner.address,
      this.owner.address,
      new BigNumber(lastBlock.timestamp).add(2)
    );
    this.uniswapTimelock = await this._deployer.external.deployUniswapTimelock(
      this.owner.address,
      ONE_DAY_IN_SECONDS.mul(2),
    );
    this.uniswapGovernorAlpha = await this._deployer.external.deployUniswapGovernorAlpha(
      this.uniswapTimelock.address,
      this.uni.address,
    );

    [
      this.wethDaiPool,
      this.wethDaiStakingRewards,
    ] = await this.createNewStakingPair(_weth, _dai);
    [
      this.wethWbtcPool,
      this.wethWbtcStakingRewards,
    ] = await this.createNewStakingPair(_weth, _wbtc);
    this.uniWethPool = await this.createNewPair(_weth, this.uni.address);
  }

  public async createNewStakingPair(_tokenOne: Address, _tokenTwo: Address): Promise<[UniswapV2Pair, StakingRewards]> {
    const poolInstance: UniswapV2Pair = await this.createNewPair(_tokenOne, _tokenTwo);
    const stakingInstance: StakingRewards = await this._deployer.external.deployStakingRewards(
      this.owner.address,
      this.uni.address,
      poolInstance.address
    );

    await this.uni.connect(this.owner.wallet).transfer(stakingInstance.address, ether(5000000));
    await stakingInstance.connect(this.owner.wallet).notifyRewardAmount(ether(5000000));
    return [poolInstance, stakingInstance];
  }

  public async createNewPair(_tokenOne: Address, _tokenTwo: Address): Promise<UniswapV2Pair> {
    await this.factory.createPair(_tokenOne, _tokenTwo);
    const poolAddress = await this.factory.allPairs((await this.factory.allPairsLength()).sub(1));
    return await new UniswapV2PairFactory(this._ownerSigner).attach(poolAddress);
  }

  public getTokenOrder(_tokenOne: Address, _tokenTwo: Address): [Address, Address] {
    return _tokenOne.toLowerCase() < _tokenTwo.toLowerCase() ? [_tokenOne, _tokenTwo] : [_tokenTwo, _tokenOne];
  }
}