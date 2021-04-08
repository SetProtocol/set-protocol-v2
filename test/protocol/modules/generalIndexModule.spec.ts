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
  preciseMul,
  preciseMulCeil
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


// ----------utils---------- //
const componentAmountTraded = async (indexModule: GeneralIndexModule, setToken: SetToken, component: Address) => {
  const totalSupply = await setToken.totalSupply();
  const componentMaxSize = (await indexModule.executionInfo(setToken.address, component)).maxSize;
  const currentPositionMultiplier = await setToken.positionMultiplier();
  const positionMultiplier = (await indexModule.rebalanceInfo(setToken.address)).positionMultiplier;

  const currentUnit = await setToken.getDefaultPositionRealUnit(component);
  const targetUnit = (await indexModule.executionInfo(setToken.address, component)).targetUnit.mul(currentPositionMultiplier).div(positionMultiplier);

  const currentNotional = preciseMul(totalSupply, currentUnit);
  const targetNotional = preciseMulCeil(totalSupply, targetUnit);

  if (targetNotional.lt(currentNotional)) {
    return componentMaxSize.lt(currentNotional.sub(targetNotional)) ? componentMaxSize : currentNotional.sub(targetNotional);
  } else {
    return componentMaxSize.lt(targetNotional.sub(currentNotional)) ? componentMaxSize : targetNotional.sub(currentNotional);
  }
};



