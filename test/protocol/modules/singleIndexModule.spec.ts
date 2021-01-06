import "module-alias/register";
import { BigNumber } from "@ethersproject/bignumber";

import { Address, Account, StreamingFeeState } from "@utils/types";
import { ADDRESS_ZERO, MAX_UINT_256, ONE, TWO, THREE, ZERO, ONE_DAY_IN_SECONDS, PRECISE_UNIT } from "@utils/constants";
import { ContractCallerMock, SingleIndexModule, SetToken } from "@utils/contracts";
import DeployHelper from "@utils/deploys";
import {
  addSnapshotBeforeRestoreAfterEach,
  bitcoin,
  ether,
  getAccounts,
  getBalancerFixture,
  getLastBlockTimestamp,
  getRandomAccount,
  getRandomAddress,
  getSystemFixture,
  getUniswapFixture,
  getWaffleExpect,
  increaseTimeAsync,
  preciseDiv,
  preciseMul
} from "@utils/index";
import { BalancerFixture, SystemFixture, UniswapFixture } from "@utils/fixtures";
import { ContractTransaction } from "ethers";

const expect = getWaffleExpect();

describe("SingleIndexModule", () => {
  let owner: Account;
  let trader: Account;
  let deployer: DeployHelper;
  let setup: SystemFixture;

  let uniswapSetup: UniswapFixture;
  let sushiswapSetup: UniswapFixture;
  let balancerSetup: BalancerFixture;

  let index: SetToken;
  let indexModule: SingleIndexModule;

  let indexComponents: Address[];
  let indexUnits: BigNumber[];

  const UNISWAP_ID = ONE;
  const SUSHISWAP_ID = TWO;
  const BALANCER_ID = THREE;
  const ONE_MINUTE_IN_SECONDS: BigNumber = BigNumber.from(60);

  before(async () => {
    [
      owner,
      trader,
    ] = await getAccounts();

    deployer = new DeployHelper(owner.wallet);
    setup = getSystemFixture(owner.address);
    uniswapSetup = getUniswapFixture(owner.address);
    sushiswapSetup = getUniswapFixture(owner.address);
    balancerSetup = getBalancerFixture(owner.address);

    await setup.initialize();
    await uniswapSetup.initialize(owner, setup.weth.address, setup.wbtc.address, setup.dai.address);
    await sushiswapSetup.initialize(owner, setup.weth.address, setup.wbtc.address, setup.dai.address);
    await balancerSetup.initialize(owner, setup.weth, setup.wbtc, setup.dai);

    indexModule = await deployer.modules.deploySingleIndexModule(
      setup.controller.address,
      setup.weth.address,
      uniswapSetup.router.address,
      sushiswapSetup.router.address,
      balancerSetup.exchange.address,
    );
    await setup.controller.addModule(indexModule.address);

    indexComponents = [uniswapSetup.uni.address, setup.wbtc.address, setup.dai.address];
    indexUnits = [ether(86.9565217), bitcoin(.01111111), ether(100)];
    index = await setup.createSetToken(
      indexComponents,
      indexUnits,               // $100 of each
      [setup.issuanceModule.address, setup.streamingFeeModule.address, indexModule.address],
    );

    const feeSettings = {
      feeRecipient: owner.address,
      maxStreamingFeePercentage: ether(.1),
      streamingFeePercentage: ether(.01),
      lastStreamingFeeTimestamp: ZERO,
    } as StreamingFeeState;

    await setup.streamingFeeModule.initialize(index.address, feeSettings);
    await setup.issuanceModule.initialize(index.address, ADDRESS_ZERO);

    await setup.weth.connect(owner.wallet).approve(uniswapSetup.router.address, ether(2000));
    await uniswapSetup.uni.connect(owner.wallet).approve(uniswapSetup.router.address, ether(400000));
    await uniswapSetup.router.connect(owner.wallet).addLiquidity(
      setup.weth.address,
      uniswapSetup.uni.address,
      ether(2000),
      ether(400000),
      ether(1485),
      ether(173000),
      owner.address,
      MAX_UINT_256
    );

    await setup.weth.connect(owner.wallet).approve(sushiswapSetup.router.address, ether(1000));
    await setup.wbtc.connect(owner.wallet).approve(sushiswapSetup.router.address, ether(26));
    await sushiswapSetup.router.addLiquidity(
      setup.weth.address,
      setup.wbtc.address,
      ether(1000),
      bitcoin(25.5555),
      ether(999),
      ether(25.3),
      owner.address,
      MAX_UINT_256
    );
  });

  addSnapshotBeforeRestoreAfterEach();

  describe("#constructor", async () => {
    it("should set all the parameters correctly", async () => {
      const weth = await indexModule.weth();
      const uniswapRouter = await indexModule.uniswapRouter();
      const sushiswapRouter = await indexModule.sushiswapRouter();
      const balancerProxy = await indexModule.balancerProxy();

      expect(weth).to.eq(setup.weth.address);
      expect(uniswapRouter).to.eq(uniswapSetup.router.address);
      expect(sushiswapRouter).to.eq(sushiswapSetup.router.address);
      expect(balancerProxy).to.eq(balancerSetup.exchange.address);
    });
  });

  describe("#trade", async () => {
    let subjectComponent: Address;
    let subjectIncreaseTime: BigNumber;
    let subjectCaller: Account;

    let components: Address[];
    let newComponents: Address[];
    let newTargetUnits: BigNumber[];
    let oldTargetUnits: BigNumber[];
    let issueAmount: BigNumber;
    let expectedOut: BigNumber;

    before(async () => {
      // current units [ether(86.9565217), bitcoin(.01111111), ether(100), ZERO]
      newComponents = [];
      newTargetUnits = [];
      oldTargetUnits = [ether("60.869565780223716593"), bitcoin(.02), ether(50)];
      issueAmount = ether("20.000000000000000001");
    });

    beforeEach(async () => {
      await indexModule.initialize(index.address);
      await setup.approveAndIssueSetToken(index, issueAmount);

      components = [uniswapSetup.uni.address, setup.wbtc.address, setup.dai.address, sushiswapSetup.uni.address];

      await indexModule.setTradeMaximums(components, [ether(800), bitcoin(.1), ether(1000), ether(500)]);
      await indexModule.setExchanges(components, [UNISWAP_ID, SUSHISWAP_ID, BALANCER_ID, SUSHISWAP_ID]);
      await indexModule.setCoolOffPeriods(
        components,
        [ONE_MINUTE_IN_SECONDS.mul(3), ONE_MINUTE_IN_SECONDS, ONE_MINUTE_IN_SECONDS.mul(2), ONE_MINUTE_IN_SECONDS]
      );
      await indexModule.updateTraderStatus([trader.address], [true]);

      await indexModule.startRebalance(newComponents, newTargetUnits, oldTargetUnits, await index.positionMultiplier());
      expectedOut = (await balancerSetup.exchange.viewSplitExactIn(
        setup.dai.address,
        setup.weth.address,
        ether(1000),
        THREE
      )).totalOutput;

      subjectComponent = setup.dai.address;
      subjectIncreaseTime = ONE_MINUTE_IN_SECONDS.mul(5);
      subjectCaller = trader;
    });

    async function subject(): Promise<ContractTransaction> {
      await increaseTimeAsync(subjectIncreaseTime);
      return await indexModule.connect(subjectCaller.wallet).trade(subjectComponent);
    }

    it("the position units and lastTradeTimestamp should be set as expected, sell using Balancer", async () => {
      const expectedOut = await balancerSetup.exchange.viewSplitExactIn(
        setup.dai.address,
        setup.weth.address,
        ether(1000),
        THREE
      );
      const currentDaiAmount = await setup.dai.balanceOf(index.address);
      const currentWethAmount = await setup.weth.balanceOf(index.address);
      const totalSupply = await index.totalSupply();

      await subject();

      const lastBlockTimestamp = await getLastBlockTimestamp();

      const expectedWethPositionUnits = preciseDiv(currentWethAmount.add(expectedOut.totalOutput), totalSupply);
      const expectedDaiPositionUnits = preciseDiv(currentDaiAmount.sub(ether(1000)), totalSupply);

      const wethPositionUnits = await index.getDefaultPositionRealUnit(setup.weth.address);
      const daiPositionUnits = await index.getDefaultPositionRealUnit(setup.dai.address);
      const lastTrade = (await indexModule.assetInfo(setup.dai.address)).lastTradeTimestamp;

      expect(wethPositionUnits).to.eq(expectedWethPositionUnits);
      expect(daiPositionUnits).to.eq(expectedDaiPositionUnits);
      expect(lastTrade).to.eq(lastBlockTimestamp);
    });

    it("emits the correct TradeExecuted event", async () => {
      await expect(subject()).to.emit(indexModule, "TradeExecuted").withArgs(
        trader.address,
        setup.dai.address,
        setup.weth.address,
        ether(1000),
        expectedOut
      );
    });

    describe("when the component being sold doesn't meet the max trade size", async () => {
      beforeEach(async () => {
        subjectComponent = uniswapSetup.uni.address;
      });

      it("the trade gets rounded down to meet the target", async () => {
        const totalSupply = await index.totalSupply();
        const currentUniUnit = await index.getDefaultPositionRealUnit(uniswapSetup.uni.address);
        const expectedUniSize = preciseMul(currentUniUnit.sub(oldTargetUnits[0]), totalSupply);

        const [expectedIn, expectedOut] = await uniswapSetup.router.getAmountsOut(
          expectedUniSize,
          [uniswapSetup.uni.address, setup.weth.address]
        );

        const currentUniAmount = await uniswapSetup.uni.balanceOf(index.address);
        const currentWethAmount = await setup.weth.balanceOf(index.address);

        await subject();

        const lastBlockTimestamp = await getLastBlockTimestamp();

        const expectedWethPositionUnits = preciseDiv(currentWethAmount.add(expectedOut), totalSupply);
        const expectedUniPositionUnits = preciseDiv(currentUniAmount.sub(expectedIn), totalSupply);

        const wethPositionUnits = await index.getDefaultPositionRealUnit(setup.weth.address);
        const uniPositionUnits = await index.getDefaultPositionRealUnit(uniswapSetup.uni.address);
        const lastTrade = (await indexModule.assetInfo(uniswapSetup.uni.address)).lastTradeTimestamp;

        expect(uniPositionUnits).to.eq(expectedUniPositionUnits);
        expect(wethPositionUnits).to.eq(expectedWethPositionUnits);
        expect(lastTrade).to.eq(lastBlockTimestamp);
      });
    });

    describe("when the component is being bought using Sushiswap", async () => {
      let expectedIn: BigNumber;
      let expectedOut: BigNumber;

      beforeEach(async () => {
        await subject();
        subjectComponent = setup.wbtc.address;

        [expectedIn, expectedOut] = await sushiswapSetup.router.getAmountsIn(
          bitcoin(.1),
          [setup.weth.address, setup.wbtc.address]
        );
      });

      it("the position units and lastTradeTimestamp should be set as expected", async () => {
        const currentWbtcAmount = await setup.wbtc.balanceOf(index.address);
        const currentWethAmount = await setup.weth.balanceOf(index.address);

        const wethUnit = await index.getDefaultPositionRealUnit(setup.weth.address);
        const wbtcUnit = await index.getDefaultPositionRealUnit(setup.wbtc.address);
        const totalSupply = await index.totalSupply();

        await subject();

        const lastBlockTimestamp = await getLastBlockTimestamp();

        const wbtcExcess = currentWbtcAmount.sub(preciseMul(totalSupply, wbtcUnit));
        const wethExcess = currentWethAmount.sub(preciseMul(totalSupply, wethUnit));

        const expectedWethPositionUnits = preciseDiv(currentWethAmount.sub(expectedIn).sub(wethExcess), totalSupply);
        const expectedWbtcPositionUnits = preciseDiv(currentWbtcAmount.add(expectedOut).sub(wbtcExcess), totalSupply);

        const wethPositionUnits = await index.getDefaultPositionRealUnit(setup.weth.address);
        const wbtcPositionUnits = await index.getDefaultPositionRealUnit(setup.wbtc.address);
        const lastTrade = (await indexModule.assetInfo(setup.wbtc.address)).lastTradeTimestamp;

        expect(wbtcPositionUnits).to.eq(expectedWbtcPositionUnits);
        expect(wethPositionUnits).to.eq(expectedWethPositionUnits);
        expect(lastTrade).to.eq(lastBlockTimestamp);
      });

      it("emits the correct TradeExecuted event", async () => {
        await expect(subject()).to.emit(indexModule, "TradeExecuted").withArgs(
          trader.address,
          setup.weth.address,
          setup.wbtc.address,
          expectedIn,
          bitcoin(.1)
        );
      });
    });

    describe("the sell happens on Sushiswap", async () => {
      before(async () => {
        oldTargetUnits = [ether(100), ZERO, ether(185)];
      });

      beforeEach(async () => {
        subjectComponent = setup.wbtc.address;
      });

      after(async () => {
        oldTargetUnits = [ether(60.869565), bitcoin(.02), ether(50)];
      });

      it("the position units and lastTradeTimestamp should be set as expected", async () => {
        const [expectedIn, expectedOut] = await sushiswapSetup.router.getAmountsOut(
          bitcoin(.1),
          [setup.wbtc.address, setup.weth.address]
        );

        const currentWbtcAmount = await setup.wbtc.balanceOf(index.address);
        const currentWethAmount = await setup.weth.balanceOf(index.address);

        const wethUnit = await index.getDefaultPositionRealUnit(setup.weth.address);
        const wbtcUnit = await index.getDefaultPositionRealUnit(setup.wbtc.address);
        const totalSupply = await index.totalSupply();

        await subject();

        const lastBlockTimestamp = await getLastBlockTimestamp();

        const wbtcExcess = currentWbtcAmount.sub(preciseMul(totalSupply, wbtcUnit));
        const wethExcess = currentWethAmount.sub(preciseMul(totalSupply, wethUnit));

        const expectedWethPositionUnits = preciseDiv(currentWethAmount.add(expectedOut).sub(wethExcess), totalSupply);
        const expectedWbtcPositionUnits = preciseDiv(currentWbtcAmount.sub(expectedIn).sub(wbtcExcess), totalSupply);

        const wethPositionUnits = await index.getDefaultPositionRealUnit(setup.weth.address);
        const wbtcPositionUnits = await index.getDefaultPositionRealUnit(setup.wbtc.address);
        const lastTrade = (await indexModule.assetInfo(setup.wbtc.address)).lastTradeTimestamp;

        expect(wbtcPositionUnits).to.eq(expectedWbtcPositionUnits);
        expect(wethPositionUnits).to.eq(expectedWethPositionUnits);
        expect(lastTrade).to.eq(lastBlockTimestamp);
      });

      describe("sell trade zeroes out the asset", async () => {
        before(async () => {
          oldTargetUnits = [ether(100), ZERO, ether(185)];
        });

        beforeEach(async () => {
          await increaseTimeAsync(ONE_MINUTE_IN_SECONDS.mul(5));
          await indexModule.connect(trader.wallet).trade(setup.wbtc.address);
          await increaseTimeAsync(ONE_MINUTE_IN_SECONDS.mul(5));
          await indexModule.connect(trader.wallet).trade(setup.wbtc.address);
        });

        after(async () => {
          oldTargetUnits = [ether(60.869565), bitcoin(.02), ether(50)];
        });

        it("should remove the asset from the index", async () => {
          await subject();

          const components = await index.getComponents();
          const positionUnit = await index.getDefaultPositionRealUnit(setup.wbtc.address);

          expect(components).to.not.contain(setup.wbtc.address);
          expect(positionUnit).to.eq(ZERO);
        });
      });
    });

    describe("the buy happens on Balancer", async () => {
      before(async () => {
        oldTargetUnits = [ether(100), ZERO, ether(185)];
      });

      beforeEach(async () => {
        await increaseTimeAsync(ONE_MINUTE_IN_SECONDS.mul(5));
        await indexModule.connect(trader.wallet).trade(setup.wbtc.address);
        await increaseTimeAsync(ONE_MINUTE_IN_SECONDS.mul(5));
        await indexModule.connect(trader.wallet).trade(setup.wbtc.address);

        subjectComponent = setup.dai.address;
      });

      after(async () => {
        oldTargetUnits = [ether(60.869565), bitcoin(.02), ether(50)];
      });

      it("the position units and lastTradeTimestamp should be set as expected", async () => {
        const expectedIn = await balancerSetup.exchange.viewSplitExactOut(
          setup.weth.address,
          setup.dai.address,
          ether(1000),
          THREE
        );

        const currentDaiAmount = await setup.dai.balanceOf(index.address);
        const currentWethAmount = await setup.weth.balanceOf(index.address);

        const wethUnit = await index.getDefaultPositionRealUnit(setup.weth.address);
        const daiUnit = await index.getDefaultPositionRealUnit(setup.dai.address);
        const totalSupply = await index.totalSupply();

        await subject();

        const lastBlockTimestamp = await getLastBlockTimestamp();

        const wethPositionUnits = await index.getDefaultPositionRealUnit(setup.weth.address);
        const daiPositionUnits = await index.getDefaultPositionRealUnit(setup.dai.address);
        const lastTrade = (await indexModule.assetInfo(setup.dai.address)).lastTradeTimestamp;

        const daiExcess = currentDaiAmount.sub(preciseMul(totalSupply, daiUnit));
        const wethExcess = currentWethAmount.sub(preciseMul(totalSupply, wethUnit));
        const expectedWethPositionUnits = preciseDiv(
          currentWethAmount.sub(expectedIn.totalOutput).sub(wethExcess),
          totalSupply
        );
        const expectedDaiPositionUnits = preciseDiv(
          currentDaiAmount.add(ether(1000)).sub(daiExcess),
          totalSupply
        );

        expect(wethPositionUnits).to.eq(expectedWethPositionUnits);
        expect(daiPositionUnits).to.eq(expectedDaiPositionUnits);
        expect(lastTrade).to.eq(lastBlockTimestamp);
      });
    });

    describe("when adding a new asset", async () => {
      before(async () => {
        oldTargetUnits = [ether(100), ZERO, ether(185)];
        newComponents = [sushiswapSetup.uni.address];
        newTargetUnits = [ether(50)];
      });

      beforeEach(async () => {
        await setup.weth.connect(owner.wallet).approve(sushiswapSetup.router.address, ether(1000));
        await sushiswapSetup.uni.connect(owner.wallet).approve(sushiswapSetup.router.address, ether(200000));
        await sushiswapSetup.router.connect(owner.wallet).addLiquidity(
          setup.weth.address,
          sushiswapSetup.uni.address,
          ether(1000),
          ether(200000),
          ether(800),
          ether(100000),
          owner.address,
          MAX_UINT_256
        );

        await increaseTimeAsync(ONE_MINUTE_IN_SECONDS.mul(5));
        await indexModule.connect(trader.wallet).trade(setup.wbtc.address);

        subjectComponent = sushiswapSetup.uni.address;
      });

      after(async () => {
        oldTargetUnits = [ether(60.869565), bitcoin(.02), ether(50)];
        newComponents = [];
        newTargetUnits = [];
      });

      it("the position units and lastTradeTimestamp should be set as expected", async () => {
        await subject();

        const lastBlockTimestamp = await getLastBlockTimestamp();
        const totalSupply = await index.totalSupply();
        const components = await index.getComponents();
        const expectedSushiPositionUnits = preciseDiv(ether(500), totalSupply);

        const sushiPositionUnits = await index.getDefaultPositionRealUnit(sushiswapSetup.uni.address);
        const lastTrade = (await indexModule.assetInfo(sushiswapSetup.uni.address)).lastTradeTimestamp;

        expect(components).to.contain(sushiswapSetup.uni.address);
        expect(sushiPositionUnits).to.eq(expectedSushiPositionUnits);
        expect(lastTrade).to.eq(lastBlockTimestamp);
      });
    });

    describe("when anyoneTrade is true and a random address calls", async () => {
      beforeEach(async () => {
        await indexModule.updateAnyoneTrade(true);
        subjectCaller = await getRandomAccount();
      });

      it("the trade should not revert", async () => {
        await expect(subject()).to.not.be.reverted;
      });
    });

    describe("when fees are accrued and target is met", async () => {
      before(async () => {
        issueAmount = ether(20);
      });

      beforeEach(async () => {
        await increaseTimeAsync(ONE_MINUTE_IN_SECONDS.mul(5));
        await indexModule.connect(trader.wallet).trade(setup.dai.address);

        await setup.streamingFeeModule.accrueFee(index.address);
      });

      after(async () => {
        issueAmount = ether("20.000000000000000001");
      });

      it("the trade reverts", async () => {
        const targetUnit = (await indexModule.assetInfo(setup.dai.address)).targetUnit;
        const currentUnit = await index.getDefaultPositionRealUnit(setup.dai.address);

        expect(targetUnit).to.not.eq(currentUnit);
        await expect(subject()).to.be.revertedWith("Target already met");
      });
    });

    describe("when the target has been met", async () => {
      before(async () => {
        issueAmount = ether(20);
      });

      beforeEach(async () => {
        await increaseTimeAsync(ONE_MINUTE_IN_SECONDS.mul(5));
        await indexModule.connect(trader.wallet).trade(setup.dai.address);
      });

      after(async () => {
        issueAmount = ether("20.000000000000000001");
      });

      it("the trade reverts", async () => {
        await expect(subject()).to.be.revertedWith("Target already met");
      });
    });

    describe("when exchange has not been set", async () => {
      beforeEach(async () => {
        await indexModule.setExchanges([subjectComponent], [ZERO]);
      });

      it("the trade reverts", async () => {
        await expect(subject()).to.be.revertedWith("Exchange must be specified");
      });
    });

    describe("when not enough time has elapsed between trades", async () => {
      beforeEach(async () => {
        await subject();
        subjectIncreaseTime = ZERO;
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Cool off period has not elapsed.");
      });
    });

    describe("when the passed component is not included in the rebalance", async () => {
      beforeEach(async () => {
        subjectComponent = setup.weth.address;
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Passed component not included in rebalance");
      });
    });

    describe("when the calling address is not a permissioned address", async () => {
      beforeEach(async () => {
        subjectCaller = await getRandomAccount();
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Address not permitted to trade");
      });
    });

    describe("when caller is a contract", async () => {
      let subjectTarget: Address;
      let subjectCallData: string;
      let subjectValue: BigNumber;

      let contractCaller: ContractCallerMock;

      beforeEach(async () => {
        contractCaller = await deployer.mocks.deployContractCallerMock();
        await indexModule.connect(owner.wallet).updateTraderStatus([contractCaller.address], [true]);

        subjectTarget = indexModule.address;
        subjectCallData = indexModule.interface.encodeFunctionData("trade", [subjectComponent]);
        subjectValue = ZERO;
      });

      async function subjectContractCaller(): Promise<ContractTransaction> {
        return await contractCaller.invoke(
          subjectTarget,
          subjectValue,
          subjectCallData
        );
      }

      it("the trade reverts", async () => {
        await expect(subjectContractCaller()).to.be.revertedWith("Caller must be EOA Address");
      });
    });
  });

  describe("#tradeRemainingWETH", async () => {
    let subjectComponent: Address;
    let subjectIncreaseTime: BigNumber;
    let subjectCaller: Account;

    let components: Address[];
    let targetUnits: BigNumber[];

    before(async () => {
      // current units [ether(86.9565217), bitcoin(.01111111), ether(100)]
      targetUnits = [ether(60.869565), bitcoin(.02), ether(50)];
    });

    beforeEach(async () => {
      await indexModule.initialize(index.address);
      await setup.approveAndIssueSetToken(index, ether(20));

      components = [uniswapSetup.uni.address, setup.wbtc.address, setup.dai.address];

      await indexModule.setTradeMaximums(components, [ether(800), bitcoin(.1), ether(1000)]);
      await indexModule.setExchanges(components, [UNISWAP_ID, SUSHISWAP_ID, BALANCER_ID]);
      await indexModule.setCoolOffPeriods(components, [ONE_MINUTE_IN_SECONDS.mul(3), ONE_MINUTE_IN_SECONDS, ONE_MINUTE_IN_SECONDS.mul(2)]);
      await indexModule.updateTraderStatus([trader.address], [true]);

      await indexModule.startRebalance([], [], targetUnits, await index.positionMultiplier());

      await increaseTimeAsync(ONE_MINUTE_IN_SECONDS.mul(5));
      await indexModule.connect(trader.wallet).trade(setup.dai.address);
      await indexModule.connect(trader.wallet).trade(uniswapSetup.uni.address);
      await indexModule.connect(trader.wallet).trade(setup.wbtc.address);

      subjectComponent = setup.wbtc.address;
      subjectIncreaseTime = ONE_MINUTE_IN_SECONDS.mul(5);
      subjectCaller = trader;
    });

    async function subject(): Promise<ContractTransaction> {
      await increaseTimeAsync(subjectIncreaseTime);
      return await indexModule.connect(subjectCaller.wallet).tradeRemainingWETH(subjectComponent);
    }

    it("the position units and lastTradeTimestamp should be set as expected", async () => {
      const currentWethAmount = await setup.weth.balanceOf(index.address);
      const [, expectedOut] = await sushiswapSetup.router.getAmountsOut(
        currentWethAmount,
        [setup.weth.address, setup.wbtc.address]
      );

      const currentWbtcAmount = await setup.wbtc.balanceOf(index.address);
      const totalSupply = await index.totalSupply();

      await subject();

      const lastBlockTimestamp = await getLastBlockTimestamp();

      const expectedWbtcPositionUnits = preciseDiv(currentWbtcAmount.add(expectedOut), totalSupply);

      const wethPositionUnits = await index.getDefaultPositionRealUnit(setup.weth.address);
      const wbtcPositionUnits = await index.getDefaultPositionRealUnit(setup.wbtc.address);
      const lastTrade = (await indexModule.assetInfo(subjectComponent)).lastTradeTimestamp;

      expect(wethPositionUnits).to.eq(ZERO);
      expect(wbtcPositionUnits).to.eq(expectedWbtcPositionUnits);
      expect(lastTrade).to.eq(lastBlockTimestamp);
    });

    describe("when the value of WETH in index exceeds component trade size", async () => {
      before(async () => {
        targetUnits = [ether(60.869565), bitcoin(.019), ether(50)];
      });

      after(async () => {
        targetUnits = [ether(60.869565), bitcoin(.02), ether(50)];
      });

      it("the trade reverts", async () => {
        await expect(subject()).to.be.revertedWith("Trade size exceeds trade size limit");
      });
    });

    describe("when sellable components still remain", async () => {
      before(async () => {
        targetUnits = [ether(60.869565), bitcoin(.019), ether(48)];
      });

      after(async () => {
        targetUnits = [ether(60.869565), bitcoin(.02), ether(50)];
      });

      it("the trade reverts", async () => {
        await expect(subject()).to.be.revertedWith("Must sell all sellable tokens before can be called");
      });
    });

    describe("when the target has been met", async () => {
      beforeEach(async () => {
        subjectComponent = setup.dai.address;
      });

      it("the trade reverts", async () => {
        await expect(subject()).to.be.revertedWith("Target already met");
      });
    });

    describe("when not enough time has elapsed between trades", async () => {
      beforeEach(async () => {
        subjectIncreaseTime = ZERO;
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Cool off period has not elapsed.");
      });
    });

    describe("when the passed component is not included in rebalance components", async () => {
      beforeEach(async () => {
        subjectComponent = setup.weth.address;
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Passed component not included in rebalance");
      });
    });

    describe("when exchange has not been set", async () => {
      beforeEach(async () => {
        await indexModule.setExchanges([subjectComponent], [ZERO]);
      });

      it("the trade reverts", async () => {
        await expect(subject()).to.be.revertedWith("Exchange must be specified");
      });
    });

    describe("when the calling address is not a permissioned address", async () => {
      beforeEach(async () => {
        subjectCaller = await getRandomAccount();
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Address not permitted to trade");
      });
    });

    describe("when caller is a contract", async () => {
      let subjectTarget: Address;
      let subjectCallData: string;
      let subjectValue: BigNumber;

      let contractCaller: ContractCallerMock;

      beforeEach(async () => {
        contractCaller = await deployer.mocks.deployContractCallerMock();
        await indexModule.connect(owner.wallet).updateTraderStatus([contractCaller.address], [true]);

        subjectTarget = indexModule.address;
        subjectCallData = indexModule.interface.encodeFunctionData("trade", [subjectComponent]);
        subjectValue = ZERO;
      });

      async function subjectContractCaller(): Promise<ContractTransaction> {
        return await contractCaller.invoke(
          subjectTarget,
          subjectValue,
          subjectCallData
        );
      }

      it("the trade reverts", async () => {
        await expect(subjectContractCaller()).to.be.revertedWith("Caller must be EOA Address");
      });
    });
  });

  describe("#raiseAssetTargets", async () => {
    let subjectCaller: Account;

    let components: Address[];
    let targetUnits: BigNumber[];

    before(async () => {
      // current units [ether(86.9565217), bitcoin(.01111111), ether(100)]
      targetUnits = [ether(60.869565), bitcoin(.015), ether(50)];
    });

    beforeEach(async () => {
      await indexModule.initialize(index.address);
      await setup.approveAndIssueSetToken(index, ether(20));

      components = [uniswapSetup.uni.address, setup.wbtc.address, setup.dai.address];

      await indexModule.setTradeMaximums(components, [ether(800), bitcoin(.1), ether(1000)]);
      await indexModule.setExchanges(components, [UNISWAP_ID, SUSHISWAP_ID, BALANCER_ID]);
      await indexModule.setCoolOffPeriods(components, [ONE_MINUTE_IN_SECONDS.mul(3), ONE_MINUTE_IN_SECONDS, ONE_MINUTE_IN_SECONDS.mul(2)]);
      await indexModule.updateTraderStatus([trader.address], [true]);

      await indexModule.startRebalance([], [], targetUnits, await index.positionMultiplier());

      await increaseTimeAsync(ONE_MINUTE_IN_SECONDS.mul(5));
      await indexModule.connect(trader.wallet).trade(setup.dai.address);
      await indexModule.connect(trader.wallet).trade(uniswapSetup.uni.address);
      await indexModule.connect(trader.wallet).trade(setup.wbtc.address);

      subjectCaller = trader;
    });

    async function subject(): Promise<ContractTransaction> {
      return await indexModule.connect(subjectCaller.wallet).raiseAssetTargets();
    }

    it("the position units and lastTradeTimestamp should be set as expected", async () => {
      const prePositionMultiplier = await indexModule.positionMultiplier();

      await subject();

      const expectedPositionMultiplier = preciseDiv(
        prePositionMultiplier,
        PRECISE_UNIT.add(ether(.0025))
      );

      const positionMultiplier = await indexModule.positionMultiplier();

      expect(positionMultiplier).to.eq(expectedPositionMultiplier);
    });

    describe("when the target has been met and no ETH remains", async () => {
      before(async () => {
        targetUnits = [ether(60.869565), bitcoin(.02), ether(50)];
      });

      beforeEach(async () => {
        await increaseTimeAsync(ONE_MINUTE_IN_SECONDS.mul(5));
        await indexModule.connect(trader.wallet).tradeRemainingWETH(setup.wbtc.address);
      });

      after(async () => {
        targetUnits = [ether(60.869565), bitcoin(.015), ether(50)];
      });

      it("the trade reverts", async () => {
        await expect(subject()).to.be.revertedWith("Targets must be met and ETH remaining in order to raise target");
      });
    });

    describe("when the calling address is not a permissioned address", async () => {
      beforeEach(async () => {
        subjectCaller = await getRandomAccount();
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Address not permitted to trade");
      });
    });
  });

  describe("#startRebalance", async () => {
    let subjectNewComponents: Address[];
    let subjectNewComponentsTargetUnits: BigNumber[];
    let subjectOldComponentsTargetUnits: BigNumber[];
    let subjectPositionMultiplier: BigNumber;
    let subjectCaller: Account;

    beforeEach(async () => {
      await indexModule.initialize(index.address);

      subjectNewComponents = [];
      subjectNewComponentsTargetUnits = [];
      subjectOldComponentsTargetUnits = [ether(50), bitcoin(0.02138888), ether(50)];
      subjectPositionMultiplier = await index.positionMultiplier();
      subjectCaller = owner;
    });

    async function subject(): Promise<ContractTransaction> {
      return await indexModule.connect(subjectCaller.wallet).startRebalance(
        subjectNewComponents,
        subjectNewComponentsTargetUnits,
        subjectOldComponentsTargetUnits,
        subjectPositionMultiplier
      );
    }

    it("the target units should be set to passed target units", async () => {
      await subject();

      const uniTarget = (await indexModule.assetInfo(indexComponents[0])).targetUnit;
      const btcTarget = (await indexModule.assetInfo(indexComponents[1])).targetUnit;
      const daiTarget = (await indexModule.assetInfo(indexComponents[2])).targetUnit;

      expect(uniTarget).to.eq(subjectOldComponentsTargetUnits[0]);
      expect(btcTarget).to.eq(subjectOldComponentsTargetUnits[1]);
      expect(daiTarget).to.eq(subjectOldComponentsTargetUnits[2]);
    });

    it("the position multiplier should be set", async () => {
      await subject();
      const positionMultiplier = await index.positionMultiplier();
      expect(positionMultiplier).to.eq(subjectPositionMultiplier);
    });

    it("the rebalance components should be set", async () => {
      await subject();
      const rebalanceComponents = await indexModule.getRebalanceComponents();
      expect(JSON.stringify(rebalanceComponents)).to.eq(JSON.stringify(indexComponents));
    });

    it("should emit an event for each component", async () => {
      await expect(subject()).to.emit(indexModule, "TargetUnitsUpdated").withArgs(
        indexComponents[0],
        subjectOldComponentsTargetUnits[0],
        subjectPositionMultiplier
      );
    });

    describe("when new components are being added", async () => {
      beforeEach(async () => {
        subjectNewComponents = [sushiswapSetup.uni.address];
        subjectNewComponentsTargetUnits = [ether(1)];
      });

      it("the target units should be set to passed target units", async () => {
        await subject();

        const uniTarget = (await indexModule.assetInfo(indexComponents[0])).targetUnit;
        const btcTarget = (await indexModule.assetInfo(indexComponents[1])).targetUnit;
        const daiTarget = (await indexModule.assetInfo(indexComponents[2])).targetUnit;
        const sushiTarget = (await indexModule.assetInfo(subjectNewComponents[0])).targetUnit;

        expect(uniTarget).to.eq(subjectOldComponentsTargetUnits[0]);
        expect(btcTarget).to.eq(subjectOldComponentsTargetUnits[1]);
        expect(daiTarget).to.eq(subjectOldComponentsTargetUnits[2]);
        expect(sushiTarget).to.eq(subjectNewComponentsTargetUnits[0]);
      });
    });

    describe("when one of the passed components is WETH", async () => {
      beforeEach(async () => {
        subjectNewComponents = [setup.weth.address];
        subjectNewComponentsTargetUnits = [ether(1)];
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("WETH cannot be an index component");
      });
    });

    describe("when new allocation doesn't contain target for old allocation component", async () => {
      beforeEach(async () => {
        subjectOldComponentsTargetUnits = [bitcoin(0.02138888), ether(165)];
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("New allocation must have target for all old components");
      });
    });

    describe("when array lengths don't match", async () => {
      beforeEach(async () => {
        subjectNewComponents = [setup.wbtc.address, setup.dai.address];
        subjectNewComponentsTargetUnits = [bitcoin(0.02138888)];
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Array length mismatch");
      });
    });

    describe("when new components array has duplicates", async () => {
      beforeEach(async () => {
        subjectNewComponents = [setup.wbtc.address, setup.wbtc.address];
        subjectNewComponentsTargetUnits = [bitcoin(0.02138888), bitcoin(0.02138888)];
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Cannot duplicate components");
      });
    });

    describe("when the caller is not the manager", async () => {
      beforeEach(async () => {
        subjectCaller = await getRandomAccount();
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Must be the SetToken manager");
      });
    });

    describe("when the SetToken has not initialized the module", async () => {
      beforeEach(async () => {
        await setup.controller.removeSet(index.address);
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Must be a valid and initialized SetToken");
      });
    });
  });

  describe("#setTradeMaximums", async () => {
    let subjectComponents: Address[];
    let subjectTradeMaximums: BigNumber[];
    let subjectCaller: Account;

    beforeEach(async () => {
      await indexModule.initialize(index.address);

      subjectComponents = [uniswapSetup.uni.address, setup.wbtc.address, setup.dai.address];
      subjectTradeMaximums = [ether(8000), bitcoin(1), ether(300)];
      subjectCaller = owner;
    });

    async function subject(): Promise<ContractTransaction> {
      return await indexModule.connect(subjectCaller.wallet).setTradeMaximums(
        subjectComponents,
        subjectTradeMaximums
      );
    }

    it("the trade maximums should be set to passed trade maximums", async () => {
      await subject();

      const uniTradeMax = (await indexModule.assetInfo(indexComponents[0])).maxSize;
      const btcTradeMax = (await indexModule.assetInfo(indexComponents[1])).maxSize;
      const daiTradeMax = (await indexModule.assetInfo(indexComponents[2])).maxSize;

      expect(uniTradeMax).to.eq(subjectTradeMaximums[0]);
      expect(btcTradeMax).to.eq(subjectTradeMaximums[1]);
      expect(daiTradeMax).to.eq(subjectTradeMaximums[2]);
    });

    it("should emit TradeMaximumUpdated event", async () => {
      await expect(subject()).to.emit(indexModule, "TradeMaximumUpdated").withArgs(
        subjectComponents[0],
        subjectTradeMaximums[0]
      );
    });

    describe("when array lengths don't match", async () => {
      beforeEach(async () => {
        subjectComponents = [setup.wbtc.address, setup.dai.address];
        subjectTradeMaximums = [bitcoin(0.02138888)];
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Array length mismatch");
      });
    });

    describe("when arrays are empty", async () => {
      beforeEach(async () => {
        subjectComponents = [];
        subjectTradeMaximums = [];
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Array length must be > 0");
      });
    });

    describe("when components are duplicated", async () => {
      beforeEach(async () => {
        subjectComponents = [setup.wbtc.address, setup.dai.address, setup.wbtc.address];
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Cannot duplicate components");
      });
    });

    describe("when the caller is not the manager", async () => {
      beforeEach(async () => {
        subjectCaller = await getRandomAccount();
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Must be the SetToken manager");
      });
    });

    describe("when the SetToken has not initialized the module", async () => {
      beforeEach(async () => {
        await setup.controller.removeSet(index.address);
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Must be a valid and initialized SetToken");
      });
    });
  });

  describe("#setExchanges", async () => {
    let subjectComponents: Address[];
    let subjectExchanges: BigNumber[];
    let subjectCaller: Account;

    beforeEach(async () => {
      await indexModule.initialize(index.address);

      subjectComponents = [uniswapSetup.uni.address, setup.wbtc.address, setup.dai.address];
      subjectExchanges = [UNISWAP_ID, SUSHISWAP_ID, BALANCER_ID];
      subjectCaller = owner;
    });

    async function subject(): Promise<ContractTransaction> {
      return await indexModule.connect(subjectCaller.wallet).setExchanges(
        subjectComponents,
        subjectExchanges
      );
    }

    it("the exchanges should be set to passed exchanges", async () => {
      await subject();

      const uniExchange = (await indexModule.assetInfo(indexComponents[0])).exchange;
      const btcExchange = (await indexModule.assetInfo(indexComponents[1])).exchange;
      const daiExchange = (await indexModule.assetInfo(indexComponents[2])).exchange;

      expect(uniExchange).to.eq(subjectExchanges[0]);
      expect(btcExchange).to.eq(subjectExchanges[1]);
      expect(daiExchange).to.eq(subjectExchanges[2]);
    });

    it("should emit AssetExchangeUpdated event", async () => {
      await expect(subject()).to.emit(indexModule, "AssetExchangeUpdated").withArgs(
        subjectComponents[0],
        subjectExchanges[0]
      );
    });

    describe("when passed exchange does not map to current exchange", async () => {
      beforeEach(async () => {
        subjectComponents = [setup.dai.address];
        subjectExchanges = [BigNumber.from(4)];
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Unrecognized exchange identifier");
      });
    });

    describe("when array lengths don't match", async () => {
      beforeEach(async () => {
        subjectComponents = [setup.wbtc.address, setup.dai.address];
        subjectExchanges = [SUSHISWAP_ID];
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Array length mismatch");
      });
    });

    describe("when components are duplicated", async () => {
      beforeEach(async () => {
        subjectComponents = [setup.wbtc.address, setup.dai.address, setup.wbtc.address];
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Cannot duplicate components");
      });
    });

    describe("when arrays are empty", async () => {
      beforeEach(async () => {
        subjectComponents = [];
        subjectExchanges = [];
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Array length must be > 0");
      });
    });

    describe("when the caller is not the manager", async () => {
      beforeEach(async () => {
        subjectCaller = await getRandomAccount();
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Must be the SetToken manager");
      });
    });

    describe("when the SetToken has not initialized the module", async () => {
      beforeEach(async () => {
        await setup.controller.removeSet(index.address);
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Must be a valid and initialized SetToken");
      });
    });
  });

  describe("#setCoolOffPeriods", async () => {
    let subjectComponents: Address[];
    let subjectCoolOffPeriods: BigNumber[];
    let subjectCaller: Account;

    beforeEach(async () => {
      await indexModule.initialize(index.address);

      subjectComponents = [uniswapSetup.uni.address, setup.wbtc.address, setup.dai.address];
      subjectCoolOffPeriods = [ONE_MINUTE_IN_SECONDS.mul(3), ONE_MINUTE_IN_SECONDS, ONE_MINUTE_IN_SECONDS.mul(2)];
      subjectCaller = owner;
    });

    async function subject(): Promise<ContractTransaction> {
      return await indexModule.connect(subjectCaller.wallet).setCoolOffPeriods(
        subjectComponents,
        subjectCoolOffPeriods
      );
    }

    it("the cool off periods should be set to passed cool off periods", async () => {
      await subject();

      const uniCoolOffPeriod = (await indexModule.assetInfo(indexComponents[0])).coolOffPeriod;
      const btcCoolOffPeriod = (await indexModule.assetInfo(indexComponents[1])).coolOffPeriod;
      const daiCoolOffPeriod = (await indexModule.assetInfo(indexComponents[2])).coolOffPeriod;

      expect(uniCoolOffPeriod).to.eq(subjectCoolOffPeriods[0]);
      expect(btcCoolOffPeriod).to.eq(subjectCoolOffPeriods[1]);
      expect(daiCoolOffPeriod).to.eq(subjectCoolOffPeriods[2]);
    });

    it("should emit CoolOffPeriodUpdated event", async () => {
      await expect(subject()).to.emit(indexModule, "CoolOffPeriodUpdated").withArgs(
        subjectComponents[0],
        subjectCoolOffPeriods[0]
      );
    });

    describe("when array lengths don't match", async () => {
      beforeEach(async () => {
        subjectComponents = [setup.wbtc.address, setup.dai.address];
        subjectCoolOffPeriods = [ONE_MINUTE_IN_SECONDS.mul(2)];
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Array length mismatch");
      });
    });

    describe("when components are duplicated", async () => {
      beforeEach(async () => {
        subjectComponents = [setup.wbtc.address, setup.dai.address, setup.wbtc.address];
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Cannot duplicate components");
      });
    });

    describe("when arrays are empty", async () => {
      beforeEach(async () => {
        subjectComponents = [];
        subjectCoolOffPeriods = [];
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Array length must be > 0");
      });
    });

    describe("when the caller is not the manager", async () => {
      beforeEach(async () => {
        subjectCaller = await getRandomAccount();
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Must be the SetToken manager");
      });
    });

    describe("when the SetToken has not initialized the module", async () => {
      beforeEach(async () => {
        await setup.controller.removeSet(index.address);
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Must be a valid and initialized SetToken");
      });
    });
  });

  describe("#updateTraderStatus", async () => {
    let subjectTraders: Address[];
    let subjectStatuses: boolean[];
    let subjectCaller: Account;

    beforeEach(async () => {
      await indexModule.initialize(index.address);

      subjectTraders = [trader.address, await getRandomAddress(), await getRandomAddress()];
      subjectStatuses = [true, true, true];
      subjectCaller = owner;
    });

    async function subject(): Promise<ContractTransaction> {
      return await indexModule.connect(subjectCaller.wallet).updateTraderStatus(
        subjectTraders,
        subjectStatuses
      );
    }

    it("the trader status should be flipped to true", async () => {
      await subject();

      const isTraderOne = await indexModule.tradeAllowList(subjectTraders[0]);
      const isTraderTwo = await indexModule.tradeAllowList(subjectTraders[1]);
      const isTraderThree = await indexModule.tradeAllowList(subjectTraders[2]);

      expect(isTraderOne).to.be.true;
      expect(isTraderTwo).to.be.true;
      expect(isTraderThree).to.be.true;
    });

    it("should TraderStatusUpdated event", async () => {
      await expect(subject()).to.emit(indexModule, "TraderStatusUpdated").withArgs(
        subjectTraders[0],
        true
      );
    });

    describe("when array lengths don't match", async () => {
      beforeEach(async () => {
        subjectTraders = [trader.address, await getRandomAddress()];
        subjectStatuses = [false];
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Array length mismatch");
      });
    });

    describe("when traders are duplicated", async () => {
      beforeEach(async () => {
        subjectTraders = [trader.address, trader.address, await getRandomAddress()];
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Cannot duplicate traders");
      });
    });

    describe("when arrays are empty", async () => {
      beforeEach(async () => {
        subjectTraders = [];
        subjectStatuses = [];
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Array length must be > 0");
      });
    });

    describe("when the caller is not the manager", async () => {
      beforeEach(async () => {
        subjectCaller = await getRandomAccount();
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Must be the SetToken manager");
      });
    });

    describe("when the SetToken has not initialized the module", async () => {
      beforeEach(async () => {
        await setup.controller.removeSet(index.address);
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Must be a valid and initialized SetToken");
      });
    });
  });

  describe("#updateAnyoneTrade", async () => {
    let subjectStatus: boolean;
    let subjectCaller: Account;

    beforeEach(async () => {
      await indexModule.initialize(index.address);
      subjectStatus = true;
      subjectCaller = owner;
    });

    async function subject(): Promise<ContractTransaction> {
      return await indexModule.connect(subjectCaller.wallet).updateAnyoneTrade(subjectStatus);
    }

    it("should flip anyoneTrade", async () => {
      await subject();

      const canAnyoneTrade = await indexModule.anyoneTrade();

      expect(canAnyoneTrade).to.be.true;
    });

    it("should emit an event signaling flip", async () => {
      await expect(subject()).to.emit(indexModule, "AnyoneTradeUpdated").withArgs(
        true
      );
    });

    describe("when the caller is not the manager", async () => {
      beforeEach(async () => {
        subjectCaller = await getRandomAccount();
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Must be the SetToken manager");
      });
    });

    describe("when the SetToken has not initialized the module", async () => {
      beforeEach(async () => {
        await setup.controller.removeSet(index.address);
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Must be a valid and initialized SetToken");
      });
    });
  });

  describe("#initialize", async () => {
    let subjectIndex: Address;
    let subjectCaller: Account;

    beforeEach(async () => {
      subjectIndex = index.address;
      subjectCaller = owner;
    });

    async function subject(): Promise<ContractTransaction> {
      return await indexModule.connect(subjectCaller.wallet).initialize(subjectIndex);
    }

    it("the index address should be set", async () => {
      await subject();
      const indexAddress = await indexModule.index();
      expect(indexAddress).to.eq(index.address);
    });

    it("the target units should be set to the current Set units", async () => {
      await subject();

      const uniTarget = (await indexModule.assetInfo(indexComponents[0])).targetUnit;
      const btcTarget = (await indexModule.assetInfo(indexComponents[1])).targetUnit;
      const daiTarget = (await indexModule.assetInfo(indexComponents[2])).targetUnit;

      expect(uniTarget).to.eq(indexUnits[0]);
      expect(btcTarget).to.eq(indexUnits[1]);
      expect(daiTarget).to.eq(indexUnits[2]);
    });

    it("should enable the IndexModule on the SetToken", async () => {
      await subject();
      const isModuleEnabled = await index.isInitializedModule(indexModule.address);
      expect(isModuleEnabled).to.be.true;
    });

    describe("when the module is already being used", async () => {
      beforeEach(async () => {
        await subject();

        const newSet = await setup.createSetToken([setup.weth.address], [ether(1)], [indexModule.address]);
        subjectIndex = newSet.address;
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Module already in use");
      });
    });

    describe("when the caller is not the SetToken manager", async () => {
      beforeEach(async () => {
        subjectCaller = await getRandomAccount();
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Must be the SetToken manager");
      });
    });

    describe("when SetToken is not in pending state", async () => {
      beforeEach(async () => {
        const newModule = await getRandomAddress();
        await setup.controller.addModule(newModule);

        const indexModuleNotPendingSetToken = await setup.createSetToken(
          [setup.weth.address],
          [ether(1)],
          [newModule]
        );

        subjectIndex = indexModuleNotPendingSetToken.address;
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Must be pending initialization");
      });
    });

    describe("when the SetToken is not enabled on the controller", async () => {
      beforeEach(async () => {
        const nonEnabledSetToken = await setup.createNonControllerEnabledSetToken(
          [setup.weth.address],
          [ether(1)],
          [indexModule.address]
        );

        subjectIndex = nonEnabledSetToken.address;
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Must be controller-enabled SetToken");
      });
    });
  });

  describe("#getTargetUnits", async () => {
    let targetUnits: BigNumber[];
    let positionMultiplier: BigNumber;

    let subjectComponents: Address[];

    beforeEach(async () => {
      await indexModule.initialize(index.address);

      targetUnits = [ether(60.869565), bitcoin(.02), ether(50)];
      positionMultiplier = await index.positionMultiplier();

      await indexModule.startRebalance([], [], targetUnits, positionMultiplier);

      subjectComponents = [uniswapSetup.uni.address];
    });

    async function subject(): Promise<BigNumber[]> {
      return await indexModule.getTargetUnits(subjectComponents);
    }

    it("should return the current units on the ", async () => {
      const actualTargetUnits = await subject();

      expect(actualTargetUnits[0]).to.eq(targetUnits[0]);
    });

    describe("when the caller is not the Index", async () => {
      beforeEach(async () => {
        await increaseTimeAsync(ONE_DAY_IN_SECONDS);
        await setup.streamingFeeModule.accrueFee(index.address);
      });

      it("should return the current units on the ", async () => {
        const actualTargetUnits = await subject();

        const currentPositionMultiplier = await index.positionMultiplier();
        const expectedTargetUnits = targetUnits[0].mul(currentPositionMultiplier).div(positionMultiplier);

        expect(actualTargetUnits[0]).to.eq(expectedTargetUnits);
      });
    });
  });
});
