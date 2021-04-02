import "module-alias/register";
import { BigNumber } from "@ethersproject/bignumber";

import { Address, StreamingFeeState } from "@utils/types";
import { Account } from "@utils/test/types";
import { ADDRESS_ZERO, MAX_UINT_256, THREE, ZERO } from "@utils/constants";
import { BalancerV1ExchangeAdapter, ContractCallerMock, GeneralIndexModule, SetToken, UniswapV2ExchangeAdapterV2 } from "@utils/contracts";
import DeployHelper from "@utils/deploys";
import {
  bitcoin,
  ether,
  preciseDiv,
  preciseMul
} from "@utils/index";
import {
  cacheBeforeEach,
  increaseTimeAsync,
  getAccounts,
  getBalancerFixture,
  getLastBlockTimestamp,
  getRandomAccount,
  getSystemFixture,
  getUniswapFixture,
  getWaffleExpect
} from "@utils/test/index";
import { BalancerFixture, SystemFixture, UniswapFixture } from "@utils/fixtures";
import { ContractTransaction } from "ethers";

const expect = getWaffleExpect();

describe("GeneralIndexModule", () => {
  let owner: Account;
  let trader: Account;
  let deployer: DeployHelper;
  let setup: SystemFixture;

  let uniswapSetup: UniswapFixture;
  let sushiswapSetup: UniswapFixture;
  let balancerSetup: BalancerFixture;

  let index: SetToken;
  let indexModule: GeneralIndexModule;

  let balancerExchangeAdapter: BalancerV1ExchangeAdapter;
  let balancerAdapterName: string;
  let sushiswapExchangeAdapter: UniswapV2ExchangeAdapterV2;
  let sushiswapAdapterName: string;
  let uniswapExchangeAdapter: UniswapV2ExchangeAdapterV2;
  let uniswapAdapterName: string;

  let indexComponents: Address[];
  let indexUnits: BigNumber[];

  const ONE_MINUTE_IN_SECONDS: BigNumber = BigNumber.from(60);

  cacheBeforeEach(async () => {
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

    indexModule = await deployer.modules.deployGeneralIndexModule(
      setup.controller.address,
      setup.weth.address
    );
    await setup.controller.addModule(indexModule.address);

    balancerExchangeAdapter = await deployer.modules.deployBalancerV1ExchangeAdapter(balancerSetup.exchange.address);
    sushiswapExchangeAdapter = await deployer.modules.deployUniswapV2ExchangeAdapterV2(sushiswapSetup.router.address);
    uniswapExchangeAdapter = await deployer.modules.deployUniswapV2ExchangeAdapterV2(uniswapSetup.router.address);

    balancerAdapterName = "BALANCER";
    sushiswapAdapterName = "SUSHISWAP";
    uniswapAdapterName = "UNISWAP";


    await setup.integrationRegistry.batchAddIntegration(
      [indexModule.address, indexModule.address, indexModule.address],
      [balancerAdapterName, sushiswapAdapterName, uniswapAdapterName],
      [
        balancerExchangeAdapter.address,
        sushiswapExchangeAdapter.address,
        uniswapExchangeAdapter.address,
      ]
    );

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

  describe("#constructor", async () => {
    it("should set all the parameters correctly", async () => {
      const weth = await indexModule.weth();
      const controller = await indexModule.controller();

      expect(weth).to.eq(setup.weth.address);
      expect(controller).to.eq(setup.controller.address);
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

    cacheBeforeEach(async () => {
      await indexModule.initialize(index.address);

      components = [uniswapSetup.uni.address, setup.wbtc.address, setup.dai.address, sushiswapSetup.uni.address];

      await indexModule.setTradeMaximums(index.address, components, [ether(800), bitcoin(.1), ether(1000), ether(500)]);
      await indexModule.setExchanges(
        index.address,
        components,
        [uniswapAdapterName, sushiswapAdapterName, balancerAdapterName, sushiswapAdapterName]
      );
      await indexModule.setCoolOffPeriods(
        index.address,
        components,
        [ONE_MINUTE_IN_SECONDS.mul(3), ONE_MINUTE_IN_SECONDS, ONE_MINUTE_IN_SECONDS.mul(2), ONE_MINUTE_IN_SECONDS]
      );
      await indexModule.updateTraderStatus(index.address, [trader.address], [true]);
    });

    beforeEach(async () => {
      await setup.approveAndIssueSetToken(index, issueAmount);
      await indexModule.startRebalance(index.address, newComponents, newTargetUnits, oldTargetUnits, await index.positionMultiplier());
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
      return await indexModule.connect(subjectCaller.wallet).trade(index.address, subjectComponent);
    }

    it("the position units and lastTradeTimestamp should be set as expected, sell using Balancer", async () => {
      const currentDaiAmount = await setup.dai.balanceOf(index.address);
      const currentWethAmount = await setup.weth.balanceOf(index.address);
      const totalSupply = await index.totalSupply();

      await subject();

      const lastBlockTimestamp = await getLastBlockTimestamp();

      const expectedWethPositionUnits = preciseDiv(currentWethAmount.add(expectedOut), totalSupply);
      const expectedDaiPositionUnits = preciseDiv(currentDaiAmount.sub(ether(1000)), totalSupply);

      const wethPositionUnits = await index.getDefaultPositionRealUnit(setup.weth.address);
      const daiPositionUnits = await index.getDefaultPositionRealUnit(setup.dai.address);

      const lastTrade = (await indexModule.executionInfo(index.address, setup.dai.address)).lastTradeTimestamp;

      expect(wethPositionUnits).to.eq(expectedWethPositionUnits);
      expect(daiPositionUnits).to.eq(expectedDaiPositionUnits);
      expect(lastTrade).to.eq(lastBlockTimestamp);
    });

    it("emits the correct TradeExecuted event", async () => {
      await expect(subject()).to.emit(indexModule, "TradeExecuted").withArgs(
        index.address,
        setup.dai.address,
        setup.weth.address,
        balancerExchangeAdapter.address,
        trader.address,
        ether(1000),
        expectedOut,
        ZERO
      );
    });

    describe("when there is a protcol fee charged", async () => {
      let feePercentage: BigNumber;

      beforeEach(async () => {
        feePercentage = ether(0.05);
        setup.controller = setup.controller.connect(owner.wallet);
        await setup.controller.addFee(
          indexModule.address,
          ZERO, // Fee type on trade function denoted as 0
          feePercentage // Set fee to 5 bps
        );
      });

      it("emits the correct TradeExecuted event", async () => {
        const protocolFee = expectedOut.mul(feePercentage).div(ether(1));
        await expect(subject()).to.emit(indexModule, "TradeExecuted").withArgs(
          index.address,
          setup.dai.address,
          setup.weth.address,
          balancerExchangeAdapter.address,
          trader.address,
          ether(1000),
          expectedOut.sub(protocolFee),
          protocolFee
        );
      });
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
        const lastTrade = (await indexModule.executionInfo(index.address, uniswapSetup.uni.address)).lastTradeTimestamp;

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
        const lastTrade = (await indexModule.executionInfo(index.address, setup.wbtc.address)).lastTradeTimestamp;

        expect(wbtcPositionUnits).to.eq(expectedWbtcPositionUnits);
        expect(wethPositionUnits).to.eq(expectedWethPositionUnits);
        expect(lastTrade).to.eq(lastBlockTimestamp);
      });

      it("emits the correct TradeExecuted event", async () => {
        await expect(subject()).to.emit(indexModule, "TradeExecuted").withArgs(
          index.address,
          setup.weth.address,
          setup.wbtc.address,
          sushiswapExchangeAdapter.address,
          trader.address,
          expectedIn,
          bitcoin(.1),
          ZERO
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
        const lastTrade = (await indexModule.executionInfo(index.address, setup.wbtc.address)).lastTradeTimestamp;

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
          await indexModule.connect(trader.wallet).trade(index.address, setup.wbtc.address);
          await increaseTimeAsync(ONE_MINUTE_IN_SECONDS.mul(5));
          await indexModule.connect(trader.wallet).trade(index.address, setup.wbtc.address);
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
        await indexModule.connect(trader.wallet).trade(index.address, setup.wbtc.address);
        await increaseTimeAsync(ONE_MINUTE_IN_SECONDS.mul(5));
        await indexModule.connect(trader.wallet).trade(index.address, setup.wbtc.address);

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
        const lastTrade = (await indexModule.executionInfo(index.address, setup.dai.address)).lastTradeTimestamp;

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
        await indexModule.connect(trader.wallet).trade(index.address, setup.wbtc.address);

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
        const lastTrade = (await indexModule.executionInfo(index.address, sushiswapSetup.uni.address)).lastTradeTimestamp;

        expect(components).to.contain(sushiswapSetup.uni.address);
        expect(sushiPositionUnits).to.eq(expectedSushiPositionUnits);
        expect(lastTrade).to.eq(lastBlockTimestamp);
      });
    });

    describe("when anyoneTrade is true and a random address calls", async () => {
      beforeEach(async () => {
        await indexModule.updateAnyoneTrade(index.address, true);
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
        await indexModule.connect(trader.wallet).trade(index.address, setup.dai.address);

        await setup.streamingFeeModule.accrueFee(index.address);
      });

      after(async () => {
        issueAmount = ether("20.000000000000000001");
      });

      it("the trade reverts", async () => {
        const targetUnit = (await indexModule.executionInfo(index.address, setup.dai.address)).targetUnit;
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
        await indexModule.connect(trader.wallet).trade(index.address, setup.dai.address);
      });

      after(async () => {
        issueAmount = ether("20.000000000000000001");
      });

      it("the trade reverts", async () => {
        await expect(subject()).to.be.revertedWith("Target already met");
      });
    });

    // todo: Should we revert if exchange is not set
    // describe("when exchange has not been set", async () => {
    //   beforeEach(async () => {
    //     await indexModule.setExchanges(index.address, [subjectComponent], [""]);
    //   });

    //   it("the trade reverts", async () => {
    //     await expect(subject()).to.be.revertedWith("Exchange must be specified");
    //   });
    // });

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
        await indexModule.connect(owner.wallet).updateTraderStatus(index.address, [contractCaller.address], [true]);

        subjectTarget = indexModule.address;
        subjectCallData = indexModule.interface.encodeFunctionData("trade", [index.address, subjectComponent]);
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
});