describe("GeneralIndexModule", () => {
  let owner: Account;
  let trader: Account;
  let deployer: DeployHelper;
  let setup: SystemFixture;

  let uniswapSetup: UniswapFixture;
  let sushiswapSetup: UniswapFixture;
  let balancerSetup: BalancerFixture;

  let index: SetToken;
  let indexWithWeth: SetToken;
  let indexModule: GeneralIndexModule;

  let balancerExchangeAdapter: BalancerV1ExchangeAdapter;
  let balancerAdapterName: string;
  let sushiswapExchangeAdapter: UniswapV2ExchangeAdapterV2;
  let sushiswapAdapterName: string;
  let uniswapExchangeAdapter: UniswapV2ExchangeAdapterV2;
  let uniswapAdapterName: string;

  let indexComponents: Address[];
  let indexUnits: BigNumber[];
  let indexWithWethComponents: Address[];
  let indexWithWethUnits: BigNumber[];

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

    indexWithWethComponents = [uniswapSetup.uni.address, setup.wbtc.address, setup.dai.address, setup.weth.address];
    indexWithWethUnits = [ether(86.9565217), bitcoin(.01111111), ether(100), ether(0.434782609)];
    indexWithWeth = await setup.createSetToken(
      indexWithWethComponents,
      indexWithWethUnits,               // $100 of each
      [setup.issuanceModule.address, setup.streamingFeeModule.address, indexModule.address],
    );

    const feeSettingsForIndexWithWeth = {
      feeRecipient: owner.address,
      maxStreamingFeePercentage: ether(.1),
      streamingFeePercentage: ether(.01),
      lastStreamingFeeTimestamp: ZERO,
    } as StreamingFeeState;

    await setup.streamingFeeModule.initialize(indexWithWeth.address, feeSettingsForIndexWithWeth);
    await setup.issuanceModule.initialize(indexWithWeth.address, ADDRESS_ZERO);


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

  describe("#initialize", async () => {
    let subjectSetToken: SetToken;
    let subjectCaller: Account;

    beforeEach(async () => {
      subjectSetToken = index;
      subjectCaller = owner;
    });

    async function subject(): Promise<any> {
      indexModule = indexModule.connect(subjectCaller.wallet);
      return indexModule.initialize(subjectSetToken.address);
    }

    it("should enable the Module on the SetToken", async () => {
      await subject();
      const isModuleEnabled = await subjectSetToken.isInitializedModule(indexModule.address);
      expect(isModuleEnabled).to.eq(true);
    });

    describe("when the caller is not the SetToken manager", async () => {
      beforeEach(async () => {
        subjectCaller = await getRandomAccount();
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Must be the SetToken manager");
      });
    });

    describe("when the module is not pending", async () => {
      beforeEach(async () => {
        await subject();
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Must be pending initialization");
      });
    });

    describe("when the SetToken is not enabled on the controller", async () => {
      beforeEach(async () => {
        const nonEnabledSetToken = await setup.createNonControllerEnabledSetToken(
          [setup.dai.address],
          [ether(1)],
          [indexModule.address],
          owner.address
        );

        subjectSetToken = nonEnabledSetToken;
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Must be controller-enabled SetToken");
      });
    });

    describe("when set has weth as component", async () => {
      beforeEach(async () => {
        subjectSetToken = indexWithWeth;
      });

      it("should enable the Module on the SetToken", async () => {
        await subject();
        const isModuleEnabled = await subjectSetToken.isInitializedModule(indexModule.address);
        expect(isModuleEnabled).to.eq(true);
      });
    });
  });

  describe("when module is initalized", async () => {
    let subjectSetToken: SetToken;
    let subjectCaller: Account;

    let newComponents: Address[];
    let newTargetUnits: BigNumber[];
    let oldTargetUnits: BigNumber[];
    let issueAmount: BigNumber;

    async function initSetToken(
      setToken: SetToken, components: Address[], tradeMaximums: BigNumber[], exchanges: string[], coolOffPeriods: BigNumber[]
    ) {
      await indexModule.initialize(setToken.address);
      await indexModule.setTradeMaximums(setToken.address, components, tradeMaximums);
      await indexModule.setExchanges(setToken.address, components, exchanges);
      await indexModule.setCoolOffPeriods(setToken.address, components, coolOffPeriods);
      await indexModule.updateTraderStatus(setToken.address, [trader.address], [true]);
    }

    cacheBeforeEach(async () => {
      // initialize indexModule on both SetTokens
      await initSetToken(
        index,
       [uniswapSetup.uni.address, setup.wbtc.address, setup.dai.address, sushiswapSetup.uni.address],
       [ether(800), bitcoin(.1), ether(1000), ether(500)],
       [uniswapAdapterName, sushiswapAdapterName, balancerAdapterName, sushiswapAdapterName],
       [ONE_MINUTE_IN_SECONDS.mul(3), ONE_MINUTE_IN_SECONDS, ONE_MINUTE_IN_SECONDS.mul(2), ONE_MINUTE_IN_SECONDS]
      );

      await initSetToken(
        indexWithWeth,
        [uniswapSetup.uni.address, setup.wbtc.address, setup.dai.address, setup.weth.address, sushiswapSetup.uni.address],
        [ether(800), bitcoin(.1), ether(1000), ether(10000), ether(500)],
        [uniswapAdapterName, sushiswapAdapterName, balancerAdapterName, "", sushiswapAdapterName],
        [ONE_MINUTE_IN_SECONDS.mul(3), ONE_MINUTE_IN_SECONDS, ONE_MINUTE_IN_SECONDS.mul(2), ZERO, ONE_MINUTE_IN_SECONDS],
      );
    });

    describe("#startRebalance", async () => {

      before(async () => {
        subjectSetToken = index;
        subjectCaller = owner;
        newComponents = [sushiswapSetup.uni.address];
        newTargetUnits = [ether(50)];
        oldTargetUnits = [ether("60.869565780223716593"), bitcoin(.02), ether(50)];
      });

      async function subject(): Promise<ContractTransaction> {
        return await indexModule.connect(subjectCaller.wallet).startRebalance(
          subjectSetToken.address,
          newComponents,
          newTargetUnits,
          oldTargetUnits,
          await subjectSetToken.positionMultiplier()
        );
      }

      it("should set target units and rebalance info correctly", async () => {
        await subject();

        const currentComponents = await subjectSetToken.getComponents();
        const aggregateComponents = [...currentComponents, ...newComponents];
        const aggregateTargetUnits = [...oldTargetUnits, ...newTargetUnits];

        for (let i = 0; i < aggregateComponents.length; i++) {
          const targetUnit = (await indexModule.executionInfo(subjectSetToken.address, aggregateComponents[i])).targetUnit;
          const exepectedTargetUnit = aggregateTargetUnits[i];
          expect(targetUnit).to.be.eq(exepectedTargetUnit);
        }

        // todo: How to check rebalance components?
        // const rebalanceComponents = await indexModule.rebalanceInfo(subjectSetToken.address);
        // const expectedRebalanceComponents = aggregateComponents;

        const positionMultiplier = (await indexModule.rebalanceInfo(subjectSetToken.address)).positionMultiplier;
        const expectedPositionMultiplier = await subjectSetToken.positionMultiplier();

        expect(positionMultiplier).to.be.eq(expectedPositionMultiplier);
      });

      describe("newComponents and newComponentsTargetUnits are not of same length", async () => {
        before(async () => {
          newTargetUnits = [];
        });

        after(async() => {
          newTargetUnits = [ether(50)];
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("Array length mismatch");
        });
      });

      describe("when missing target units for old comoponents", async () => {
        before(async () => {
          oldTargetUnits = [ether("60.869565780223716593"), bitcoin(.02)];
        });

        after(async () => {
          oldTargetUnits = [ether("60.869565780223716593"), bitcoin(.02), ether(50)];
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("New allocation must have target for all old components");
        });
      });

      describe("when newComponents contains an old component", async () => {
        before(async () => {
          newComponents = [sushiswapSetup.uni.address, uniswapSetup.uni.address];
          newTargetUnits = [ether(50), ether(50)];
        });

        after(async () => {
          newComponents = [sushiswapSetup.uni.address];
          newTargetUnits = [ether(50)];
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("Cannot duplicate components");
        });
      });
    });

    describe("#setCoolOffPeriods", async () => {
      let components: Address[];
      let coolOffPeriods: BigNumber[];

      before(async () => {
        subjectSetToken = index;
        subjectCaller = owner;
        components = [uniswapSetup.uni.address, setup.wbtc.address];
        coolOffPeriods = [ONE_MINUTE_IN_SECONDS.mul(3), ONE_MINUTE_IN_SECONDS];
      });

      async function subject(): Promise<ContractTransaction> {
        return await indexModule.connect(subjectCaller.wallet).setCoolOffPeriods(subjectSetToken.address, components, coolOffPeriods);
      }

      it("should set values correctly", async () => {
        await subject();

        for (let i = 0; i < components.length; i++) {
          const coolOffPeriod = (await indexModule.executionInfo(subjectSetToken.address, components[i])).coolOffPeriod;
          const exepctedCoolOffPeriod = coolOffPeriods[i];
          expect(coolOffPeriod).to.be.eq(exepctedCoolOffPeriod);
        }
      });

      describe("when array lengths are not same", async () => {
        before(async () => {
          coolOffPeriods = [ONE_MINUTE_IN_SECONDS.mul(3), ONE_MINUTE_IN_SECONDS, ONE_MINUTE_IN_SECONDS.mul(2)];
        });

        after(async () => {
          coolOffPeriods = [ONE_MINUTE_IN_SECONDS.mul(3), ONE_MINUTE_IN_SECONDS];
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("Array length mismatch");
        });
      });

      describe("when component array has duplilcate values", async () => {
        before(async () => {
          components = [uniswapSetup.uni.address, setup.wbtc.address, uniswapSetup.uni.address];
          coolOffPeriods = [ONE_MINUTE_IN_SECONDS.mul(3), ONE_MINUTE_IN_SECONDS, ONE_MINUTE_IN_SECONDS.mul(3)];
        });

        after(async () => {
          components = [uniswapSetup.uni.address, setup.wbtc.address];
          coolOffPeriods = [ONE_MINUTE_IN_SECONDS.mul(3), ONE_MINUTE_IN_SECONDS];
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("Cannot duplicate components");
        });
      });

      describe("when array length is 0", async () => {
        before(async () => {
          components = [];
          coolOffPeriods = [];
        });

        after(async () => {
          components = [uniswapSetup.uni.address, setup.wbtc.address];
          coolOffPeriods = [ONE_MINUTE_IN_SECONDS.mul(3), ONE_MINUTE_IN_SECONDS];
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("Array length must be > 0");
        });
      });
    });

    describe("#setTradeMaximums", async () => {
      let components: Address[];
      let tradeMaximums: BigNumber[];

      before(async () => {
        subjectSetToken = index;
        subjectCaller = owner;
        components = [uniswapSetup.uni.address, setup.wbtc.address];
        tradeMaximums = [ether(800), bitcoin(.1)];
      });

      async function subject(): Promise<ContractTransaction> {
        return await indexModule.connect(subjectCaller.wallet).setTradeMaximums(subjectSetToken.address, components, tradeMaximums);
      }

      it("should set values correctly", async () => {
        await subject();

        for (let i = 0; i < components.length; i++) {
          const maxSize = (await indexModule.executionInfo(subjectSetToken.address, components[i])).maxSize;
          const exepctedMaxSize = tradeMaximums[i];
          expect(maxSize).to.be.eq(exepctedMaxSize);
        }
      });
    });

    describe("#setExchanges", async () => {
      let components: Address[];
      let exchanges: string[];

      before(async () => {
        subjectSetToken = index;
        subjectCaller = owner;
        components = [uniswapSetup.uni.address, setup.wbtc.address];
        exchanges = [uniswapAdapterName, sushiswapAdapterName];
      });

      // todo: revert on setting "" as exchange name?
      async function subject(): Promise<ContractTransaction> {
        return await indexModule.connect(subjectCaller.wallet).setExchanges(subjectSetToken.address, components, exchanges);
      }

      it("should set values correctly", async () => {
        await subject();

        for (let i = 0; i < components.length; i++) {
          const exchangeName = (await indexModule.executionInfo(subjectSetToken.address, components[i])).exchangeName;
          const exepctedExchangeName = exchanges[i];
          expect(exchangeName).to.be.eq(exepctedExchangeName);
        }
      });

      describe("when array lengths are not same", async () => {
        before(async () => {
          exchanges = [uniswapAdapterName, sushiswapAdapterName, balancerAdapterName];
        });

        after(async () => {
          exchanges = [uniswapAdapterName, sushiswapAdapterName];
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("Array length mismatch");
        });
      });

      describe("when component array has duplilcate values", async () => {
        before(async () => {
          components = [uniswapSetup.uni.address, setup.wbtc.address, uniswapSetup.uni.address];
          exchanges = [uniswapAdapterName, sushiswapAdapterName, uniswapAdapterName];
        });

        after(async () => {
          components = [uniswapSetup.uni.address, setup.wbtc.address];
          exchanges = [uniswapAdapterName, sushiswapAdapterName];
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("Cannot duplicate components");
        });
      });

      describe("when component array has duplilcate values", async () => {
        before(async () => {
          components = [];
          exchanges = [];
        });

        after(async () => {
          components = [uniswapSetup.uni.address, setup.wbtc.address];
          exchanges = [uniswapAdapterName, sushiswapAdapterName];
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("Array length must be > 0");
        });
      });
    });

    describe("#trade", async () => {
      let subjectComponent: Address;
      let subjectIncreaseTime: BigNumber;
      let expectedOut: BigNumber;
      let ethQuantityLimit: BigNumber;

      before(async () => {
        // current units [ether(86.9565217), bitcoin(.01111111), ether(100), ZERO]
        subjectSetToken = index;
        newComponents = [];
        oldTargetUnits = [ether("60.869565780223716593"), bitcoin(.02), ether(50)];
        newTargetUnits = [];
        issueAmount = ether("20.000000000000000001");
      });

      beforeEach(async () => {
        subjectComponent = setup.dai.address;
        subjectIncreaseTime = ONE_MINUTE_IN_SECONDS.mul(5);
        subjectCaller = trader;

        await setup.approveAndIssueSetToken(subjectSetToken, issueAmount);
        await indexModule.startRebalance(subjectSetToken.address, newComponents, newTargetUnits, oldTargetUnits, await index.positionMultiplier());
        expectedOut = (await balancerSetup.exchange.viewSplitExactIn(
          setup.dai.address,
          setup.weth.address,
          ether(1000),
          THREE
        )).totalOutput;
        ethQuantityLimit = expectedOut;
      });

      async function subject(): Promise<ContractTransaction> {
        await increaseTimeAsync(subjectIncreaseTime);
        return await indexModule.connect(subjectCaller.wallet).trade(subjectSetToken.address, subjectComponent, ethQuantityLimit);
      }

      it("the position units and lastTradeTimestamp should be set as expected, sell using Balancer", async () => {
        const currentDaiAmount = await setup.dai.balanceOf(subjectSetToken.address);
        const currentWethAmount = await setup.weth.balanceOf(subjectSetToken.address);
        const totalSupply = await subjectSetToken.totalSupply();

        await subject();

        const lastBlockTimestamp = await getLastBlockTimestamp();

        const expectedWethPositionUnits = preciseDiv(currentWethAmount.add(expectedOut), totalSupply);
        const expectedDaiPositionUnits = preciseDiv(currentDaiAmount.sub(ether(1000)), totalSupply);

        const wethPositionUnits = await subjectSetToken.getDefaultPositionRealUnit(setup.weth.address);
        const daiPositionUnits = await subjectSetToken.getDefaultPositionRealUnit(setup.dai.address);

        const lastTrade = (await indexModule.executionInfo(subjectSetToken.address, setup.dai.address)).lastTradeTimestamp;

        expect(wethPositionUnits).to.eq(expectedWethPositionUnits);
        expect(daiPositionUnits).to.eq(expectedDaiPositionUnits);
        expect(lastTrade).to.eq(lastBlockTimestamp);
      });

      it("emits the correct TradeExecuted event", async () => {
        await expect(subject()).to.emit(indexModule, "TradeExecuted").withArgs(
          subjectSetToken.address,
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
            subjectSetToken.address,
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
        let expectedIn: BigNumber;

        beforeEach(async () => {
          subjectComponent = uniswapSetup.uni.address;
          const totalSupply = await subjectSetToken.totalSupply();
          const currentUniUnit = await subjectSetToken.getDefaultPositionRealUnit(uniswapSetup.uni.address);
          const expectedUniSize = preciseMul(currentUniUnit.sub(oldTargetUnits[0]), totalSupply);

          [expectedIn, expectedOut] = await uniswapSetup.router.getAmountsOut(
            expectedUniSize,
            [uniswapSetup.uni.address, setup.weth.address]
          );
          ethQuantityLimit = expectedOut;
        });

        it("the trade gets rounded down to meet the target", async () => {

          const totalSupply = await subjectSetToken.totalSupply();
          const currentUniAmount = await uniswapSetup.uni.balanceOf(subjectSetToken.address);
          const currentWethAmount = await setup.weth.balanceOf(subjectSetToken.address);

          await subject();

          const lastBlockTimestamp = await getLastBlockTimestamp();

          const expectedWethPositionUnits = preciseDiv(currentWethAmount.add(expectedOut), totalSupply);
          const expectedUniPositionUnits = preciseDiv(currentUniAmount.sub(expectedIn), totalSupply);

          const wethPositionUnits = await subjectSetToken.getDefaultPositionRealUnit(setup.weth.address);
          const uniPositionUnits = await subjectSetToken.getDefaultPositionRealUnit(uniswapSetup.uni.address);
          const lastTrade = (await indexModule.executionInfo(subjectSetToken.address, uniswapSetup.uni.address)).lastTradeTimestamp;

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

          ethQuantityLimit = expectedIn;
        });

        it("the position units and lastTradeTimestamp should be set as expected", async () => {
          const currentWbtcAmount = await setup.wbtc.balanceOf(subjectSetToken.address);
          const currentWethAmount = await setup.weth.balanceOf(subjectSetToken.address);

          const wethUnit = await subjectSetToken.getDefaultPositionRealUnit(setup.weth.address);
          const wbtcUnit = await subjectSetToken.getDefaultPositionRealUnit(setup.wbtc.address);
          const totalSupply = await subjectSetToken.totalSupply();


          await subject();

          const lastBlockTimestamp = await getLastBlockTimestamp();

          const wbtcExcess = currentWbtcAmount.sub(preciseMul(totalSupply, wbtcUnit));
          const wethExcess = currentWethAmount.sub(preciseMul(totalSupply, wethUnit));

          const expectedWethPositionUnits = preciseDiv(currentWethAmount.sub(expectedIn).sub(wethExcess), totalSupply);
          const expectedWbtcPositionUnits = preciseDiv(currentWbtcAmount.add(expectedOut).sub(wbtcExcess), totalSupply);

          const wethPositionUnits = await subjectSetToken.getDefaultPositionRealUnit(setup.weth.address);
          const wbtcPositionUnits = await subjectSetToken.getDefaultPositionRealUnit(setup.wbtc.address);
          const lastTrade = (await indexModule.executionInfo(subjectSetToken.address, setup.wbtc.address)).lastTradeTimestamp;

          expect(wbtcPositionUnits).to.eq(expectedWbtcPositionUnits);
          expect(wethPositionUnits).to.eq(expectedWethPositionUnits);
          expect(lastTrade).to.eq(lastBlockTimestamp);
        });

        it("emits the correct TradeExecuted event", async () => {
          await expect(subject()).to.emit(indexModule, "TradeExecuted").withArgs(
            subjectSetToken.address,
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

      describe("when the sell happens on Sushiswap", async () => {
        let expectedIn: BigNumber;

        before(async () => {
          oldTargetUnits = [ether(100), ZERO, ether(185)];
        });

        beforeEach(async () => {
          subjectComponent = setup.wbtc.address;

          [expectedIn, expectedOut] = await sushiswapSetup.router.getAmountsOut(
            bitcoin(.1),
            [setup.wbtc.address, setup.weth.address]
          );
          ethQuantityLimit = expectedOut;
        });

        after(async () => {
          oldTargetUnits = [ether(60.869565), bitcoin(.02), ether(50)];
        });

        it("the position units and lastTradeTimestamp should be set as expected", async () => {

          const currentWbtcAmount = await setup.wbtc.balanceOf(subjectSetToken.address);
          const currentWethAmount = await setup.weth.balanceOf(subjectSetToken.address);

          const wethUnit = await subjectSetToken.getDefaultPositionRealUnit(setup.weth.address);
          const wbtcUnit = await subjectSetToken.getDefaultPositionRealUnit(setup.wbtc.address);
          const totalSupply = await subjectSetToken.totalSupply();

          await subject();

          const lastBlockTimestamp = await getLastBlockTimestamp();

          const wbtcExcess = currentWbtcAmount.sub(preciseMul(totalSupply, wbtcUnit));
          const wethExcess = currentWethAmount.sub(preciseMul(totalSupply, wethUnit));

          const expectedWethPositionUnits = preciseDiv(currentWethAmount.add(expectedOut).sub(wethExcess), totalSupply);
          const expectedWbtcPositionUnits = preciseDiv(currentWbtcAmount.sub(expectedIn).sub(wbtcExcess), totalSupply);

          const wethPositionUnits = await subjectSetToken.getDefaultPositionRealUnit(setup.weth.address);
          const wbtcPositionUnits = await subjectSetToken.getDefaultPositionRealUnit(setup.wbtc.address);
          const lastTrade = (await indexModule.executionInfo(subjectSetToken.address, setup.wbtc.address)).lastTradeTimestamp;

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
            await indexModule.connect(trader.wallet).trade(subjectSetToken.address, setup.wbtc.address, ZERO);
            await increaseTimeAsync(ONE_MINUTE_IN_SECONDS.mul(5));
            await indexModule.connect(trader.wallet).trade(subjectSetToken.address, setup.wbtc.address, ZERO);

            [expectedIn, expectedOut] = await sushiswapSetup.router.getAmountsOut(
              await componentAmountTraded(indexModule, subjectSetToken, setup.wbtc.address),
              [setup.wbtc.address, setup.weth.address]
            );
            ethQuantityLimit = expectedOut;
          });

          after(async () => {
            oldTargetUnits = [ether(60.869565), bitcoin(.02), ether(50)];
          });

          it("should remove the asset from the index", async () => {
            await subject();

            const components = await subjectSetToken.getComponents();
            const positionUnit = await subjectSetToken.getDefaultPositionRealUnit(setup.wbtc.address);

            expect(components).to.not.contain(setup.wbtc.address);
            expect(positionUnit).to.eq(ZERO);
          });
        });
      });

      describe("when the buy happens on Balancer", async () => {
        let expectedIn: BigNumber;

        before(async () => {
          oldTargetUnits = [ether(100), ZERO, ether(185)];
        });

        beforeEach(async () => {
          await increaseTimeAsync(ONE_MINUTE_IN_SECONDS.mul(5));
          await indexModule.connect(trader.wallet).trade(subjectSetToken.address, setup.wbtc.address, ZERO);
          await increaseTimeAsync(ONE_MINUTE_IN_SECONDS.mul(5));
          await indexModule.connect(trader.wallet).trade(subjectSetToken.address, setup.wbtc.address, ZERO);

          subjectComponent = setup.dai.address;
          expectedIn = (await balancerSetup.exchange.viewSplitExactOut(
            setup.weth.address,
            setup.dai.address,
            ether(1000),
            THREE
          )).totalOutput;
          ethQuantityLimit = expectedIn;
        });

        after(async () => {
          oldTargetUnits = [ether(60.869565), bitcoin(.02), ether(50)];
        });

        it("the position units and lastTradeTimestamp should be set as expected", async () => {
          const currentDaiAmount = await setup.dai.balanceOf(subjectSetToken.address);
          const currentWethAmount = await setup.weth.balanceOf(subjectSetToken.address);

          const wethUnit = await subjectSetToken.getDefaultPositionRealUnit(setup.weth.address);
          const daiUnit = await subjectSetToken.getDefaultPositionRealUnit(setup.dai.address);
          const totalSupply = await subjectSetToken.totalSupply();

          await subject();

          const lastBlockTimestamp = await getLastBlockTimestamp();

          const wethPositionUnits = await subjectSetToken.getDefaultPositionRealUnit(setup.weth.address);
          const daiPositionUnits = await subjectSetToken.getDefaultPositionRealUnit(setup.dai.address);
          const lastTrade = (await indexModule.executionInfo(subjectSetToken.address, setup.dai.address)).lastTradeTimestamp;

          const daiExcess = currentDaiAmount.sub(preciseMul(totalSupply, daiUnit));
          const wethExcess = currentWethAmount.sub(preciseMul(totalSupply, wethUnit));
          const expectedWethPositionUnits = preciseDiv(
            currentWethAmount.sub(expectedIn).sub(wethExcess),
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
          await indexModule.connect(trader.wallet).trade(subjectSetToken.address, setup.wbtc.address, ZERO);

          subjectComponent = sushiswapSetup.uni.address;
          const [amountIn, ] = await sushiswapSetup.router.getAmountsIn(
            ether(500),
            [setup.weth.address, sushiswapSetup.uni.address]
          );
          ethQuantityLimit = amountIn;
        });

        after(async () => {
          oldTargetUnits = [ether(60.869565), bitcoin(.02), ether(50)];
          newComponents = [];
          newTargetUnits = [];
        });

        it("the position units and lastTradeTimestamp should be set as expected", async () => {
          await subject();

          const lastBlockTimestamp = await getLastBlockTimestamp();
          const totalSupply = await subjectSetToken.totalSupply();
          const components = await subjectSetToken.getComponents();
          const expectedSushiPositionUnits = preciseDiv(ether(500), totalSupply);

          const sushiPositionUnits = await subjectSetToken.getDefaultPositionRealUnit(sushiswapSetup.uni.address);
          const lastTrade = (await indexModule.executionInfo(subjectSetToken.address, sushiswapSetup.uni.address)).lastTradeTimestamp;

          expect(components).to.contain(sushiswapSetup.uni.address);
          expect(sushiPositionUnits).to.eq(expectedSushiPositionUnits);
          expect(lastTrade).to.eq(lastBlockTimestamp);
        });
      });

      describe("when fees are accrued and target is met", async () => {
        before(async () => {
          issueAmount = ether(20);
        });

        beforeEach(async () => {
          await increaseTimeAsync(ONE_MINUTE_IN_SECONDS.mul(5));
          await indexModule.connect(trader.wallet).trade(subjectSetToken.address, setup.dai.address, ZERO);

          await setup.streamingFeeModule.accrueFee(subjectSetToken.address);
        });

        after(async () => {
          issueAmount = ether("20.000000000000000001");
        });

        it("the trade reverts", async () => {
          const targetUnit = (await indexModule.executionInfo(subjectSetToken.address, setup.dai.address)).targetUnit;
          const currentUnit = await subjectSetToken.getDefaultPositionRealUnit(setup.dai.address);

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
          await indexModule.connect(trader.wallet).trade(subjectSetToken.address, setup.dai.address, ZERO);
        });

        after(async () => {
          issueAmount = ether("20.000000000000000001");
        });

        it("the trade reverts", async () => {
          await expect(subject()).to.be.revertedWith("Target already met");
        });
      });

      describe("when anyoneTrade is true and a random address calls", async () => {
        beforeEach(async () => {
          await indexModule.updateAnyoneTrade(subjectSetToken.address, true);
          subjectCaller = await getRandomAccount();
        });

        it("the trade should not revert", async () => {
          await expect(subject()).to.not.be.reverted;
        });
      });

      describe("when the component is weth", async() => {
        beforeEach(async () => {
          subjectComponent = setup.weth.address;
        });

        it("should revert", async () => {
          expect(subject()).to.be.revertedWith("Can not explicitly trade WETH");
        });
      });

      describe("when set has weth as component", async () => {
        before(async () => {
          // current units [ether(86.9565217), bitcoin(.01111111), ether(100), ether(0.434782609), ZERO]
          subjectSetToken = indexWithWeth;
          newComponents = [];
          oldTargetUnits = [ether("60.869565780223716593"), bitcoin(.02), ether(50), ether(0.434782609)];
          newTargetUnits = [];
          issueAmount = ether("20.000000000000000000");
        });

        it("the position units and lastTradeTimestamp should be set as expected, sell using Balancer", async () => {
          const currentDaiAmount = await setup.dai.balanceOf(subjectSetToken.address);
          const currentWethAmount = await setup.weth.balanceOf(subjectSetToken.address);
          const totalSupply = await subjectSetToken.totalSupply();

          await subject();

          const lastBlockTimestamp = await getLastBlockTimestamp();

          const expectedWethPositionUnits = preciseDiv(currentWethAmount.add(expectedOut), totalSupply);
          const expectedDaiPositionUnits = preciseDiv(currentDaiAmount.sub(ether(1000)), totalSupply);

          const wethPositionUnits = await subjectSetToken.getDefaultPositionRealUnit(setup.weth.address);
          const daiPositionUnits = await subjectSetToken.getDefaultPositionRealUnit(setup.dai.address);

          const lastTrade = (await indexModule.executionInfo(subjectSetToken.address, setup.dai.address)).lastTradeTimestamp;

          expect(wethPositionUnits).to.eq(expectedWethPositionUnits);
          expect(daiPositionUnits).to.eq(expectedDaiPositionUnits);
          expect(lastTrade).to.eq(lastBlockTimestamp);
        });

        it("emits the correct TradeExecuted event", async () => {
          await expect(subject()).to.emit(indexModule, "TradeExecuted").withArgs(
            subjectSetToken.address,
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
              subjectSetToken.address,
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
          let expectedIn: BigNumber;

          beforeEach(async () => {
            subjectComponent = uniswapSetup.uni.address;

            const totalSupply = await subjectSetToken.totalSupply();
            const currentUniUnit = await subjectSetToken.getDefaultPositionRealUnit(uniswapSetup.uni.address);
            const expectedUniSize = preciseMul(currentUniUnit.sub(oldTargetUnits[0]), totalSupply);
            [expectedIn, expectedOut] = await uniswapSetup.router.getAmountsOut(
              expectedUniSize,
              [uniswapSetup.uni.address, setup.weth.address]
            );
            ethQuantityLimit = expectedOut;
          });

          it("the trade gets rounded down to meet the target", async () => {
            const totalSupply = await subjectSetToken.totalSupply();

            const currentUniAmount = await uniswapSetup.uni.balanceOf(subjectSetToken.address);
            const currentWethAmount = await setup.weth.balanceOf(subjectSetToken.address);

            await subject();

            const lastBlockTimestamp = await getLastBlockTimestamp();

            const expectedWethPositionUnits = preciseDiv(currentWethAmount.add(expectedOut), totalSupply);
            const expectedUniPositionUnits = preciseDiv(currentUniAmount.sub(expectedIn), totalSupply);

            const wethPositionUnits = await subjectSetToken.getDefaultPositionRealUnit(setup.weth.address);
            const uniPositionUnits = await subjectSetToken.getDefaultPositionRealUnit(uniswapSetup.uni.address);
            const lastTrade = (await indexModule.executionInfo(subjectSetToken.address, uniswapSetup.uni.address)).lastTradeTimestamp;

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

            ethQuantityLimit = expectedIn;
          });

          it("the position units and lastTradeTimestamp should be set as expected", async () => {
            const currentWbtcAmount = await setup.wbtc.balanceOf(subjectSetToken.address);
            const currentWethAmount = await setup.weth.balanceOf(subjectSetToken.address);

            const wethUnit = await subjectSetToken.getDefaultPositionRealUnit(setup.weth.address);
            const wbtcUnit = await subjectSetToken.getDefaultPositionRealUnit(setup.wbtc.address);
            const totalSupply = await subjectSetToken.totalSupply();

            await subject();

            const lastBlockTimestamp = await getLastBlockTimestamp();

            const wbtcExcess = currentWbtcAmount.sub(preciseMul(totalSupply, wbtcUnit));
            const wethExcess = currentWethAmount.sub(preciseMul(totalSupply, wethUnit));

            const expectedWethPositionUnits = preciseDiv(currentWethAmount.sub(expectedIn).sub(wethExcess), totalSupply);
            const expectedWbtcPositionUnits = preciseDiv(currentWbtcAmount.add(expectedOut).sub(wbtcExcess), totalSupply);

            const wethPositionUnits = await subjectSetToken.getDefaultPositionRealUnit(setup.weth.address);
            const wbtcPositionUnits = await subjectSetToken.getDefaultPositionRealUnit(setup.wbtc.address);
            const lastTrade = (await indexModule.executionInfo(subjectSetToken.address, setup.wbtc.address)).lastTradeTimestamp;

            expect(wbtcPositionUnits).to.eq(expectedWbtcPositionUnits);
            expect(wethPositionUnits).to.eq(expectedWethPositionUnits);
            expect(lastTrade).to.eq(lastBlockTimestamp);
          });

          it("emits the correct TradeExecuted event", async () => {
            await expect(subject()).to.emit(indexModule, "TradeExecuted").withArgs(
              subjectSetToken.address,
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

        describe("when the sell happens on Sushiswap", async () => {
          let expectedIn: BigNumber;

          before(async () => {
            oldTargetUnits = [ether(100), ZERO, ether(185), ether(0.434782609)];
          });

          beforeEach(async () => {
            subjectComponent = setup.wbtc.address;
            [expectedIn, expectedOut] = await sushiswapSetup.router.getAmountsOut(
              bitcoin(.1),
              [setup.wbtc.address, setup.weth.address]
            );
            ethQuantityLimit = expectedOut;
          });

          after(async () => {
            oldTargetUnits = [ether(60.869565), bitcoin(.02), ether(50), ether(0.434782609)];
          });

          it("the position units and lastTradeTimestamp should be set as expected", async () => {
            const currentWbtcAmount = await setup.wbtc.balanceOf(subjectSetToken.address);
            const currentWethAmount = await setup.weth.balanceOf(subjectSetToken.address);

            const wethUnit = await subjectSetToken.getDefaultPositionRealUnit(setup.weth.address);
            const wbtcUnit = await subjectSetToken.getDefaultPositionRealUnit(setup.wbtc.address);
            const totalSupply = await subjectSetToken.totalSupply();

            await subject();

            const lastBlockTimestamp = await getLastBlockTimestamp();

            const wbtcExcess = currentWbtcAmount.sub(preciseMul(totalSupply, wbtcUnit));
            const wethExcess = currentWethAmount.sub(preciseMul(totalSupply, wethUnit));

            const expectedWethPositionUnits = preciseDiv(currentWethAmount.add(expectedOut).sub(wethExcess), totalSupply);
            const expectedWbtcPositionUnits = preciseDiv(currentWbtcAmount.sub(expectedIn).sub(wbtcExcess), totalSupply);

            const wethPositionUnits = await subjectSetToken.getDefaultPositionRealUnit(setup.weth.address);
            const wbtcPositionUnits = await subjectSetToken.getDefaultPositionRealUnit(setup.wbtc.address);
            const lastTrade = (await indexModule.executionInfo(subjectSetToken.address, setup.wbtc.address)).lastTradeTimestamp;

            expect(wbtcPositionUnits).to.eq(expectedWbtcPositionUnits);
            expect(wethPositionUnits).to.eq(expectedWethPositionUnits);
            expect(lastTrade).to.eq(lastBlockTimestamp);
          });

          describe("sell trade zeroes out the asset", async () => {
            before(async () => {
              oldTargetUnits = [ether(100), ZERO, ether(185), ether(0.434782609)];
            });

            beforeEach(async () => {
              await increaseTimeAsync(ONE_MINUTE_IN_SECONDS.mul(5));
              await indexModule.connect(trader.wallet).trade(subjectSetToken.address, setup.wbtc.address, ZERO);
              await increaseTimeAsync(ONE_MINUTE_IN_SECONDS.mul(5));
              await indexModule.connect(trader.wallet).trade(subjectSetToken.address, setup.wbtc.address, ZERO);

              [expectedIn, expectedOut] = await sushiswapSetup.router.getAmountsOut(
                await componentAmountTraded(indexModule, subjectSetToken, setup.wbtc.address),
                [setup.wbtc.address, setup.weth.address]
              );
              ethQuantityLimit = expectedOut;
            });

            after(async () => {
              oldTargetUnits = [ether(60.869565), bitcoin(.02), ether(50)];
            });

            it("should remove the asset from the index", async () => {
              await subject();

              const components = await subjectSetToken.getComponents();
              const positionUnit = await subjectSetToken.getDefaultPositionRealUnit(setup.wbtc.address);

              expect(components).to.not.contain(setup.wbtc.address);
              expect(positionUnit).to.eq(ZERO);
            });
          });
        });

        describe("when the buy happens on Balancer", async () => {
          let expectedIn: BigNumber;

          before(async () => {
            oldTargetUnits = [ether(100), ZERO, ether(185), ether(0.434782609)];
          });

          beforeEach(async () => {
            await increaseTimeAsync(ONE_MINUTE_IN_SECONDS.mul(5));
            await indexModule.connect(trader.wallet).trade(subjectSetToken.address, setup.wbtc.address, ZERO);
            await increaseTimeAsync(ONE_MINUTE_IN_SECONDS.mul(5));
            await indexModule.connect(trader.wallet).trade(subjectSetToken.address, setup.wbtc.address, ZERO);

            subjectComponent = setup.dai.address;
            expectedIn = (await balancerSetup.exchange.viewSplitExactOut(
              setup.weth.address,
              setup.dai.address,
              ether(1000),
              THREE
            )).totalOutput;
            ethQuantityLimit = expectedIn;
          });

          after(async () => {
            oldTargetUnits = [ether(60.869565), bitcoin(.02), ether(50), ether(0.434782609)];
          });

          it("the position units and lastTradeTimestamp should be set as expected", async () => {
            const currentDaiAmount = await setup.dai.balanceOf(subjectSetToken.address);
            const currentWethAmount = await setup.weth.balanceOf(subjectSetToken.address);

            const wethUnit = await subjectSetToken.getDefaultPositionRealUnit(setup.weth.address);
            const daiUnit = await subjectSetToken.getDefaultPositionRealUnit(setup.dai.address);
            const totalSupply = await subjectSetToken.totalSupply();

            await subject();

            const lastBlockTimestamp = await getLastBlockTimestamp();

            const wethPositionUnits = await subjectSetToken.getDefaultPositionRealUnit(setup.weth.address);
            const daiPositionUnits = await subjectSetToken.getDefaultPositionRealUnit(setup.dai.address);
            const lastTrade = (await indexModule.executionInfo(subjectSetToken.address, setup.dai.address)).lastTradeTimestamp;

            const daiExcess = currentDaiAmount.sub(preciseMul(totalSupply, daiUnit));
            const wethExcess = currentWethAmount.sub(preciseMul(totalSupply, wethUnit));
            const expectedWethPositionUnits = preciseDiv(
              currentWethAmount.sub(expectedIn).sub(wethExcess),
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
            oldTargetUnits = [ether(100), ZERO, ether(185), ether(0.434782609)];
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
            await indexModule.connect(trader.wallet).trade(subjectSetToken.address, setup.wbtc.address, ZERO);

            subjectComponent = sushiswapSetup.uni.address;
            const [amountIn, ] = await sushiswapSetup.router.getAmountsIn(
              ether(500),
              [setup.weth.address, sushiswapSetup.uni.address]
            );
            ethQuantityLimit = amountIn;
          });

          after(async () => {
            oldTargetUnits = [ether(60.869565), bitcoin(.02), ether(50), ether(0.434782609)];
            newComponents = [];
            newTargetUnits = [];
          });

          it("the position units and lastTradeTimestamp should be set as expected", async () => {
            await subject();

            const lastBlockTimestamp = await getLastBlockTimestamp();
            const totalSupply = await subjectSetToken.totalSupply();
            const components = await subjectSetToken.getComponents();
            const expectedSushiPositionUnits = preciseDiv(ether(500), totalSupply);

            const sushiPositionUnits = await subjectSetToken.getDefaultPositionRealUnit(sushiswapSetup.uni.address);
            const lastTrade = (await indexModule.executionInfo(subjectSetToken.address, sushiswapSetup.uni.address)).lastTradeTimestamp;

            expect(components).to.contain(sushiswapSetup.uni.address);
            expect(sushiPositionUnits).to.eq(expectedSushiPositionUnits);
            expect(lastTrade).to.eq(lastBlockTimestamp);
          });
        });

        describe("when fees are accrued and target is met", async () => {
          before(async () => {
            issueAmount = ether(20);
          });

          beforeEach(async () => {
            await increaseTimeAsync(ONE_MINUTE_IN_SECONDS.mul(5));
            await indexModule.connect(trader.wallet).trade(subjectSetToken.address, setup.dai.address, ZERO);

            await setup.streamingFeeModule.accrueFee(subjectSetToken.address);
          });

          after(async () => {
            issueAmount = ether("20.000000000000000001");
          });

          it("the trade reverts", async () => {
            const targetUnit = (await indexModule.executionInfo(subjectSetToken.address, setup.dai.address)).targetUnit;
            const currentUnit = await subjectSetToken.getDefaultPositionRealUnit(setup.dai.address);

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
            await indexModule.connect(trader.wallet).trade(subjectSetToken.address, setup.dai.address, ZERO);
          });

          after(async () => {
            issueAmount = ether("20.000000000000000001");
          });

          it("the trade reverts", async () => {
            await expect(subject()).to.be.revertedWith("Target already met");
          });
        });

        describe("when anyoneTrade is true and a random address calls", async () => {
          beforeEach(async () => {
            await indexModule.updateAnyoneTrade(subjectSetToken.address, true);
            subjectCaller = await getRandomAccount();
          });

          it("the trade should not revert", async () => {
            await expect(subject()).to.not.be.reverted;
          });
        });

        describe("when the component is weth", async() => {
          beforeEach(async () => {
            subjectComponent = setup.weth.address;
          });

          it("should revert", async () => {
            expect(subject()).to.be.revertedWith("Can not explicitly trade WETH");
          });
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
          subjectComponent = sushiswapSetup.uni.address;
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
          await indexModule.connect(owner.wallet).updateTraderStatus(subjectSetToken.address, [contractCaller.address], [true]);

          subjectTarget = indexModule.address;
          subjectCallData = indexModule.interface.encodeFunctionData("trade", [subjectSetToken.address, subjectComponent, ZERO]);
          subjectValue = ZERO;
        });

        async function subjectContractCaller(): Promise<ContractTransaction> {
          return await contractCaller.invoke(
            subjectTarget,
            subjectValue,
            subjectCallData
          );
        }

        it("allows trading", async () => {
          await expect(subjectContractCaller()).to.not.be.reverted;
        });

        describe("when anyone trade is true", async () => {
          beforeEach(async () => {
            await indexModule.connect(owner.wallet).updateAnyoneTrade(subjectSetToken.address, true);
          });

          it("the trader reverts", async () => {
            await expect(subjectContractCaller()).to.be.revertedWith("Caller must be EOA Address");
          });
        });
      });

      // todo: Should we revert if exchange is not set
      // describe("when exchange has not been set", async () => {
      //   beforeEach(async () => {
      //     await indexModule.setExchanges(subjectSetToken.address, [subjectComponent], [""]);
      //   });
      //   it("the trade reverts", async () => {
      //     await expect(subject()).to.be.revertedWith("Exchange must be specified");
      //   });
      // });
    });

    describe("#tradeRemainingWETH", async () => {
      let subjectComponent: Address;
      let components: Address[];
      let remainingWETH: BigNumber;
      let expectedSubjectAmountOut: BigNumber;

      before(async () => {
        subjectCaller = trader;
        subjectSetToken = index;
        components = [...indexComponents, sushiswapSetup.uni.address];
        subjectComponent = setup.dai.address;

        oldTargetUnits = [ether(86.9565217), bitcoin(.01111), ether(200)];
        issueAmount = ether("20.000000000000000000");
      });

      beforeEach(async () => {
        await setup.approveAndIssueSetToken(subjectSetToken, issueAmount);
        await indexModule.startRebalance(subjectSetToken.address, newComponents, newTargetUnits, oldTargetUnits, await index.positionMultiplier());

        // sell bitcoin for weth
        await increaseTimeAsync(ONE_MINUTE_IN_SECONDS.mul(5));
        await indexModule.connect(trader.wallet).trade(subjectSetToken.address, setup.wbtc.address, ZERO);

        const totalSupply = await subjectSetToken.totalSupply();
        const wethAmount = await setup.weth.balanceOf(subjectSetToken.address);
        const wethTragetUnit = (await indexModule.executionInfo(subjectSetToken.address, setup.weth.address)).targetUnit;
        remainingWETH = wethAmount.sub(preciseMul(wethTragetUnit, totalSupply));

        expectedSubjectAmountOut = (await balancerSetup.exchange.viewSplitExactIn(
          setup.weth.address,
          subjectComponent,
          remainingWETH.gt(ZERO) ? remainingWETH : ZERO,
          THREE
        )).totalOutput;
      });

      async function subject(): Promise<ContractTransaction> {
        return await indexModule.connect(subjectCaller.wallet).tradeRemainingWETH(
          subjectSetToken.address,
          subjectComponent,
          expectedSubjectAmountOut
        );
      }

      it("should trade remaining weth for dai", async () => {

        const totalSupply = await subjectSetToken.totalSupply();
        const wethAmount = await setup.weth.balanceOf(subjectSetToken.address);
        const daiAmount = await setup.dai.balanceOf(subjectSetToken.address);

        await subject();

        const wethPositionUnits = await subjectSetToken.getDefaultPositionRealUnit(setup.weth.address);
        const daiPositionUnits = await subjectSetToken.getDefaultPositionRealUnit(setup.dai.address);

        const expectedWethPositionUnits = preciseDiv(wethAmount.sub(remainingWETH), totalSupply);
        const expectedDaiPositionUnits = preciseDiv(daiAmount.add(expectedSubjectAmountOut), totalSupply);

        expect(wethPositionUnits).to.eq(expectedWethPositionUnits);
        expect(daiPositionUnits).to.eq(expectedDaiPositionUnits);
      });

      it("emits the correct TradeExecuted event", async () => {
        await expect(subject()).to.be.emit(indexModule, "TradeExecuted").withArgs(
          subjectSetToken.address,
          setup.weth.address,
          setup.dai.address,
          balancerExchangeAdapter.address,
          subjectCaller.wallet.address,
          remainingWETH,
          expectedSubjectAmountOut,
          ZERO,
        );
      });

      describe("when protocol fees is charged", async () => {
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
          const protocolFee = expectedSubjectAmountOut.mul(feePercentage).div(ether(1));
          await expect(subject()).to.be.emit(indexModule, "TradeExecuted").withArgs(
            subjectSetToken.address,
            setup.weth.address,
            setup.dai.address,
            balancerExchangeAdapter.address,
            subjectCaller.wallet.address,
            remainingWETH,
            expectedSubjectAmountOut.sub(protocolFee),
            protocolFee,
          );
        });
      });

      describe("when not all tokens are sold", async () => {
        before(async () => {
          oldTargetUnits = [ether(80), bitcoin(.01), ether(200)];
        });

        after(async () => {
          oldTargetUnits = [ether(86.9565217), bitcoin(.01), ether(200)];
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("Sell other set components first");
        });
      });

      describe("when component amount traded exceeds max tradesize", async () => {
        beforeEach(async () => {
          await indexModule.setTradeMaximums(subjectSetToken.address, components, [ether(800), bitcoin(.1), ether(100), ether(500)]);
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("Trade amount exceeds max allowed trade size");
        });
      });

      describe("when the calling address is not a permissioned address", async () => {
        before(async () => {
          subjectCaller = await getRandomAccount();
        });

        after(async () => {
          subjectCaller = trader;
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("Address not permitted to trade");
        });
      });

      describe("when set has weth as component", async () => {
        before(async () => {
          subjectSetToken = indexWithWeth;
          subjectCaller = trader;
          components = [...indexWithWethComponents, sushiswapSetup.uni.address];
          oldTargetUnits = [ether(86.9565217), bitcoin(.01111), ether(200), ether(0.434782609)];
        });

        it("should trade remaining weth for dai", async () => {

          const totalSupply = await subjectSetToken.totalSupply();
          const wethAmount = await setup.weth.balanceOf(subjectSetToken.address);
          const daiAmount = await setup.dai.balanceOf(subjectSetToken.address);

          await subject();

          const wethPositionUnits = await subjectSetToken.getDefaultPositionRealUnit(setup.weth.address);
          const daiPositionUnits = await subjectSetToken.getDefaultPositionRealUnit(setup.dai.address);

          const expectedWethPositionUnits = preciseDiv(wethAmount.sub(remainingWETH), totalSupply);
          const expectedDaiPositionUnits = preciseDiv(daiAmount.add(expectedSubjectAmountOut), totalSupply);

          expect(wethPositionUnits).to.eq(expectedWethPositionUnits);
          expect(daiPositionUnits).to.eq(expectedDaiPositionUnits);
        });

        it("emits the correcte TradeExecuted event", async () => {
          await expect(subject()).to.be.emit(indexModule, "TradeExecuted").withArgs(
            subjectSetToken.address,
            setup.weth.address,
            setup.dai.address,
            balancerExchangeAdapter.address,
            subjectCaller.wallet.address,
            remainingWETH,
            expectedSubjectAmountOut,
            ZERO,
          );
        });

        describe("when protocol fees is charged", async () => {
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
            const protocolFee = expectedSubjectAmountOut.mul(feePercentage).div(ether(1));
            await expect(subject()).to.be.emit(indexModule, "TradeExecuted").withArgs(
              subjectSetToken.address,
              setup.weth.address,
              setup.dai.address,
              balancerExchangeAdapter.address,
              subjectCaller.wallet.address,
              remainingWETH,
              expectedSubjectAmountOut.sub(protocolFee),
              protocolFee,
            );
          });
        });

        describe("when not all tokens are sold", async () => {
          before(async () => {
            oldTargetUnits = [ether(80), bitcoin(.01), ether(200), ether(0.434782609)];
          });

          after(async () => {
            oldTargetUnits = [ether(86.9565217), bitcoin(.01), ether(200), ether(0.434782609)];
          });

          it("should revert", async () => {
            await expect(subject()).to.be.revertedWith("Sell other set components first");
          });
        });

        describe("when component amount traded exceeds max tradesize", async () => {
          beforeEach(async () => {
            await indexModule.setTradeMaximums(subjectSetToken.address, components, [ether(800), bitcoin(.1), ether(100), ether(10000), ether(500)]);
          });

          it("should revert", async () => {
            await expect(subject()).to.be.revertedWith("Trade amount exceeds max allowed trade size");
          });
        });

        describe("when weth is below target unit", async () => {
          before(async() => {
            oldTargetUnits = [ether(86.9565217), bitcoin(.01111), ether(200), ether(0.8)];  // increased weth target unit
          });

          after(async () => {
            oldTargetUnits = [ether(86.9565217), bitcoin(.01111), ether(200), ether(0.434782609)];
          });

          it("shoud revert", async () => {
          await expect(subject()).to.be.revertedWith("WETH is below target unit and can not be traded");
          });
        });
      });
    });

    describe("#raiseAssetTargets", async () => {
      let subjectIncreaseTime: BigNumber;
      let subjectSetToken: SetToken;
      let subjectRaiseTargetPercentage: BigNumber;

      before(async () => {
        newComponents = [];
        newTargetUnits = [];
        oldTargetUnits = [ether(100), ZERO, ether(175)];  // 10$ of WETH should be extra in the SetToken
        issueAmount = ether("20.000000000000000000");
        subjectRaiseTargetPercentage = ether("0.02");

        subjectSetToken = index;
        subjectIncreaseTime = ONE_MINUTE_IN_SECONDS.mul(5);
      });

      describe("#updateRaiseTargetPercentage", async () => {
        before(async () => {
          subjectCaller = owner;
        });

        async function subject(): Promise<ContractTransaction> {
          return await indexModule.connect(subjectCaller.wallet).updateRaiseTargetPercentage(subjectSetToken.address, subjectRaiseTargetPercentage);
        }

        it("updates raiseTargetPercentage", async () => {
          await subject();
          const newRaiseTargetPercentage = (await indexModule.rebalanceInfo(subjectSetToken.address)).raiseTargetPercentage;

          expect(newRaiseTargetPercentage).to.eq(subjectRaiseTargetPercentage);
        });

        it("emits correct RaiseTargetPercentageUpdated event", async () => {
          await expect(subject()).to.emit(indexModule, "RaiseTargetPercentageUpdated").withArgs(
            subjectSetToken.address,
            subjectRaiseTargetPercentage
          );
        });

        describe("when target percentage is 0", async () => {
          before(async () => {
            subjectRaiseTargetPercentage = ZERO;
          });

          after(async () => {
            subjectRaiseTargetPercentage = ether("0.02");
          });

          it("should revert", async () => {
            await expect(subject()).to.be.revertedWith("Target percentage must be > 0");
          });
        });
      });

      describe("when all target units have been met and weth is remaining", async () => {
        before(async () => {
          subjectCaller = trader;
        });

        beforeEach(async () => {
          await setup.approveAndIssueSetToken(subjectSetToken, issueAmount);
          await indexModule.startRebalance(subjectSetToken.address, newComponents, newTargetUnits, oldTargetUnits, await index.positionMultiplier());
        });

        async function subject(): Promise<ContractTransaction> {
          await increaseTimeAsync(subjectIncreaseTime);
          await indexModule.connect(subjectCaller.wallet).raiseAssetTargets(subjectSetToken.address);

          // trade WETH for uniswap.uni, to reach target unit
          await increaseTimeAsync(ONE_MINUTE_IN_SECONDS.mul(5));
          await indexModule.connect(trader.wallet).trade(subjectSetToken.address, uniswapSetup.uni.address, MAX_UINT_256);

          // trade WETH for dai, to reach dai target unit
          await increaseTimeAsync(ONE_MINUTE_IN_SECONDS.mul(5));
          return await indexModule.connect(trader.wallet).trade(subjectSetToken.address, setup.dai.address, MAX_UINT_256);
        }

        async function sellWbtcForWeth() {
          // trade WBTC for WETH, to reach target unit
          await increaseTimeAsync(ONE_MINUTE_IN_SECONDS.mul(5));
          await indexModule.connect(trader.wallet).trade(subjectSetToken.address, setup.wbtc.address, ZERO);
          await increaseTimeAsync(ONE_MINUTE_IN_SECONDS.mul(5));
          await indexModule.connect(trader.wallet).trade(subjectSetToken.address, setup.wbtc.address, ZERO);
          await increaseTimeAsync(ONE_MINUTE_IN_SECONDS.mul(5));
          await indexModule.connect(trader.wallet).trade(subjectSetToken.address, setup.wbtc.address, ZERO);
        }

        async function buyUniAndDaiUsingWeth() {
          // trade WETH for uniswap.uni, to reach target unit
          await increaseTimeAsync(ONE_MINUTE_IN_SECONDS.mul(5));
          await indexModule.connect(trader.wallet).trade(subjectSetToken.address, uniswapSetup.uni.address, MAX_UINT_256);

          // trade WETH for dai, to reach dai target unit
          await increaseTimeAsync(ONE_MINUTE_IN_SECONDS.mul(5));
          await indexModule.connect(trader.wallet).trade(subjectSetToken.address, setup.dai.address, MAX_UINT_256);
          await increaseTimeAsync(ONE_MINUTE_IN_SECONDS.mul(5));
          await indexModule.connect(trader.wallet).trade(subjectSetToken.address, setup.dai.address, MAX_UINT_256);
        }
        it("should raise asset targets and allow trading", async () => {

          await indexModule.connect(owner.wallet).updateRaiseTargetPercentage(subjectSetToken.address, subjectRaiseTargetPercentage);

          const daiPositionUnits = await subjectSetToken.getDefaultPositionRealUnit(setup.dai.address);
          const uniPositionUnits = await subjectSetToken.getDefaultPositionRealUnit(uniswapSetup.uni.address);

          await sellWbtcForWeth();
          await buyUniAndDaiUsingWeth();
          await subject();

          // const expectedDaiPositionUnits = daiPositionUnits.mul(ether(1).add(subjectRaiseTargetPercentage).div(ether(1)));
          // const expectedUniPositionUnits = uniPositionUnits.mul(ether(1).add(subjectRaiseTargetPercentage).div(ether(1)));

          const newDaiPositionUnits = await subjectSetToken.getDefaultPositionRealUnit(setup.dai.address);
          const newUniPositionUnits = await subjectSetToken.getDefaultPositionRealUnit(uniswapSetup.uni.address);
          const newWbtcPositionUnits = await subjectSetToken.getDefaultPositionRealUnit(setup.wbtc.address);

          // expect(newDaiPositionUnits).to.equal(expectedDaiPositionUnits);  // difference of 4 wei
          // expect(newUniPositionUnits).to.equal(expectedUniPositionUnits);

          expect(newDaiPositionUnits).to.gt(daiPositionUnits);
          expect(newUniPositionUnits).to.gt(uniPositionUnits);
          expect(newWbtcPositionUnits).to.equal(ZERO);   // cause this is sold completely
        });

        describe("when targets is not raised", async () => {
          it("should revert with Target already met", async () => {
            await sellWbtcForWeth();
            await buyUniAndDaiUsingWeth();
            await expect(subject()).to.be.revertedWith("Target already met");
          });
        });

        describe("when all targets have not been met", async () => {
          it("should revert", async () => {
            await indexModule.connect(owner.wallet).updateRaiseTargetPercentage(subjectSetToken.address, subjectRaiseTargetPercentage);
            await sellWbtcForWeth();
            await expect(subject()).to.be.revertedWith("Targets must be met and ETH remaining in order to raise target");
          });
        });

        describe("when set has weth as component", async () => {
          before(async () => {
            subjectSetToken = indexWithWeth;
            oldTargetUnits = [ether(100), ZERO, ether(175), ether(0.434782609)];  // 10$ of WETH should be extra per SetToken
          });

          it("should raise asset targets and allow trading", async () => {

            const daiPositionUnits = await subjectSetToken.getDefaultPositionRealUnit(setup.dai.address);
            const uniPositionUnits = await subjectSetToken.getDefaultPositionRealUnit(uniswapSetup.uni.address);

            await sellWbtcForWeth();
            await buyUniAndDaiUsingWeth();

            await indexModule.connect(owner.wallet).updateRaiseTargetPercentage(subjectSetToken.address, subjectRaiseTargetPercentage);
            await subject();

            // const expectedDaiPositionUnits = daiPositionUnits.mul(ether(1).add(subjectRaiseTargetPercentage).div(ether(1)));
            // const expectedUniPositionUnits = uniPositionUnits.mul(ether(1).add(subjectRaiseTargetPercentage).div(ether(1)));

            const newDaiPositionUnits = await subjectSetToken.getDefaultPositionRealUnit(setup.dai.address);
            const newUniPositionUnits = await subjectSetToken.getDefaultPositionRealUnit(uniswapSetup.uni.address);
            const newWbtcPositionUnits = await subjectSetToken.getDefaultPositionRealUnit(setup.wbtc.address);

            // expect(newDaiPositionUnits).to.equal(expectedDaiPositionUnits);  // difference of 4 wei
            // expect(newUniPositionUnits).to.equal(expectedUniPositionUnits);
            expect(newDaiPositionUnits).to.gt(daiPositionUnits);
            expect(newUniPositionUnits).to.gt(uniPositionUnits);
            expect(newWbtcPositionUnits).to.equal(ZERO);   // cause this is sold completely
          });

          describe("when targets is not raised", async () => {
            it("should revert with Target already met", async () => {
              await sellWbtcForWeth();
              await buyUniAndDaiUsingWeth();
              await expect(subject()).to.be.revertedWith("Target already met");
            });
          });

          describe("when weth unit is below target unit", async () => {
            before(async () => {
              oldTargetUnits = [ether(100), ZERO, ether(175), ether(0.8)];
            });

            after(async () => {
              oldTargetUnits = [ether(100), ZERO, ether(175), ether(0.434782609)];
            });

            it("should revert", async () => {
              await sellWbtcForWeth();
              await buyUniAndDaiUsingWeth();
              await indexModule.connect(owner.wallet).updateRaiseTargetPercentage(subjectSetToken.address, subjectRaiseTargetPercentage);
              await expect(subject()).to.be.revertedWith("Targets must be met and ETH remaining in order to raise target");
            });
          });
        });
      });
    });

    describe("#updateTraderStatus", async () => {
      let traders: Address[];
      let statuses: boolean[];
      let trader1: Account;
      let trader2: Account;

      before(async () => {
        subjectSetToken = index;
        const accounts = await getAccounts();
        trader1 = accounts[accounts.length - 1];
        trader2 = accounts[accounts.length - 2];
        traders = [trader1.address, trader2.address];
        statuses = [true, false];
      });

      async function subject(): Promise<ContractTransaction> {
        await indexModule.connect(owner.wallet).updateTraderStatus(subjectSetToken.address, traders, statuses);

        newComponents = [];
        oldTargetUnits = [ether("60.869565780223716593"), bitcoin(.02), ether(50)];
        newTargetUnits = [];
        issueAmount = ether("20.000000000000000001");
        await setup.approveAndIssueSetToken(subjectSetToken, issueAmount);
        await indexModule.startRebalance(subjectSetToken.address, newComponents, newTargetUnits, oldTargetUnits, await index.positionMultiplier());
        return await indexModule.connect(subjectCaller.wallet).trade(subjectSetToken.address, setup.dai.address, ZERO);
      }

      describe("when approved trader calls trade", async () => {
        before(async () => {
          subjectCaller = trader1;
        });

        it("should allow trading", async () => {
          await subject();
        });
      });

      describe("when not approved trader calls trade", async () => {
        before(async () => {
          subjectCaller = trader2;
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("Address not permitted to trade");
        });
      });

      describe("when traders and statuses arrays do not have same length", async () => {
        before(async () => {
          statuses = [true];
        });

        after(async () => {
          statuses = [true, false];
        });

        it("should revert", async () => {
          expect(subject()).to.be.revertedWith("Array length mismatch");
        });
      });

      describe("when traders array length == 0", async () => {
        before(async () => {
          traders = [];
          statuses = [];
        });

        after(async () => {
          traders = [trader1.address, trader2.address];
          statuses = [true, false];
        });

        it("should revert", async () => {
          expect(subject()).to.be.revertedWith("Array length must be > 0");
        });
      });

      describe("when traders array has duplicate address", async () => {
        before(async () => {
          traders = [trader1.address, trader2.address, trader1.address];
          statuses = [true, false, true];
        });

        after(async () => {
          traders = [trader1.address, trader2.address];
          statuses = [true, false];
        });

        it("should revert", async () => {
          expect(subject()).to.be.revertedWith("Cannot duplicate traders");
        });
      });
    });
  });
});