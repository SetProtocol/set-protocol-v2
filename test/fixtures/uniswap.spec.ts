import "module-alias/register";

import { Account } from "@utils/types";
import {
  addSnapshotBeforeRestoreAfterEach,
  ether,
  getAccounts,
  getSystemFixture,
  getUniswapFixture,
  getWaffleExpect,
} from "@utils/index";
import { SystemFixture, UniswapFixture } from "@utils/fixtures";
import { ZERO, MAX_UINT_256 } from "@utils/constants";
import { BigNumber } from "ethers/utils";

const expect = getWaffleExpect();

describe("UniswapFixture", () => {
  let owner: Account;

  let setup: SystemFixture;
  let uniswapSetup: UniswapFixture;

  before(async () => {
    [
      owner,
    ] = await getAccounts();

    setup = getSystemFixture(owner.address);
    uniswapSetup = getUniswapFixture(owner.address);

    await setup.initialize();
  });

  addSnapshotBeforeRestoreAfterEach();

  describe("#initialize", async () => {
    async function subject(): Promise<any> {
      await uniswapSetup.initialize(
        owner,
        setup.weth.address,
        setup.wbtc.address,
        setup.dai.address
      );
    }

    it("should deploy a WETH/DAI pool and staking rewards", async () => {
      await subject();

      const pairTokenOne = await uniswapSetup.wethDaiPool.token0();
      const pairTokenTwo = await uniswapSetup.wethDaiPool.token1();
      const rewardToken = await uniswapSetup.wethDaiStakingRewards.rewardsToken();
      const stakingToken = await uniswapSetup.wethDaiStakingRewards.stakingToken();

      const [expectedTokenOne, expectedTokenTwo] = uniswapSetup.getTokenOrder(
        setup.weth.address,
        setup.dai.address
      );

      expect(pairTokenOne).to.eq(expectedTokenOne);
      expect(pairTokenTwo).to.eq(expectedTokenTwo);
      expect(rewardToken).to.eq(uniswapSetup.uni.address);
      expect(stakingToken).to.eq(uniswapSetup.wethDaiPool.address);
    });

    it("should deploy a WETH/WBTC pool and staking rewards", async () => {
      await subject();

      const pairTokenOne = await uniswapSetup.wethWbtcPool.token0();
      const pairTokenTwo = await uniswapSetup.wethWbtcPool.token1();
      const rewardToken = await uniswapSetup.wethWbtcStakingRewards.rewardsToken();
      const stakingToken = await uniswapSetup.wethWbtcStakingRewards.stakingToken();

      const [expectedTokenOne, expectedTokenTwo] = uniswapSetup.getTokenOrder(
        setup.weth.address,
        setup.wbtc.address
      );

      expect(pairTokenOne).to.eq(expectedTokenOne);
      expect(pairTokenTwo).to.eq(expectedTokenTwo);
      expect(rewardToken).to.eq(uniswapSetup.uni.address);
      expect(stakingToken).to.eq(uniswapSetup.wethWbtcPool.address);
    });
  });

  describe("mint WETH/DAI pool share", async () => {
    beforeEach(async () => {
      await uniswapSetup.initialize(
        owner,
        setup.weth.address,
        setup.wbtc.address,
        setup.dai.address
      );

      await setup.weth.approve(uniswapSetup.router.address, ether(1));
      await setup.dai.approve(uniswapSetup.router.address, ether(350));
    });

    async function subject(): Promise<any> {
      await uniswapSetup.router.addLiquidity(
        setup.weth.address,
        setup.dai.address,
        ether(1),
        ether(350),
        ether(.99),
        ether(353.5),
        owner.address,
        MAX_UINT_256
      );
    }

    it("should return lp token to owner and decrement amounts", async () => {
      const preDaiBalance = await setup.dai.balanceOf(owner.address);
      const preWethBalance = await setup.weth.balanceOf(owner.address);

      await subject();

      const postDaiBalance = await setup.dai.balanceOf(owner.address);
      const postWethBalance = await setup.weth.balanceOf(owner.address);
      const lpTokenBalance = await uniswapSetup.wethDaiPool.balanceOf(owner.address);

      expect(preDaiBalance.sub(ether(350))).to.eq(postDaiBalance);
      expect(preWethBalance.sub(ether(1))).to.eq(postWethBalance);
      expect(lpTokenBalance).to.be.gt(ZERO);
    });
  });

  describe("deposit pool into staking contract", async () => {
    let subjectAmount: BigNumber;

    beforeEach(async () => {
      await uniswapSetup.initialize(
        owner,
        setup.weth.address,
        setup.wbtc.address,
        setup.dai.address
      );

      await setup.weth.approve(uniswapSetup.router.address, ether(1));
      await setup.dai.approve(uniswapSetup.router.address, ether(350));

      await uniswapSetup.router.addLiquidity(
        setup.weth.address,
        setup.dai.address,
        ether(1),
        ether(350),
        ether(.99),
        ether(353.5),
        owner.address,
        MAX_UINT_256
      );

      subjectAmount = await uniswapSetup.wethDaiPool.balanceOf(owner.address);

      await uniswapSetup.wethDaiPool.approve(uniswapSetup.wethDaiStakingRewards.address, subjectAmount);
    });

    async function subject(): Promise<any> {
      await uniswapSetup.wethDaiStakingRewards.stake(subjectAmount);
    }

    it("should stake lp tokens", async () => {
      await subject();

      const amountStaked = await uniswapSetup.wethDaiStakingRewards.balanceOf(owner.address);
      expect(amountStaked).to.eq(subjectAmount);
    });
  });
});