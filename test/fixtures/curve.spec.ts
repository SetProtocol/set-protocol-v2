import "module-alias/register";

import { Account, Address } from "@utils/types";
import DeployHelper from "@utils/deploys";
import {
  addSnapshotBeforeRestoreAfterEach,
  ether,
  getAccounts,
  getCurveFixture,
  getWaffleExpect,
  increaseTimeAsync,
} from "@utils/index";
import { CurveFixture } from "@utils/fixtures";
import { StandardTokenMock } from "../../typechain/StandardTokenMock";
import { ZERO } from "@utils/constants";
import { BigNumber, BigNumberish } from "@ethersproject/bignumber";
import { LiquidityGauge } from "@typechain/LiquidityGauge";

const expect = getWaffleExpect();

describe("CurveFixture", () => {
  let owner: Account;
  let deployer: DeployHelper;

  let curveSetup: CurveFixture;
  let dai: StandardTokenMock;
  let usdc: StandardTokenMock;
  let usdt: StandardTokenMock;
  let susd: StandardTokenMock;

  before(async () => {
    [
      owner,
    ] = await getAccounts();

    deployer = new DeployHelper(owner.wallet);
    curveSetup = getCurveFixture(owner.address);

    dai = await deployer.mocks.deployTokenMock(owner.address, ether(10000), 18);
    usdc = await deployer.mocks.deployTokenMock(owner.address, ether(10000), 6);
    usdt = await deployer.mocks.deployTokenMock(owner.address, ether(10000), 6);
    susd = await deployer.mocks.deployTokenMock(owner.address, ether(10000), 18);
  });

  addSnapshotBeforeRestoreAfterEach();

  describe("#initializePool", async () => {

    async function subject(): Promise<any> {
      await curveSetup.initializePool([dai.address, usdc.address, usdt.address, susd.address]);
    }

    it("should deploy a new set of contracts for a pool", async () => {
      await subject();
    });
  });

  describe("#initializeDAO", async () => {

    beforeEach(async () => {
      await curveSetup.initializePool([dai.address, usdc.address, usdt.address, susd.address]);
    });

    async function subject(): Promise<any> {
      await curveSetup.initializeDAO();
    }

    it("should deploy a new set of contracts for CRV DAO", async () => {
      await subject();
    });
  });

  describe("#initializeGauge", async () => {
    let subjectGauge: Address;

    beforeEach(async () => {
      await curveSetup.initializePool([dai.address, usdc.address, usdt.address, susd.address]);
      await curveSetup.initializeDAO();

      subjectGauge = curveSetup.poolToken.address;
    });

    async function subject(): Promise<any> {
      await curveSetup.initializeGauge(subjectGauge);
    }

    it("should deploy a new gauge for an LP token", async () => {
      await subject();
    });
  });

  describe("pool", async () => {
    let subject18DecimalAmount: BigNumberish;
    let subject6DecimalAmount: BigNumberish;

    beforeEach(async () => {
      await curveSetup.initializePool([dai.address, usdc.address, usdt.address, susd.address]);

      subject18DecimalAmount = ether(10);
      subject6DecimalAmount = 10000000;
      await dai.approve(curveSetup.deposit.address, subject18DecimalAmount);
      await usdc.approve(curveSetup.deposit.address, subject6DecimalAmount);
      await usdt.approve(curveSetup.deposit.address, subject6DecimalAmount);
      await susd.approve(curveSetup.deposit.address, subject18DecimalAmount);
    });

    async function subject(): Promise<any> {
      await curveSetup.deposit.add_liquidity(
        [subject18DecimalAmount, subject6DecimalAmount, subject6DecimalAmount, subject18DecimalAmount],
        0,
        {
          gasLimit: 5000000,
        });
    }

    it("should allow to add liquidity", async () => {
      await subject();

      const lpTokenBalance = await curveSetup.poolToken.balanceOf(owner.address);
      expect(lpTokenBalance).to.gt(ZERO);
    });

    describe("when user added liquidity", async () => {
      let subjectAmount: BigNumberish;

      beforeEach(async () => {
        await curveSetup.deposit.add_liquidity(
          [subject18DecimalAmount, subject6DecimalAmount, subject6DecimalAmount, subject18DecimalAmount],
          0,
          {
            gasLimit: 5000000,
          });

        subjectAmount = await curveSetup.poolToken.balanceOf(owner.address);

        await curveSetup.poolToken.approve(curveSetup.deposit.address, subjectAmount);
      });

      async function subject(): Promise<any> {
        await curveSetup.deposit.remove_liquidity(subjectAmount, [0, 0, 0 , 0], {
          gasLimit: 5000000,
        });
      }

      it("should be able to withdraw", async () => {
        const lpTokenBalanceBefore = await curveSetup.poolToken.balanceOf(owner.address);
        const daiBalanceBefore = await dai.balanceOf(owner.address);
        const usdcBalanceBefore = await usdc.balanceOf(owner.address);
        const usdtBalanceBefore = await usdt.balanceOf(owner.address);
        const susdBalanceBefore = await susd.balanceOf(owner.address);

        await subject();

        const lpTokenBalance = await curveSetup.poolToken.balanceOf(owner.address);
        expect(lpTokenBalance).to.lt(lpTokenBalanceBefore);

        const daiBalance = await dai.balanceOf(owner.address);
        const usdcBalance = await usdc.balanceOf(owner.address);
        const usdtBalance = await usdt.balanceOf(owner.address);
        const susdBalance = await susd.balanceOf(owner.address);
        expect(daiBalance).to.gt(daiBalanceBefore);
        expect(usdcBalance).to.gt(usdcBalanceBefore);
        expect(usdtBalance).to.gt(usdtBalanceBefore);
        expect(susdBalance).to.gt(susdBalanceBefore);
      });
    });
  });

  describe("Gauge", async () => {
    let subject18DecimalAmount: BigNumberish;
    let subject6DecimalAmount: BigNumberish;
    let subjectGauge: LiquidityGauge;
    let subjectValue: BigNumberish;

    beforeEach(async () => {
      await curveSetup.initializePool([dai.address, usdc.address, usdt.address, susd.address]);

      subject18DecimalAmount = ether(10);
      subject6DecimalAmount = 10000000;
      await dai.approve(curveSetup.deposit.address, subject18DecimalAmount);
      await usdc.approve(curveSetup.deposit.address, subject6DecimalAmount);
      await usdt.approve(curveSetup.deposit.address, subject6DecimalAmount);
      await susd.approve(curveSetup.deposit.address, subject18DecimalAmount);

      await curveSetup.deposit.add_liquidity(
        [subject18DecimalAmount, subject6DecimalAmount, subject6DecimalAmount, subject18DecimalAmount],
        0,
        {
          gasLimit: 5000000,
        });

      await curveSetup.initializeDAO();
      subjectGauge = await curveSetup.initializeGauge(curveSetup.poolToken.address);

      subjectValue = ether(10);

      await curveSetup.poolToken.approve(subjectGauge.address, subjectValue);
    });

    async function subject(): Promise<any> {
      await subjectGauge.functions["deposit(uint256)"](subjectValue, {
        gasLimit: 5000000,
      });
    }

    it("should allow to stake LP token", async () => {
      await subject();

      const staked = await subjectGauge.balanceOf(owner.address);
      expect(staked).to.gt(ZERO);
    });

    describe("when user staked", async () => {

      beforeEach(async () => {
        await subjectGauge.functions["deposit(uint256)"](subjectValue, {
          gasLimit: 5000000,
        });
      });

      async function subject(): Promise<any> {
        await subjectGauge.withdraw(subjectValue);
      }

      it("should be able to withdraw the stake", async () => {
        const lpTokenBalanceBefore = await curveSetup.poolToken.balanceOf(owner.address);
        const stakedBefore = await subjectGauge.balanceOf(owner.address);

        await subject();

        const lpTokenBalance = await curveSetup.poolToken.balanceOf(owner.address);
        const staked = await subjectGauge.balanceOf(owner.address);
        expect(staked).to.lt(stakedBefore);
        expect(lpTokenBalance).to.gt(lpTokenBalanceBefore);
      });
    });

    describe("when user staked for some time", async () => {
      let subjectTimeFastForward: BigNumber;

      beforeEach(async () => {
        subjectTimeFastForward = BigNumber.from(86400 * 7); // one week

        await subjectGauge.functions["deposit(uint256)"](subjectValue, {
          gasLimit: 5000000,
        });

        await increaseTimeAsync(subjectTimeFastForward);
      });

      async function subject(): Promise<any> {
        await curveSetup.minter.mint(subjectGauge.address, {
          gasLimit: 5000000,
        });
      }

      it("should be able to claim CRV tokens", async () => {
        const crvBalanceBefore = await curveSetup.crvToken.balanceOf(owner.address);

        await subject();

        const crvBalance = await curveSetup.crvToken.balanceOf(owner.address);
        expect(crvBalance).to.gt(crvBalanceBefore);
      });
    });
  });
});
