import "module-alias/register";
import { BigNumber } from "ethers";

import { hexlify, hexZeroPad } from "ethers/lib/utils";
import { Address, StreamingFeeState } from "@utils/types";
import { Account } from "@utils/test/types";
import { ADDRESS_ZERO, MAX_UINT_256, PRECISE_UNIT, THREE, ZERO, ONE_DAY_IN_SECONDS } from "@utils/constants";
import {
  BalancerV1IndexExchangeAdapter,
  ContractCallerMock,
  GeneralIndexModule,
  SetToken,
  UniswapV2IndexExchangeAdapter,
  UniswapV3IndexExchangeAdapter,
  KyberV3IndexExchangeAdapter
} from "@utils/contracts";
import DeployHelper from "@utils/deploys";
import {
  bitcoin,
  ether,
  preciseDiv,
  preciseMul,
  preciseMulCeil,
  usdc
} from "@utils/index";
import {
  cacheBeforeEach,
  increaseTimeAsync,
  getAccounts,
  getBalancerFixture,
  getLastBlockTimestamp,
  getKyberV3DMMFixture,
  getRandomAccount,
  getRandomAddress,
  getSystemFixture,
  getUniswapFixture,
  getUniswapV3Fixture,
  getWaffleExpect
} from "@utils/test/index";
import { BalancerFixture, KyberV3DMMFixture, SystemFixture, UniswapFixture, UniswapV3Fixture } from "@utils/fixtures";
import { ContractTransaction } from "ethers";

const expect = getWaffleExpect();

describe("GeneralIndexModule", () => {
  let owner: Account;
  let trader: Account;
  let positionModule: Account;
  let deployer: DeployHelper;
  let setup: SystemFixture;

  let uniswapSetup: UniswapFixture;
  let sushiswapSetup: UniswapFixture;
  let balancerSetup: BalancerFixture;
  let uniswapV3Setup: UniswapV3Fixture;
  let kyberV3Setup: KyberV3DMMFixture;

  let index: SetToken;
  let indexWithWeth: SetToken;
  let indexModule: GeneralIndexModule;

  let balancerAdapterName: string;
  let sushiswapAdapterName: string;
  let uniswapAdapterName: string;
  let uniswapV3AdapterName: string;
  let kyberV3AdapterName: string;

  let balancerExchangeAdapter: BalancerV1IndexExchangeAdapter;
  let sushiswapExchangeAdapter: UniswapV2IndexExchangeAdapter;
  let uniswapExchangeAdapter: UniswapV2IndexExchangeAdapter;
  let uniswapV3ExchangeAdapter: UniswapV3IndexExchangeAdapter;
  let kyberV3ExchangeAdapter: KyberV3IndexExchangeAdapter;

  let indexComponents: Address[];
  let indexUnits: BigNumber[];
  let indexWithWethComponents: Address[];
  let indexWithWethUnits: BigNumber[];

  const ONE_MINUTE_IN_SECONDS: BigNumber = BigNumber.from(60);

  before(async () => {
    [
      owner,
      trader,
      positionModule,
    ] = await getAccounts();

    deployer = new DeployHelper(owner.wallet);
    setup = getSystemFixture(owner.address);
    uniswapSetup = getUniswapFixture(owner.address);
    sushiswapSetup = getUniswapFixture(owner.address);
    balancerSetup = getBalancerFixture(owner.address);
    uniswapV3Setup = getUniswapV3Fixture(owner.address);
    kyberV3Setup = getKyberV3DMMFixture(owner.address);

    await setup.initialize();
    await uniswapSetup.initialize(owner, setup.weth.address, setup.wbtc.address, setup.dai.address);
    await sushiswapSetup.initialize(owner, setup.weth.address, setup.wbtc.address, setup.dai.address);
    await balancerSetup.initialize(owner, setup.weth, setup.wbtc, setup.dai);
    await uniswapV3Setup.initialize(
      owner,
      setup.weth,
      230,
      setup.wbtc,
      9000,
      setup.dai
    );
    await kyberV3Setup.initialize(owner, setup.weth.address, setup.wbtc.address, setup.dai.address);

    indexModule = await deployer.modules.deployGeneralIndexModule(
      setup.controller.address,
      setup.weth.address
    );
    await setup.controller.addModule(indexModule.address);
    await setup.controller.addModule(positionModule.address);

    balancerExchangeAdapter = await deployer.adapters.deployBalancerV1IndexExchangeAdapter(balancerSetup.exchange.address);
    sushiswapExchangeAdapter = await deployer.adapters.deployUniswapV2IndexExchangeAdapter(sushiswapSetup.router.address);
    uniswapExchangeAdapter = await deployer.adapters.deployUniswapV2IndexExchangeAdapter(uniswapSetup.router.address);
    uniswapV3ExchangeAdapter = await deployer.adapters.deployUniswapV3IndexExchangeAdapter(uniswapV3Setup.swapRouter.address);
    kyberV3ExchangeAdapter = await deployer.adapters.deployKyberV3IndexExchangeAdapter(
      kyberV3Setup.dmmRouter.address,
      kyberV3Setup.dmmFactory.address
    );

    balancerAdapterName = "BALANCER";
    sushiswapAdapterName = "SUSHISWAP";
    uniswapAdapterName = "UNISWAP";
    uniswapV3AdapterName = "UNISWAPV3";
    kyberV3AdapterName = "KYBERV3";


    await setup.integrationRegistry.batchAddIntegration(
      [indexModule.address, indexModule.address, indexModule.address, indexModule.address, indexModule.address],
      [balancerAdapterName, sushiswapAdapterName, uniswapAdapterName, uniswapV3AdapterName, kyberV3AdapterName],
      [
        balancerExchangeAdapter.address,
        sushiswapExchangeAdapter.address,
        uniswapExchangeAdapter.address,
        uniswapV3ExchangeAdapter.address,
        kyberV3ExchangeAdapter.address,
      ]
    );
  });

  cacheBeforeEach(async () => {
    indexComponents = [uniswapSetup.uni.address, setup.wbtc.address, setup.dai.address];
    indexUnits = [ether(86.9565217), bitcoin(.01111111), ether(100)];
    index = await setup.createSetToken(
      indexComponents,
      indexUnits,               // $100 of each
      [setup.issuanceModule.address, setup.streamingFeeModule.address, indexModule.address, positionModule.address],
    );

    const feeSettings = {
      feeRecipient: owner.address,
      maxStreamingFeePercentage: ether(.1),
      streamingFeePercentage: ether(.01),
      lastStreamingFeeTimestamp: ZERO,
    } as StreamingFeeState;

    await setup.streamingFeeModule.initialize(index.address, feeSettings);
    await setup.issuanceModule.initialize(index.address, ADDRESS_ZERO);
    await index.connect(positionModule.wallet).initializeModule();

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

    await setup.weth.connect(owner.wallet).approve(uniswapSetup.router.address, ether(1000));
    await uniswapSetup.uni.connect(owner.wallet).approve(uniswapSetup.router.address, ether(200000));
    await uniswapSetup.router.connect(owner.wallet).addLiquidity(
      setup.weth.address,
      uniswapSetup.uni.address,
      ether(1000),
      ether(200000),
      ether(999),
      ether(199000),
      owner.address,
      MAX_UINT_256
    );

    await setup.weth.connect(owner.wallet).approve(sushiswapSetup.router.address, ether(1000));
    await setup.wbtc.connect(owner.wallet).approve(sushiswapSetup.router.address, bitcoin(26));
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

    await setup.weth.connect(owner.wallet).approve(uniswapV3Setup.nftPositionManager.address, ether(1000));
    await setup.wbtc.connect(owner.wallet).approve(uniswapV3Setup.nftPositionManager.address, bitcoin(26));
    await uniswapV3Setup.addLiquidityWide(
      setup.weth,
      setup.wbtc,
      3000,
      ether(1000),
      bitcoin(26),
      owner.address
    );

    await setup.weth.connect(owner.wallet).approve(uniswapV3Setup.nftPositionManager.address, ether(100));
    await setup.dai.connect(owner.wallet).approve(uniswapV3Setup.nftPositionManager.address, ether(23000));
    await uniswapV3Setup.addLiquidityWide(
      setup.weth,
      setup.dai,
      3000,
      ether(100),
      ether(23000),
      owner.address
    );

    await setup.weth.connect(owner.wallet).approve(kyberV3Setup.dmmRouter.address, ether(1000));
    await setup.wbtc.connect(owner.wallet).approve(kyberV3Setup.dmmRouter.address, bitcoin(26));
    await kyberV3Setup.dmmRouter.connect(owner.wallet).addLiquidity(
      setup.weth.address,
      setup.wbtc.address,
      kyberV3Setup.wethWbtcPool.address,
      ether(1000),
      bitcoin(26),
      ether(999),
      bitcoin(25.3),
      [0, MAX_UINT_256],
      owner.address,
      MAX_UINT_256
    );

    await setup.weth.connect(owner.wallet).approve(kyberV3Setup.dmmRouter.address, ether(100));
    await setup.dai.connect(owner.wallet).approve(kyberV3Setup.dmmRouter.address, ether(23000));
    await kyberV3Setup.dmmRouter.connect(owner.wallet).addLiquidity(
      setup.weth.address,
      setup.dai.address,
      kyberV3Setup.wethDaiPool.address,
      ether(100),
      ether(23000),
      ether(99),
      ether(22950),
      [0, MAX_UINT_256],
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

    describe("when there are external positions for a component", async () => {
      beforeEach(async () => {
        await subjectSetToken.connect(positionModule.wallet).addExternalPositionModule(
          indexComponents[0],
          positionModule.address
        );
      });

      afterEach(async () => {
        await subjectSetToken.connect(positionModule.wallet).removeExternalPositionModule(
          indexComponents[0],
          positionModule.address
        );
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("External positions not allowed");
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
      await indexModule.setTraderStatus(setToken.address, [trader.address], [true]);
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
      let subjectNewComponents: Address[];
      let subjectNewTargetUnits: BigNumber[];
      let subjectOldTargetUnits: BigNumber[];

      beforeEach(async () => {
        subjectSetToken = index;
        subjectCaller = owner;

        subjectNewComponents = [sushiswapSetup.uni.address];
        subjectNewTargetUnits = [ether(50)];
        subjectOldTargetUnits = [ether("60.869565780223716593"), bitcoin(.02), ether(50)];
      });

      async function subject(): Promise<ContractTransaction> {
        return await indexModule.connect(subjectCaller.wallet).startRebalance(
          subjectSetToken.address,
          subjectNewComponents,
          subjectNewTargetUnits,
          subjectOldTargetUnits,
          await subjectSetToken.positionMultiplier()
        );
      }

      it("should set target units and rebalance info correctly", async () => {
        await subject();

        const currentComponents = await subjectSetToken.getComponents();
        const aggregateComponents = [...currentComponents, ...subjectNewComponents];
        const aggregateTargetUnits = [...subjectOldTargetUnits, ...subjectNewTargetUnits];

        for (let i = 0; i < aggregateComponents.length; i++) {
          const targetUnit = (await indexModule.executionInfo(subjectSetToken.address, aggregateComponents[i])).targetUnit;
          const exepectedTargetUnit = aggregateTargetUnits[i];
          expect(targetUnit).to.be.eq(exepectedTargetUnit);
        }

        const rebalanceComponents = await indexModule.getRebalanceComponents(subjectSetToken.address);
        const expectedRebalanceComponents = aggregateComponents;
        for (let i = 0; i < rebalanceComponents.length; i++) {
          expect(rebalanceComponents[i]).to.be.eq(expectedRebalanceComponents[i]);
        }

        const positionMultiplier = (await indexModule.rebalanceInfo(subjectSetToken.address)).positionMultiplier;
        const expectedPositionMultiplier = await subjectSetToken.positionMultiplier();

        expect(positionMultiplier).to.be.eq(expectedPositionMultiplier);
      });

      it("emits the correct RebalanceStarted event", async () => {
        const currentComponents = await subjectSetToken.getComponents();
        const expectedAggregateComponents = [...currentComponents, ...subjectNewComponents];
        const expectedAggregateTargetUnits = [...subjectOldTargetUnits, ...subjectNewTargetUnits];
        const expectedPositionMultiplier = await subjectSetToken.positionMultiplier();

        await expect(subject()).to.emit(indexModule, "RebalanceStarted").withArgs(
          subjectSetToken.address,
          expectedAggregateComponents,
          expectedAggregateTargetUnits,
          expectedPositionMultiplier
        );
      });

      describe("newComponents and newComponentsTargetUnits are not of same length", async () => {
        beforeEach(async () => {
          subjectNewTargetUnits = [];
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("Array length mismatch");
        });
      });

      describe("when missing target units for old comoponents", async () => {
        beforeEach(async () => {
          subjectOldTargetUnits = [ether("60.869565780223716593"), bitcoin(.02)];
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("Old Components targets missing");
        });
      });

      describe("when newComponents contains an old component", async () => {
        beforeEach(async () => {
          subjectNewComponents = [sushiswapSetup.uni.address, uniswapSetup.uni.address];
          subjectNewTargetUnits = [ether(50), ether(50)];
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("Cannot duplicate components");
        });
      });

      describe("when there are external positions for a component", async () => {
        beforeEach(async () => {
          await subjectSetToken.connect(positionModule.wallet).addExternalPositionModule(
            subjectNewComponents[0],
            positionModule.address
          );
        });

        afterEach(async () => {
          await subjectSetToken.connect(positionModule.wallet).removeExternalPositionModule(
            subjectNewComponents[0],
            positionModule.address
          );
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("External positions not allowed");
        });
      });
    });

    describe("#setCoolOffPeriods", async () => {
      let subjectComponents: Address[];
      let subjectCoolOffPeriods: BigNumber[];

      beforeEach(async () => {
        subjectSetToken = index;
        subjectCaller = owner;
        subjectComponents = [uniswapSetup.uni.address, setup.wbtc.address];
        subjectCoolOffPeriods = [ONE_MINUTE_IN_SECONDS.mul(3), ONE_MINUTE_IN_SECONDS];
      });

      async function subject(): Promise<ContractTransaction> {
        return await indexModule.connect(subjectCaller.wallet).setCoolOffPeriods(
          subjectSetToken.address,
          subjectComponents,
          subjectCoolOffPeriods
        );
      }

      it("should set values correctly", async () => {
        await subject();

        for (let i = 0; i < subjectComponents.length; i++) {
          const coolOffPeriod = (await indexModule.executionInfo(subjectSetToken.address, subjectComponents[i])).coolOffPeriod;
          const exepctedCoolOffPeriod = subjectCoolOffPeriods[i];
          expect(coolOffPeriod).to.be.eq(exepctedCoolOffPeriod);
        }
      });

      describe("when array lengths are not same", async () => {
        beforeEach(async () => {
          subjectCoolOffPeriods = [ONE_MINUTE_IN_SECONDS.mul(3), ONE_MINUTE_IN_SECONDS, ONE_MINUTE_IN_SECONDS.mul(2)];
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("Array length mismatch");
        });
      });

      describe("when component array has duplilcate values", async () => {
        beforeEach(async () => {
          subjectComponents = [uniswapSetup.uni.address, setup.wbtc.address, uniswapSetup.uni.address];
          subjectCoolOffPeriods = [ONE_MINUTE_IN_SECONDS.mul(3), ONE_MINUTE_IN_SECONDS, ONE_MINUTE_IN_SECONDS.mul(3)];
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("Cannot duplicate addresses");
        });
      });

      describe("when array length is 0", async () => {
        beforeEach(async () => {
          subjectComponents = [];
          subjectCoolOffPeriods = [];
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("Array length must be > 0");
        });
      });
    });

    describe("#setTradeMaximums", async () => {
      let subjectComponents: Address[];
      let subjectTradeMaximums: BigNumber[];

      beforeEach(async () => {
        subjectSetToken = index;
        subjectCaller = owner;
        subjectComponents = [uniswapSetup.uni.address, setup.wbtc.address];
        subjectTradeMaximums = [ether(800), bitcoin(.1)];
      });

      async function subject(): Promise<ContractTransaction> {
        return await indexModule.connect(subjectCaller.wallet).setTradeMaximums(
          subjectSetToken.address,
          subjectComponents,
          subjectTradeMaximums
        );
      }

      it("should set values correctly", async () => {
        await subject();

        for (let i = 0; i < subjectComponents.length; i++) {
          const maxSize = (await indexModule.executionInfo(subjectSetToken.address, subjectComponents[i])).maxSize;
          const exepctedMaxSize = subjectTradeMaximums[i];
          expect(maxSize).to.be.eq(exepctedMaxSize);
        }
      });
    });

    describe("#setExchanges", async () => {
      let subjectComponents: Address[];
      let subjectExchanges: string[];

      beforeEach(async () => {
        subjectSetToken = index;
        subjectCaller = owner;
        subjectComponents = [uniswapSetup.uni.address, setup.wbtc.address];
        subjectExchanges = [uniswapAdapterName, sushiswapAdapterName];
      });

      async function subject(): Promise<ContractTransaction> {
        return await indexModule.connect(subjectCaller.wallet).setExchanges(subjectSetToken.address, subjectComponents, subjectExchanges);
      }

      it("should set values correctly", async () => {
        await subject();

        for (let i = 0; i < subjectComponents.length; i++) {
          const exchangeName = (await indexModule.executionInfo(subjectSetToken.address, subjectComponents[i])).exchangeName;
          const expectedExchangeName = subjectExchanges[i];
          expect(exchangeName).to.be.eq(expectedExchangeName);
        }
      });

      describe("when array lengths are not same", async () => {
        beforeEach(async () => {
          subjectExchanges = [uniswapAdapterName, sushiswapAdapterName, balancerAdapterName];
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("Array length mismatch");
        });
      });

      describe("when component array has duplilcate values", async () => {
        beforeEach(async () => {
          subjectComponents = [uniswapSetup.uni.address, setup.wbtc.address, uniswapSetup.uni.address];
          subjectExchanges = [uniswapAdapterName, sushiswapAdapterName, uniswapAdapterName];
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("Cannot duplicate addresses");
        });
      });

      describe("when component array has duplilcate values", async () => {
        beforeEach(async () => {
          subjectComponents = [];
          subjectExchanges = [];
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("Array length must be > 0");
        });
      });

      describe("when exchange is not a valid integration", async () => {
        beforeEach(async () => {
          await setup.integrationRegistry.removeIntegration(indexModule.address, sushiswapAdapterName);
        });

        afterEach(async () => {
          await setup.integrationRegistry.addIntegration(
            indexModule.address,
            sushiswapAdapterName,
            sushiswapExchangeAdapter.address
          );
        });

        describe("for component other than weth", async () => {
          it("should revert", async () => {
            await expect(subject()).to.be.revertedWith("Unrecognized exchange name");
          });
        });

        describe("for weth", async () => {
          beforeEach(async () => {
            subjectComponents = [sushiswapSetup.uni.address, setup.weth.address];
          });

          it("should not revert", async () => {
            await expect(subject()).to.not.be.reverted;
          });
        });
      });
    });

    describe("#setExchangeData", async () => {
      let uniBytes: string;
      let wbtcBytes: string;

      let subjectComponents: Address[];
      let subjectExchangeData: string[];

      beforeEach(async () => {
        uniBytes = "0x";
        wbtcBytes = "0x7890";

        subjectSetToken = index;
        subjectCaller = owner;
        subjectComponents = [uniswapSetup.uni.address, setup.wbtc.address];
        subjectExchangeData = [uniBytes, wbtcBytes];
      });

      async function subject(): Promise<ContractTransaction> {
        return await indexModule.connect(subjectCaller.wallet).setExchangeData(subjectSetToken.address, subjectComponents, subjectExchangeData);
      }

      it("should set values correctly", async () => {
        await subject();

        for (let i = 0; i < subjectComponents.length; i++) {
          const exchangeData = (await indexModule.executionInfo(subjectSetToken.address, subjectComponents[i])).exchangeData;
          const expectedExchangeData = subjectExchangeData[i];
          expect(exchangeData).to.be.eq(expectedExchangeData);
        }
      });

      describe("when array lengths are not same", async () => {
        beforeEach(async () => {
          subjectExchangeData = ["0x", "0x523454", "0x7890"];
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("Array length mismatch");
        });
      });

      describe("when component array has duplicate values", async () => {
        beforeEach(async () => {
          subjectComponents = [uniswapSetup.uni.address, setup.wbtc.address, uniswapSetup.uni.address];
          subjectExchangeData = ["0x", "0x523454", "0x7890"];
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("Cannot duplicate addresses");
        });
      });

      describe("when component array has no values", async () => {
        beforeEach(async () => {
          subjectComponents = [];
          subjectExchangeData = [];
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("Array length must be > 0");
        });
      });
    });

    describe("#trade", async () => {
      let subjectComponent: Address;
      let subjectIncreaseTime: BigNumber;
      let subjectEthQuantityLimit: BigNumber;

      let expectedOut: BigNumber;

      before(async () => {
        // current units [ether(86.9565217), bitcoin(.01111111), ether(100), ZERO]
        newComponents = [];
        oldTargetUnits = [ether("60.869565780223716593"), bitcoin(.02), ether(50)];
        newTargetUnits = [];
        issueAmount = ether("20.000000000000000001");
      });

      const startRebalance = async () => {
        await setup.approveAndIssueSetToken(subjectSetToken, issueAmount);
        await indexModule.startRebalance(
          subjectSetToken.address,
          newComponents,
          newTargetUnits,
          oldTargetUnits,
          await index.positionMultiplier()
        );
      };

      const initializeSubjectVariables = () => {
        subjectSetToken = index;
        subjectCaller = trader;
        subjectComponent = setup.dai.address;
        subjectIncreaseTime = ONE_MINUTE_IN_SECONDS.mul(5);
        subjectEthQuantityLimit = ZERO;
      };

      async function subject(): Promise<ContractTransaction> {
        await increaseTimeAsync(subjectIncreaseTime);
        return await indexModule.connect(subjectCaller.wallet).trade(
          subjectSetToken.address,
          subjectComponent,
          subjectEthQuantityLimit
        );
      }

      describe("with default target units", async () => {
        beforeEach(async () => {
          initializeSubjectVariables();

          expectedOut = (await balancerSetup.exchange.viewSplitExactIn(
            setup.dai.address,
            setup.weth.address,
            ether(1000),
            THREE
          )).totalOutput;
          subjectEthQuantityLimit = expectedOut;
        });
        cacheBeforeEach(startRebalance);

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
            feePercentage = ether(0.005);
            setup.controller = setup.controller.connect(owner.wallet);
            await setup.controller.addFee(
              indexModule.address,
              ZERO, // Fee type on trade function denoted as 0
              feePercentage // Set fee to 5 bps
            );
          });

          it("the position units and lastTradeTimestamp should be set as expected, sell using Balancer", async () => {
            const currentDaiAmount = await setup.dai.balanceOf(subjectSetToken.address);
            const currentWethAmount = await setup.weth.balanceOf(subjectSetToken.address);
            const totalSupply = await subjectSetToken.totalSupply();

            await subject();

            const lastBlockTimestamp = await getLastBlockTimestamp();

            const protocolFee = expectedOut.mul(feePercentage).div(ether(1));
            const expectedWethPositionUnits = preciseDiv(currentWethAmount.add(expectedOut).sub(protocolFee), totalSupply);
            const expectedDaiPositionUnits = preciseDiv(currentDaiAmount.sub(ether(1000)), totalSupply);

            const wethPositionUnits = await subjectSetToken.getDefaultPositionRealUnit(setup.weth.address);
            const daiPositionUnits = await subjectSetToken.getDefaultPositionRealUnit(setup.dai.address);

            const lastTrade = (await indexModule.executionInfo(subjectSetToken.address, setup.dai.address)).lastTradeTimestamp;

            expect(wethPositionUnits).to.eq(expectedWethPositionUnits);
            expect(daiPositionUnits).to.eq(expectedDaiPositionUnits);
            expect(lastTrade).to.eq(lastBlockTimestamp);
          });

          it("the fees should be received by the fee recipient", async () => {
            const feeRecipient = await setup.controller.feeRecipient();
            const beforeWethBalance = await setup.weth.balanceOf(feeRecipient);

            await subject();

            const wethBalance = await setup.weth.balanceOf(feeRecipient);

            const protocolFee = expectedOut.mul(feePercentage).div(ether(1));
            const expectedWethBalance = beforeWethBalance.add(protocolFee);

            expect(wethBalance).to.eq(expectedWethBalance);
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

          describe("and the buy component does not meet the max trade size", async () => {
            beforeEach(async () => {
              await indexModule.startRebalance(
                subjectSetToken.address,
                [],
                [],
                [ether("60.869565780223716593"), bitcoin(.016), ether(50)],
                await index.positionMultiplier()
              );

              await subject();

              subjectComponent = setup.wbtc.address;
              subjectEthQuantityLimit = MAX_UINT_256;
            });

            it("position units should match the target", async () => {
              const totalSupply = await subjectSetToken.totalSupply();
              const currentWbtcUnit = await subjectSetToken.getDefaultPositionRealUnit(setup.wbtc.address);
              const expectedWbtcSize = preciseDiv(
                preciseMulCeil(bitcoin(.016), totalSupply).sub(preciseMul(currentWbtcUnit, totalSupply)),
                PRECISE_UNIT.sub(feePercentage)
              );

              const [expectedIn, expectedOut] = await sushiswapSetup.router.getAmountsIn(
                expectedWbtcSize,
                [setup.weth.address, setup.wbtc.address]
              );
              const currentWbtcAmount = await setup.wbtc.balanceOf(subjectSetToken.address);
              const currentWethAmount = await setup.weth.balanceOf(subjectSetToken.address);

              const wethUnit = await subjectSetToken.getDefaultPositionRealUnit(setup.weth.address);
              const wbtcUnit = await subjectSetToken.getDefaultPositionRealUnit(setup.wbtc.address);

              await subject();

              const wbtcExcess = currentWbtcAmount.sub(preciseMul(totalSupply, wbtcUnit));
              const wethExcess = currentWethAmount.sub(preciseMul(totalSupply, wethUnit));

              const expectedWethPositionUnits = preciseDiv(currentWethAmount.sub(expectedIn).sub(wethExcess), totalSupply);
              const expectedWbtcPositionUnits = preciseDiv(
                currentWbtcAmount.add(preciseMulCeil(expectedOut, PRECISE_UNIT.sub(feePercentage))).sub(wbtcExcess),
                totalSupply
              );

              const wethPositionUnits = await subjectSetToken.getDefaultPositionRealUnit(setup.weth.address);
              const wbtcPositionUnits = await subjectSetToken.getDefaultPositionRealUnit(setup.wbtc.address);

              expect(wbtcPositionUnits).to.eq(expectedWbtcPositionUnits);
              expect(wethPositionUnits).to.eq(expectedWethPositionUnits);
            });
          });
        });

        describe("when the component being sold doesn't meet the max trade size", async () => {
          beforeEach(async () => {
            subjectComponent = uniswapSetup.uni.address;
            subjectEthQuantityLimit = ZERO;
          });

          it("the trade gets rounded down to meet the target", async () => {
            const totalSupply = await subjectSetToken.totalSupply();
            const currentUniUnit = await subjectSetToken.getDefaultPositionRealUnit(uniswapSetup.uni.address);
            const expectedUniSize = preciseMul(currentUniUnit.sub(ether("60.869565780223716593")), totalSupply);

            const [expectedIn, expectedOut] = await uniswapSetup.router.getAmountsOut(
              expectedUniSize,
              [uniswapSetup.uni.address, setup.weth.address]
            );

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
          beforeEach(async () => {
            await subject();  // sell DAI for ETH on Balancer, as we would need ETH to buy WBTC on Sushiswap

            subjectComponent = setup.wbtc.address;
            subjectEthQuantityLimit = MAX_UINT_256;
          });

          it("the position units and lastTradeTimestamp should be set as expected", async () => {
            const [expectedIn, expectedOut] = await sushiswapSetup.router.getAmountsIn(
              bitcoin(.1),
              [setup.weth.address, setup.wbtc.address]
            );
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
            const [expectedIn ] = await sushiswapSetup.router.getAmountsIn(
              bitcoin(.1),
              [setup.weth.address, setup.wbtc.address]
            );
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

        describe("when exchange is Uniswap V3", async () => {
          describe("when component is beling sold using UniswapV3", async () => {
            beforeEach(async () => {
              await indexModule.setExchanges(subjectSetToken.address, [setup.dai.address], [uniswapV3AdapterName]);
              await indexModule.setExchangeData(subjectSetToken.address, [setup.dai.address], [hexZeroPad(hexlify(3000), 3)]);

              expectedOut = await uniswapV3Setup.quoter.callStatic.quoteExactInputSingle(
                setup.dai.address,
                setup.weth.address,
                3000,
                ether(1000),
                0
              );

              subjectEthQuantityLimit = expectedOut;
            });

            afterEach(async () => {
              await indexModule.setExchanges(subjectSetToken.address, [setup.dai.address], [balancerAdapterName]);
            });

            it("the position units and lastTradeTimestamp should be set as expected", async () => {
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
                uniswapV3ExchangeAdapter.address,
                trader.address,
                ether(1000),
                expectedOut,
                ZERO
              );
            });
          });

          describe("when component is being bought using UniswapV3", async () => {
            beforeEach(async () => {
              await subject();  // sell DAI for ETH on Balancer, as we would need ETH to buy WBTC on UniswapV3

              await indexModule.setExchanges(subjectSetToken.address, [setup.wbtc.address], [uniswapV3AdapterName]);
              await indexModule.setExchangeData(subjectSetToken.address, [setup.wbtc.address], [hexZeroPad(hexlify(3000), 3)]);

              subjectComponent = setup.wbtc.address;
              subjectEthQuantityLimit = MAX_UINT_256;
            });

            afterEach(async () => {
              await indexModule.setExchanges(subjectSetToken.address, [setup.wbtc.address], [sushiswapAdapterName]);
            });

            it("the position units and lastTradeTimestamp should be set as expected", async () => {
              const amountOut = bitcoin(0.1);
              const expectedIn = await uniswapV3Setup.quoter.callStatic.quoteExactOutputSingle(
                setup.weth.address,
                setup.wbtc.address,
                3000,
                amountOut,
                0
              );

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
              const expectedWbtcPositionUnits = preciseDiv(currentWbtcAmount.add(amountOut).sub(wbtcExcess), totalSupply);

              const wethPositionUnits = await subjectSetToken.getDefaultPositionRealUnit(setup.weth.address);
              const wbtcPositionUnits = await subjectSetToken.getDefaultPositionRealUnit(setup.wbtc.address);
              const lastTrade = (await indexModule.executionInfo(subjectSetToken.address, setup.wbtc.address)).lastTradeTimestamp;

              expect(wbtcPositionUnits).to.eq(expectedWbtcPositionUnits);
              expect(wethPositionUnits).to.eq(expectedWethPositionUnits);
              expect(lastTrade).to.eq(lastBlockTimestamp);
            });
          });
        });

        describe("when exchange is Kyber V3 DMM", async () => {
          describe("when component is beling sold using Kyber V3 DMM exchange", async () => {
            beforeEach(async () => {
              await indexModule.setExchanges(subjectSetToken.address, [setup.dai.address], [kyberV3AdapterName]);
              await indexModule.setExchangeData(subjectSetToken.address, [setup.dai.address], [kyberV3Setup.wethDaiPool.address.toLowerCase()]);

              [, expectedOut] = await kyberV3Setup.dmmRouter.getAmountsOut(
                ether(1000),
                [kyberV3Setup.wethDaiPool.address],
                [setup.dai.address, setup.weth.address]
              );

              subjectEthQuantityLimit = expectedOut;
            });

            afterEach(async () => {
              await indexModule.setExchanges(subjectSetToken.address, [setup.dai.address], [balancerAdapterName]);
            });

            it("the position units and lastTradeTimestamp should be set as expected", async () => {
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
                kyberV3ExchangeAdapter.address,
                trader.address,
                ether(1000),
                expectedOut,
                ZERO
              );
            });
          });

          describe("when component is being bought using KyberV3", async () => {
            beforeEach(async () => {
              await subject();  // sell DAI for ETH on Balancer, as we would need ETH to buy WBTC on KyberV3

              await indexModule.setExchanges(subjectSetToken.address, [setup.wbtc.address], [kyberV3AdapterName]);
              await indexModule.setExchangeData(subjectSetToken.address, [setup.wbtc.address], [kyberV3Setup.wethWbtcPool.address]);

              subjectComponent = setup.wbtc.address;
              subjectEthQuantityLimit = MAX_UINT_256;
            });

            afterEach(async () => {
              await indexModule.setExchanges(subjectSetToken.address, [setup.wbtc.address], [sushiswapAdapterName]);
            });

            it("the position units and lastTradeTimestamp should be set as expected", async () => {
              const amountOut = bitcoin(0.1);
              const [expectedIn ] = await kyberV3Setup.dmmRouter.getAmountsIn(
                amountOut,
                [kyberV3Setup.wethWbtcPool.address],
                [setup.weth.address, setup.wbtc.address]
              );

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
              const expectedWbtcPositionUnits = preciseDiv(currentWbtcAmount.add(amountOut).sub(wbtcExcess), totalSupply);

              const wethPositionUnits = await subjectSetToken.getDefaultPositionRealUnit(setup.weth.address);
              const wbtcPositionUnits = await subjectSetToken.getDefaultPositionRealUnit(setup.wbtc.address);
              const lastTrade = (await indexModule.executionInfo(subjectSetToken.address, setup.wbtc.address)).lastTradeTimestamp;

              expect(wbtcPositionUnits).to.eq(expectedWbtcPositionUnits);
              expect(wethPositionUnits).to.eq(expectedWethPositionUnits);
              expect(lastTrade).to.eq(lastBlockTimestamp);
            });
          });
        });

        describe("when exchange doesn't return minimum receive eth amount, while selling component", async () => {
          beforeEach(async () => {
            expectedOut = (await balancerSetup.exchange.viewSplitExactIn(
              setup.dai.address,
              setup.weth.address,
              ether(1000),
              THREE
            )).totalOutput;
            subjectEthQuantityLimit = expectedOut.mul(2);
          });

          it("should revert", async () => {
            await expect(subject()).to.be.reverted;
          });
        });

        describe("when exchange takes more than maximum input eth amount, while buying component", async () => {
          beforeEach(async () => {
            subjectComponent = setup.wbtc.address;
            const [expectedIn ] = await sushiswapSetup.router.getAmountsOut(
              bitcoin(.1),
              [setup.wbtc.address, setup.weth.address]
            );
            subjectEthQuantityLimit = expectedIn.div(2);
          });

          it("should revert", async () => {
            await expect(subject()).to.be.reverted;
          });
        });

        describe("when anyoneTrade is true and a random address calls", async () => {
          beforeEach(async () => {
            await indexModule.setAnyoneTrade(subjectSetToken.address, true);
            subjectCaller = await getRandomAccount();
          });

          it("the trade should not revert", async () => {
            await expect(subject()).to.not.be.reverted;
          });
        });

        describe("when not enough time has elapsed between trades", async () => {
          beforeEach(async () => {
            await subject();
            subjectIncreaseTime = ZERO;
          });

          it("should revert", async () => {
            await expect(subject()).to.be.revertedWith("Component cool off in progress");
          });
        });

        describe("when exchange adapter has been removed from integration registry", async () => {
          beforeEach(async () => {
            await indexModule.setExchanges(subjectSetToken.address, [subjectComponent], [balancerAdapterName]);
            await setup.integrationRegistry.removeIntegration(indexModule.address, balancerAdapterName);
          });

          afterEach(async () => {
            await setup.integrationRegistry.addIntegration(
              indexModule.address,
              balancerAdapterName,
              balancerExchangeAdapter.address
            );
          });

          it("the trade reverts", async () => {
            await expect(subject()).to.be.revertedWith("Must be valid adapter");
          });
        });

        describe("when the passed component is not included in the rebalance", async () => {
          beforeEach(async () => {
            subjectComponent = sushiswapSetup.uni.address;
          });

          it("should revert", async () => {
            await expect(subject()).to.be.revertedWith("Component not part of rebalance");
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

        describe("when the component is weth", async () => {
          beforeEach(async () => {
            subjectComponent = setup.weth.address;
          });

          it("should revert", async () => {
            expect(subject()).to.be.revertedWith("Can not explicitly trade WETH");
          });
        });

        describe("when there are external positions for a component", async () => {
          beforeEach(async () => {
            await subjectSetToken.connect(positionModule.wallet).addExternalPositionModule(
              subjectComponent,
              positionModule.address
            );
          });

          afterEach(async () => {
            await subjectSetToken.connect(positionModule.wallet).removeExternalPositionModule(
              subjectComponent,
              positionModule.address
            );
          });

          it("should revert", async () => {
            await expect(subject()).to.be.revertedWith("External positions not allowed");
          });
        });

        describe("when caller is a contract", async () => {
          let subjectTarget: Address;
          let subjectCallData: string;
          let subjectValue: BigNumber;

          let contractCaller: ContractCallerMock;

          beforeEach(async () => {
            contractCaller = await deployer.mocks.deployContractCallerMock();
            await indexModule.connect(owner.wallet).setTraderStatus(subjectSetToken.address, [contractCaller.address], [true]);

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

          it("should not revert", async () => {
            await expect(subjectContractCaller()).to.not.be.reverted;
          });

          describe("when anyone trade is true", async () => {
            beforeEach(async () => {
              await indexModule.connect(owner.wallet).setAnyoneTrade(subjectSetToken.address, true);
            });

            it("the trader reverts", async () => {
              await expect(subjectContractCaller()).to.be.revertedWith("Caller must be EOA Address");
            });
          });
        });
      });

      describe("with alternative target units", async () => {
        before(async () => {
          oldTargetUnits = [ether(100), ZERO, ether(185)];
        });

        after(async () => {
          oldTargetUnits = [ether(60.869565), bitcoin(.02), ether(50)];
        });

        beforeEach(async () => {
          initializeSubjectVariables();

          expectedOut = (await balancerSetup.exchange.viewSplitExactIn(
            setup.dai.address,
            setup.weth.address,
            ether(1000),
            THREE
          )).totalOutput;
          subjectEthQuantityLimit = expectedOut;
        });
        cacheBeforeEach(startRebalance);

        describe("when the sell happens on Sushiswap", async () => {
          beforeEach(async () => {
            subjectComponent = setup.wbtc.address;
            subjectEthQuantityLimit = ZERO;
          });

          it("the position units and lastTradeTimestamp should be set as expected", async () => {
            const [expectedIn, expectedOut] = await sushiswapSetup.router.getAmountsOut(
              bitcoin(.1),
              [setup.wbtc.address, setup.weth.address]
            );

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
          beforeEach(async () => {
            await increaseTimeAsync(ONE_MINUTE_IN_SECONDS.mul(5));
            await indexModule.connect(trader.wallet).trade(subjectSetToken.address, setup.wbtc.address, ZERO);
            await increaseTimeAsync(ONE_MINUTE_IN_SECONDS.mul(5));
            await indexModule.connect(trader.wallet).trade(subjectSetToken.address, setup.wbtc.address, ZERO);

            subjectComponent = setup.dai.address;
            subjectEthQuantityLimit = MAX_UINT_256;
          });

          it("the position units and lastTradeTimestamp should be set as expected", async () => {
            const expectedIn = (await balancerSetup.exchange.viewSplitExactOut(
              setup.weth.address,
              setup.dai.address,
              ether(1000),
              THREE
            )).totalOutput;
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
      });

      describe("when alternative issue amount", async () => {
        before(async () => {
          issueAmount = ether(20);
        });

        after(async () => {
          issueAmount = ether("20.000000000000000001");
        });

        beforeEach(async () => {
          initializeSubjectVariables();

          expectedOut = (await balancerSetup.exchange.viewSplitExactIn(
            setup.dai.address,
            setup.weth.address,
            ether(1000),
            THREE
          )).totalOutput;
          subjectEthQuantityLimit = expectedOut;
        });
        cacheBeforeEach(startRebalance);

        describe("when fees are accrued and target is met", async () => {
          beforeEach(async () => {
            await increaseTimeAsync(ONE_MINUTE_IN_SECONDS.mul(5));
            await indexModule.connect(trader.wallet).trade(subjectSetToken.address, setup.dai.address, ZERO);

            await setup.streamingFeeModule.accrueFee(subjectSetToken.address);
          });

          it("the trade reverts", async () => {
            const targetUnit = (await indexModule.executionInfo(subjectSetToken.address, setup.dai.address)).targetUnit;
            const currentUnit = await subjectSetToken.getDefaultPositionRealUnit(setup.dai.address);

            expect(targetUnit).to.not.eq(currentUnit);
            await expect(subject()).to.be.revertedWith("Target already met");
          });
        });

        describe("when the target has been met", async () => {

          beforeEach(async () => {
            await increaseTimeAsync(ONE_MINUTE_IN_SECONDS.mul(5));
            await indexModule.connect(trader.wallet).trade(subjectSetToken.address, setup.dai.address, ZERO);
          });

          it("the trade reverts", async () => {
            await expect(subject()).to.be.revertedWith("Target already met");
          });
        });
      });

      describe("when set has weth as component", async () => {
        beforeEach(async () => {
          // current units [ether(86.9565217), bitcoin(.01111111), ether(100), ether(0.434782609), ZERO]
          oldTargetUnits = [ether("60.869565780223716593"), bitcoin(.02), ether(50), ether(0.434782609)];
          issueAmount = ether(20);

          expectedOut = (await balancerSetup.exchange.viewSplitExactIn(
            setup.dai.address,
            setup.weth.address,
            ether(1000),
            THREE
          )).totalOutput;
          subjectEthQuantityLimit = expectedOut;

          initializeSubjectVariables();
          subjectSetToken = indexWithWeth;

          await startRebalance();
        });

        after(async () => {
          // current units [ether(86.9565217), bitcoin(.01111111), ether(100), ZERO]
          oldTargetUnits = [ether("60.869565780223716593"), bitcoin(.02), ether(50)];
          issueAmount = ether("20.000000000000000001");
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
      });

      describe("when adding a new asset", async () => {
        before(async () => {
          oldTargetUnits = [ether(100), ZERO, ether(185)];
          newComponents = [sushiswapSetup.uni.address];
          newTargetUnits = [ether(50)];
        });

        beforeEach(async () => {
          await setup.weth.connect(owner.wallet).approve(sushiswapSetup.router.address, ether(100));
          await sushiswapSetup.uni.connect(owner.wallet).approve(sushiswapSetup.router.address, ether(20000));
          await sushiswapSetup.router.connect(owner.wallet).addLiquidity(
            setup.weth.address,
            sushiswapSetup.uni.address,
            ether(100),
            ether(20000),
            ether(90),
            ether(19000),
            owner.address,
            MAX_UINT_256
          );

          initializeSubjectVariables();
          subjectComponent = sushiswapSetup.uni.address;
          subjectEthQuantityLimit = MAX_UINT_256;

          await startRebalance();

          await increaseTimeAsync(ONE_MINUTE_IN_SECONDS.mul(5));
          await indexModule.connect(trader.wallet).trade(subjectSetToken.address, setup.wbtc.address, ZERO);
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
    });

    describe("#tradeRemainingWETH", async () => {
      let subjectComponent: Address;
      let subjectIncreaseTime: BigNumber;
      let subjectMinComponentReceived: BigNumber;

      before(async () => {
        // current units [ether(86.9565217), bitcoin(.01111111), ether(100)]
        oldTargetUnits = [ether(60.869565), bitcoin(.02), ether(50)];
      });

      const startRebalanceAndTrade = async () => {
        // oldTargetUnits = [ether(60.869565), bitcoin(.02), ether(50)];
        await setup.approveAndIssueSetToken(subjectSetToken, ether(20));
        await indexModule.startRebalance(subjectSetToken.address, [], [], oldTargetUnits, await subjectSetToken.positionMultiplier());

        await increaseTimeAsync(ONE_MINUTE_IN_SECONDS.mul(5));
        await indexModule.connect(trader.wallet).trade(subjectSetToken.address, setup.dai.address, ZERO);
        await indexModule.connect(trader.wallet).trade(subjectSetToken.address, uniswapSetup.uni.address, ZERO);
        await indexModule.connect(trader.wallet).trade(subjectSetToken.address, setup.wbtc.address, MAX_UINT_256);
      };

      const getFixedAmountIn = async (setToken: SetToken, component: Address, considerMaxSize: boolean = false) => {
        const totalSupply = await setToken.totalSupply();
        const componentMaxSize = considerMaxSize ? (await indexModule.executionInfo(setToken.address, component)).maxSize : MAX_UINT_256;
        const currentPositionMultiplier = await setToken.positionMultiplier();
        const positionMultiplier = (await indexModule.rebalanceInfo(setToken.address)).positionMultiplier;

        const currentUnit = await setToken.getDefaultPositionRealUnit(component);
        const targetUnit = (await indexModule.executionInfo(setToken.address, component)).targetUnit;
        const normalizedTargetUnit = targetUnit.mul(currentPositionMultiplier).div(positionMultiplier);

        const currentNotional = preciseMul(totalSupply, currentUnit);
        const targetNotional = preciseMulCeil(totalSupply, normalizedTargetUnit);

        if (targetNotional.lt(currentNotional)) {
          return componentMaxSize.lt(currentNotional.sub(targetNotional)) ? componentMaxSize : currentNotional.sub(targetNotional);
        } else {
          return componentMaxSize.lt(targetNotional.sub(currentNotional)) ? componentMaxSize : targetNotional.sub(currentNotional);
        }
      };

      const initializeSubjectVariables = () => {
        subjectCaller = trader;
        subjectSetToken = index;
        subjectComponent = setup.wbtc.address;
        subjectIncreaseTime = ONE_MINUTE_IN_SECONDS.mul(5);
        subjectMinComponentReceived = ZERO;
      };

      async function subject(): Promise<ContractTransaction> {
        await increaseTimeAsync(subjectIncreaseTime);
        return await indexModule.connect(subjectCaller.wallet).tradeRemainingWETH(
          subjectSetToken.address,
          subjectComponent,
          subjectMinComponentReceived
        );
      }

      describe("with default target units", () => {
        let wethAmountIn: BigNumber;
        let expectedWbtcOut: BigNumber;

        beforeEach(initializeSubjectVariables);
        cacheBeforeEach(startRebalanceAndTrade);

        describe("when ETH remaining in contract, trade remaining WETH", async () => {
          beforeEach(async () => {
            wethAmountIn = await getFixedAmountIn(subjectSetToken, setup.weth.address);
            [, expectedWbtcOut] = await sushiswapSetup.router.getAmountsOut(
              wethAmountIn,
              [setup.weth.address, setup.wbtc.address]
            );

            subjectMinComponentReceived = expectedWbtcOut;
          });

          it("the position units and lastTradeTimestamp should be set as expected", async () => {
            const totalSupply = await subjectSetToken.totalSupply();
            const currentWbtcAmount = await setup.wbtc.balanceOf(subjectSetToken.address);

            await subject();

            const lastBlockTimestamp = await getLastBlockTimestamp();

            const expectedWbtcPositionUnits = preciseDiv(currentWbtcAmount.add(expectedWbtcOut), totalSupply);

            const wethPositionUnits = await subjectSetToken.getDefaultPositionRealUnit(setup.weth.address);
            const wbtcPositionUnits = await subjectSetToken.getDefaultPositionRealUnit(setup.wbtc.address);
            const lastTrade = (await indexModule.executionInfo(subjectSetToken.address, subjectComponent)).lastTradeTimestamp;

            expect(wethPositionUnits).to.eq(ZERO);
            expect(wbtcPositionUnits).to.eq(expectedWbtcPositionUnits);
            expect(lastTrade).to.eq(lastBlockTimestamp);
          });

          it("emits the correct TradeExecuted event", async () => {
            await expect(subject()).to.be.emit(indexModule, "TradeExecuted").withArgs(
              subjectSetToken.address,
              setup.weth.address,
              subjectComponent,
              sushiswapExchangeAdapter.address,
              subjectCaller.wallet.address,
              wethAmountIn,
              expectedWbtcOut,
              ZERO,
            );
          });

          describe("when protocol fees is charged", async () => {
            let subjectFeePercentage: BigNumber;

            beforeEach(async () => {
              subjectFeePercentage = ether(0.05);
              setup.controller = setup.controller.connect(owner.wallet);
              await setup.controller.addFee(
                indexModule.address,
                ZERO, // Fee type on trade function denoted as 0
                subjectFeePercentage // Set fee to 5 bps
              );
            });

            it("the position units and lastTradeTimestamp should be set as expected", async () => {
              const totalSupply = await subjectSetToken.totalSupply();
              const currentWbtcAmount = await setup.wbtc.balanceOf(subjectSetToken.address);

              await subject();

              const lastBlockTimestamp = await getLastBlockTimestamp();

              const protocolFee = expectedWbtcOut.mul(subjectFeePercentage).div(ether(1));
              const expectedWbtcPositionUnits = preciseDiv(currentWbtcAmount.add(expectedWbtcOut).sub(protocolFee), totalSupply);

              const wethPositionUnits = await subjectSetToken.getDefaultPositionRealUnit(setup.weth.address);
              const wbtcPositionUnits = await subjectSetToken.getDefaultPositionRealUnit(setup.wbtc.address);
              const lastTrade = (await indexModule.executionInfo(subjectSetToken.address, subjectComponent)).lastTradeTimestamp;

              expect(wethPositionUnits).to.eq(ZERO);
              expect(wbtcPositionUnits).to.eq(expectedWbtcPositionUnits);
              expect(lastTrade).to.eq(lastBlockTimestamp);
            });

            it("the fees should be received by the fee recipient", async () => {
              const feeRecipient = await setup.controller.feeRecipient();
              const beforeWbtcBalance = await setup.wbtc.balanceOf(feeRecipient);

              await subject();

              const wbtcBalance = await setup.wbtc.balanceOf(feeRecipient);

              const protocolFee = expectedWbtcOut.mul(subjectFeePercentage).div(ether(1));
              const expectedWbtcBalance = beforeWbtcBalance.add(protocolFee);

              expect(wbtcBalance).to.eq(expectedWbtcBalance);
            });

            it("emits the correct TradeExecuted event", async () => {
              const protocolFee = expectedWbtcOut.mul(subjectFeePercentage).div(ether(1));
              await expect(subject()).to.be.emit(indexModule, "TradeExecuted").withArgs(
                subjectSetToken.address,
                setup.weth.address,
                subjectComponent,
                sushiswapExchangeAdapter.address,
                subjectCaller.wallet.address,
                wethAmountIn,
                expectedWbtcOut.sub(protocolFee),
                protocolFee,
              );
            });

            describe("when the prototol fee percentage is 100", async () => {
              beforeEach(async () => {
                subjectFeePercentage = ether(100);
                await setup.controller.editFee(
                  indexModule.address,
                  ZERO, // Fee type on trade function denoted as 0
                  subjectFeePercentage
                );
              });

              it("should revert", async () => {
                await expect(subject()).to.be.revertedWith("transfer amount exceeds balance");
              });
            });

            describe("when the prototol fee percentage is MAX_UINT_256", async () => {
              beforeEach(async () => {
                subjectFeePercentage = ether(100);
                await setup.controller.editFee(
                  indexModule.address,
                  ZERO, // Fee type on trade function denoted as 0
                  subjectFeePercentage
                );
              });

              it("should revert", async () => {
                await expect(subject()).to.be.revertedWith("transfer amount exceeds balance");
              });
            });
          });

          describe("when exchange returns amount less than subjectMinComponentReceived", async () => {
            beforeEach(async () => {
              [, expectedWbtcOut] = await sushiswapSetup.router.getAmountsOut(
                wethAmountIn,
                [setup.weth.address, setup.wbtc.address]
              );
              subjectMinComponentReceived = expectedWbtcOut.mul(2);
            });

            it("should revert", async () => {
              await expect(subject()).to.be.reverted;
            });
          });

          describe("when the target has been met and trading overshoots target unit", async () => {
            beforeEach(async () => {
              subjectComponent = setup.dai.address;
              subjectMinComponentReceived = ZERO;
            });

            it("the trade reverts", async () => {
              await expect(subject()).to.be.revertedWith("Can not exceed target unit");
            });
          });

          describe("when not enough time has elapsed between trades", async () => {
            beforeEach(async () => {
              subjectIncreaseTime = ZERO;
            });

            it("should revert", async () => {
              await expect(subject()).to.be.revertedWith("Component cool off in progress");
            });
          });

          describe("when the passed component is not included in rebalance components", async () => {
            beforeEach(async () => {
              subjectComponent = sushiswapSetup.uni.address;
              subjectMinComponentReceived = ZERO;
            });

            it("should revert", async () => {
              await expect(subject()).to.be.revertedWith("Component not part of rebalance");
            });
          });

          describe("when there are external positions for a component", async () => {
            beforeEach(async () => {
              await subjectSetToken.connect(positionModule.wallet).addExternalPositionModule(
                subjectComponent,
                positionModule.address
              );
            });

            afterEach(async () => {
              await subjectSetToken.connect(positionModule.wallet).removeExternalPositionModule(
                subjectComponent,
                positionModule.address
              );
            });

            it("should revert", async () => {
              await expect(subject()).to.be.revertedWith("External positions not allowed");
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
              await indexModule.connect(owner.wallet).setTraderStatus(subjectSetToken.address, [contractCaller.address], [true]);

              subjectTarget = indexModule.address;
              subjectIncreaseTime = ONE_MINUTE_IN_SECONDS.mul(5);
              subjectCallData = indexModule.interface.encodeFunctionData(
                "tradeRemainingWETH",
                [subjectSetToken.address, subjectComponent, subjectMinComponentReceived]
              );
              subjectValue = ZERO;
            });

            async function subjectContractCaller(): Promise<ContractTransaction> {
              await increaseTimeAsync(subjectIncreaseTime);
              return await contractCaller.invoke(
                subjectTarget,
                subjectValue,
                subjectCallData
              );
            }

            it("the trade reverts", async () => {
              await expect(subjectContractCaller()).to.not.be.reverted;
            });
          });
        });
      });

      describe("with alternative target units", () => {
        describe("when the value of WETH in index exceeds component trade size", async () => {
          beforeEach(async () => {
            oldTargetUnits = [ether(60.869565), bitcoin(.019), ether(50)];

            initializeSubjectVariables();

            await startRebalanceAndTrade();
            await indexModule.connect(owner.wallet).setTradeMaximums(subjectSetToken.address, [subjectComponent], [bitcoin(.01)]);
          });

          after(async () => {
            await indexModule.connect(owner.wallet).setTradeMaximums(
              subjectSetToken.address,
              [subjectComponent],
              [bitcoin(.1)]
            );
          });

          it("the trade reverts", async () => {
            await expect(subject()).to.be.revertedWith("Trade amount > max trade size");
          });
        });

        describe("when sellable components still remain", async () => {
          beforeEach(async () => {
            oldTargetUnits = [ether(60.869565), bitcoin(.019), ether(48)];
            initializeSubjectVariables();

            await startRebalanceAndTrade();
          });

          it("the trade reverts", async () => {
            await expect(subject()).to.be.revertedWith("Sell other set components first");
          });
        });
      });

      describe("when set has weth as component", async () => {
        before(async () => {
          oldTargetUnits = [ether(60.869565), bitcoin(.02), ether(50), ether(.434782609)];
        });

        beforeEach(async () => {
          initializeSubjectVariables();
          subjectSetToken = indexWithWeth;

          await startRebalanceAndTrade();
        });

        it("the position units and lastTradeTimestamp should be set as expected", async () => {
          const wethAmountIn = await getFixedAmountIn(subjectSetToken, setup.weth.address);
          const [, expectedWbtcOut] = await sushiswapSetup.router.getAmountsOut(
            wethAmountIn,
            [setup.weth.address, setup.wbtc.address]
          );
          const totalSupply = await subjectSetToken.totalSupply();
          const currentWbtcAmount = await setup.wbtc.balanceOf(subjectSetToken.address);

          await subject();

          const lastBlockTimestamp = await getLastBlockTimestamp();

          const expectedWbtcPositionUnits = preciseDiv(currentWbtcAmount.add(expectedWbtcOut), totalSupply);

          const wethPositionUnits = await subjectSetToken.getDefaultPositionRealUnit(setup.weth.address);
          const wbtcPositionUnits = await subjectSetToken.getDefaultPositionRealUnit(setup.wbtc.address);
          const lastTrade = (await indexModule.executionInfo(subjectSetToken.address, subjectComponent)).lastTradeTimestamp;

          expect(wethPositionUnits).to.eq(ether(.434782609));
          expect(wbtcPositionUnits).to.eq(expectedWbtcPositionUnits);
          expect(lastTrade).to.eq(lastBlockTimestamp);
        });

        describe("when weth is below target unit", async () => {
          before(async () => {
            oldTargetUnits = [ether(60.869565), bitcoin(.02), ether(50), ether(.8)];
          });

          it("the trade reverts", async () => {
            await expect(subject()).to.be.revertedWith("WETH is below target unit");
          });
        });
      });
    });

    describe("#getRebalanceComponents", async () => {
      before(async () => {
        // current units [ether(86.9565217), bitcoin(.01111111), ether(100), ZERO]
        newComponents = [];
        oldTargetUnits = [ether("60.869565780223716593"), bitcoin(.02), ether(55)];
        newTargetUnits = [];
        issueAmount = ether("20.000000000000000001");
      });

      const startRebalance = async () => {
        await setup.approveAndIssueSetToken(subjectSetToken, issueAmount);
        await indexModule.startRebalance(
          subjectSetToken.address,
          newComponents,
          newTargetUnits,
          oldTargetUnits,
          await index.positionMultiplier()
        );
      };

      const initializeSubjectVariables = () => {
        subjectSetToken = index;
      };

      beforeEach(async () => {
        initializeSubjectVariables();
        await startRebalance();
      });

      async function subject(tokenAddress: Address): Promise<any> {
        return await indexModule.getRebalanceComponents(tokenAddress);
      }

      it("the components being rebalanced should be returned", async () => {
        const expectedComponents = [uniswapSetup.uni.address, setup.wbtc.address, setup.dai.address];

        const rebalanceComponents = await subject(subjectSetToken.address);

        expect(rebalanceComponents).to.deep.eq(expectedComponents);
      });

      describe("when set token is not valid", async () => {
        it("should revert", async () => {
          await expect(subject(ADDRESS_ZERO)).to.be.revertedWith("Must be a valid and initialized SetToken");
        });
      });
    });

    describe("#getComponentTradeQuantityAndDirection", async () => {
      let subjectComponent: Address;

      let feePercentage: BigNumber;

      before(async () => {
        // current units [ether(86.9565217), bitcoin(.01111111), ether(100), ZERO]
        newComponents = [setup.usdc.address];
        oldTargetUnits = [ether("60.869565780223716593"), bitcoin(.02), ether(55)];
        newTargetUnits = [usdc(100)];
        issueAmount = ether("20.000000000000000001");
      });

      const startRebalance = async () => {
        await setup.approveAndIssueSetToken(subjectSetToken, issueAmount);
        await indexModule.startRebalance(
          subjectSetToken.address,
          newComponents,
          newTargetUnits,
          oldTargetUnits,
          await index.positionMultiplier()
        );
      };

      const initializeSubjectVariables = () => {
        subjectSetToken = index;
        subjectComponent = setup.dai.address;
      };

      beforeEach(async () => {
        await indexModule.setTradeMaximums(index.address, [setup.usdc.address], [usdc(3000)]);

        initializeSubjectVariables();

        await startRebalance();

        feePercentage = ether(0.005);
        setup.controller = setup.controller.connect(owner.wallet);
        await setup.controller.addFee(
          indexModule.address,
          ZERO, // Fee type on trade function denoted as 0
          feePercentage // Set fee to 5 bps
        );
      });

      async function subject(): Promise<any> {
        return await indexModule.getComponentTradeQuantityAndDirection(
          subjectSetToken.address,
          subjectComponent
        );
      }

      it("the position units and lastTradeTimestamp should be set as expected, sell using Balancer", async () => {
        const totalSupply = await subjectSetToken.totalSupply();
        const currentDaiUnit = await subjectSetToken.getDefaultPositionRealUnit(setup.dai.address);
        const expectedDaiSize = preciseMul(currentDaiUnit, totalSupply).sub(preciseMul(ether(55), totalSupply));

        const [
          isSendTokenFixed,
          componentQuantity,
        ] = await subject();

        expect(componentQuantity).to.eq(expectedDaiSize);
        expect(isSendTokenFixed).to.be.true;
      });

      describe("when the component is being added to the Set", async () => {
        beforeEach(async () => {
          subjectComponent = setup.usdc.address;
        });

        it("the correct trade direction and size should be returned", async () => {
          const totalSupply = await subjectSetToken.totalSupply();
          const currentUsdcUnit = await subjectSetToken.getDefaultPositionRealUnit(setup.usdc.address);
          const expectedUsdcSize = preciseDiv(
            preciseMulCeil(usdc(100), totalSupply).sub(preciseMul(currentUsdcUnit, totalSupply)),
            PRECISE_UNIT.sub(feePercentage)
          );

          const [
            isSendTokenFixed,
            componentQuantity,
          ] = await subject();

          expect(componentQuantity).to.eq(expectedUsdcSize);
          expect(isSendTokenFixed).to.be.false;
        });
      });

      describe("and the buy component does not meet the max trade size", async () => {
        beforeEach(async () => {
          await indexModule.startRebalance(
            subjectSetToken.address,
            [],
            [],
            [ether("60.869565780223716593"), bitcoin(.016), ether(50)],
            await index.positionMultiplier()
          );

          subjectComponent = setup.wbtc.address;
        });

        it("the correct trade direction and size should be returned", async () => {
          const totalSupply = await subjectSetToken.totalSupply();
          const currentWbtcUnit = await subjectSetToken.getDefaultPositionRealUnit(setup.wbtc.address);
          const expectedWbtcSize = preciseDiv(
            preciseMulCeil(bitcoin(.016), totalSupply).sub(preciseMul(currentWbtcUnit, totalSupply)),
            PRECISE_UNIT.sub(feePercentage)
          );

          const [
            isSendTokenFixed,
            componentQuantity,
          ] = await subject();

          expect(componentQuantity).to.eq(expectedWbtcSize);
          expect(isSendTokenFixed).to.be.false;
        });
      });

      describe("when the setToken is not valid", async () => {
        beforeEach(() => {
          subjectSetToken = { address: ADDRESS_ZERO } as SetToken;
        });

        it("should revert", async () => {
          expect(subject()).to.be.revertedWith("Must be a valid and initialized SetToken");
        });
      });

      describe("when the component is not part of the rebalance", async () => {
        beforeEach(() => {
          subjectComponent = setup.weth.address;
        });

        it("should revert", async () => {
          expect(subject()).to.be.revertedWith("Component not recognized");
        });
      });
    });

    describe("#getIsAllowedTrader", async () => {
      let subjectTraders: Address[];
      let subjectStatuses: boolean[];

      beforeEach(async () => {
        subjectCaller = owner;
        subjectSetToken = index;
        subjectTraders = [trader.address];
        subjectStatuses = [true];

        return await indexModule.connect(subjectCaller.wallet).setTraderStatus(
          subjectSetToken.address,
          subjectTraders,
          subjectStatuses
        );
      });

      async function subject(): Promise<Boolean> {
        return await indexModule.connect(subjectCaller.wallet).getIsAllowedTrader(
          subjectSetToken.address,
          subjectTraders[0],
        );
      }

      it("returns trader status", async () => {
        await subject();

        const isTrader = await subject();
        expect(isTrader).to.be.true;
      });

      describe("when the setToken is not valid", async () => {
        beforeEach(() => {
          subjectSetToken = { address: ADDRESS_ZERO } as SetToken;
        });

        it("should revert", async () => {
          expect(subject()).to.be.revertedWith("Must be a valid and initialized SetToken");
        });
      });
    });

    describe("#getAllowedTraders", async () => {
      let subjectTraders: Address[];
      let subjectStatuses: boolean[];

      beforeEach(async () => {
        subjectCaller = owner;
        subjectSetToken = index;
        subjectTraders = [trader.address];
        subjectStatuses = [true];

        return await indexModule.connect(subjectCaller.wallet).setTraderStatus(
          subjectSetToken.address,
          subjectTraders,
          subjectStatuses
        );
      });

      async function subject(): Promise<Address[]> {
        return await indexModule.connect(subjectCaller.wallet).getAllowedTraders(subjectSetToken.address);
      }

      it("returns trader status", async () => {
        await subject();

        const expectedTraders = await subject();
        expect(expectedTraders).to.deep.equal(subjectTraders);
      });

      describe("when the setToken is not valid", async () => {
        beforeEach(() => {
          subjectSetToken = { address: ADDRESS_ZERO } as SetToken;
        });

        it("should revert", async () => {
          expect(subject()).to.be.revertedWith("Must be a valid and initialized SetToken");
        });
      });
    });

    describe("#setRaiseTargetPercentage", async () => {
      let subjectRaiseTargetPercentage: BigNumber;

      beforeEach(async () => {
        subjectSetToken = index;
        subjectCaller = owner;
        subjectRaiseTargetPercentage = ether("0.02");
      });

      async function subject(): Promise<ContractTransaction> {
        return await indexModule.connect(subjectCaller.wallet).setRaiseTargetPercentage(
          subjectSetToken.address,
          subjectRaiseTargetPercentage
        );
      }

      it("sets raiseTargetPercentage", async () => {
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
        beforeEach(async () => {
          subjectRaiseTargetPercentage = ZERO;
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("Target percentage must be > 0");
        });
      });
    });

    describe("#raiseAssetTargets", async () => {
      let subjectRaiseTargetPercentage: BigNumber;

      before(async () => {
        // current units [ether(86.9565217), bitcoin(.01111111), ether(100)]
        oldTargetUnits = [ether(60.869565), bitcoin(.015), ether(50)];
      });

      const startRebalance = async (trade: boolean = true, accrueFee: boolean = false) => {
        await setup.approveAndIssueSetToken(subjectSetToken, ether(20));

        if (accrueFee) {
          await increaseTimeAsync(ONE_DAY_IN_SECONDS);
          await setup.streamingFeeModule.accrueFee(subjectSetToken.address);
        }

        await indexModule.startRebalance(subjectSetToken.address, [], [], oldTargetUnits, await subjectSetToken.positionMultiplier());

        if (trade) {
          await increaseTimeAsync(ONE_MINUTE_IN_SECONDS.mul(5));
          await indexModule.connect(trader.wallet).trade(subjectSetToken.address, setup.dai.address, ZERO);
          await indexModule.connect(trader.wallet).trade(subjectSetToken.address, uniswapSetup.uni.address, ZERO);
          await indexModule.connect(trader.wallet).trade(subjectSetToken.address, setup.wbtc.address, MAX_UINT_256);
        }

        await indexModule.setRaiseTargetPercentage(subjectSetToken.address, subjectRaiseTargetPercentage);
      };

      async function subject(): Promise<ContractTransaction> {
        return await indexModule.connect(subjectCaller.wallet).raiseAssetTargets(subjectSetToken.address);
      }

      const initialializeSubjectVariables = () => {
        subjectSetToken = index;
        subjectCaller = trader;
      };

      describe("with default target units", () => {
        beforeEach(async () => {
          initialializeSubjectVariables();
          subjectRaiseTargetPercentage = ether(.0025);
          await startRebalance();
        });

        it("the position units and lastTradeTimestamp should be set as expected", async () => {
          const prePositionMultiplier = (await indexModule.rebalanceInfo(subjectSetToken.address)).positionMultiplier;

          await subject();

          const expectedPositionMultiplier = preciseDiv(
            prePositionMultiplier,
            PRECISE_UNIT.add(ether(.0025))
          );

          const positionMultiplier = (await indexModule.rebalanceInfo(subjectSetToken.address)).positionMultiplier;

          expect(positionMultiplier).to.eq(expectedPositionMultiplier);
        });

        it("emits correct AssetTargetsRaised event", async () => {
          const prePositionMultiplier = (await indexModule.rebalanceInfo(subjectSetToken.address)).positionMultiplier;

          const expectedPositionMultiplier = preciseDiv(
            prePositionMultiplier,
            PRECISE_UNIT.add(subjectRaiseTargetPercentage)
          );

          await expect(subject()).to.emit(indexModule, "AssetTargetsRaised").withArgs(
            subjectSetToken.address,
            expectedPositionMultiplier
          );
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

      describe("when the raiseTargetPercentage is the lowest valid decimal (1e-6)", () => {
        beforeEach(async () => {
          initialializeSubjectVariables();
          subjectRaiseTargetPercentage = ether(.000001);
          await startRebalance();
        });

        afterEach(() => {
          subjectRaiseTargetPercentage = ether(.0025);
        });

        it("the position multiplier should be set as expected", async () => {
          const prePositionMultiplier = (await indexModule.rebalanceInfo(subjectSetToken.address)).positionMultiplier;

          await subject();

          const expectedPositionMultiplier = preciseDiv(
            prePositionMultiplier,
            PRECISE_UNIT.add(subjectRaiseTargetPercentage)
          );

          const positionMultiplier = (await indexModule.rebalanceInfo(subjectSetToken.address)).positionMultiplier;

          expect(positionMultiplier).to.eq(expectedPositionMultiplier);
        });
      });

      describe("when the raiseTargetPercentage is MAX_UINT_256", () => {
        beforeEach(async () => {
          initialializeSubjectVariables();
          subjectRaiseTargetPercentage = MAX_UINT_256;
          await startRebalance();
        });

        afterEach(() => {
          subjectRaiseTargetPercentage = ether(.0025);
        });

        it("it should revert", async () => {
          await expect(subject()).to.be.revertedWith("addition overflow");
        });
      });

      describe("when protocol fees are charged", () => {
        beforeEach(async () => {
          const feePercentage = ether(0.005);
          setup.controller = setup.controller.connect(owner.wallet);
          await setup.controller.addFee(
            indexModule.address,
            ZERO, // Fee type on trade function denoted as 0
            feePercentage // Set fee to 5 bps
          );

          initialializeSubjectVariables();
          await startRebalance(true, true);
        });

        it("the position units and lastTradeTimestamp should be set as expected", async () => {
          const prePositionMultiplier = (await indexModule.rebalanceInfo(subjectSetToken.address)).positionMultiplier;

          await subject();

          const expectedPositionMultiplier = preciseDiv(
            prePositionMultiplier,
            PRECISE_UNIT.add(ether(.0025))
          );

          const positionMultiplier = (await indexModule.rebalanceInfo(subjectSetToken.address)).positionMultiplier;

          expect(positionMultiplier).to.eq(expectedPositionMultiplier);
        });
      });

      describe("when a component is being removed", async () => {
        beforeEach(async () => {
          // current Units [ether(86.9565217), bitcoin(.01111111), ether(100)]
          oldTargetUnits = [ether(60.869565), bitcoin(.015), ZERO];

          initialializeSubjectVariables();

          await indexModule.setTradeMaximums(subjectSetToken.address, [setup.dai.address], [ether(2000)]);
          await startRebalance();
        });

        it("the position units and lastTradeTimestamp should be set as expected and the unit should be zeroed out", async () => {
          const prePositionMultiplier = (await indexModule.rebalanceInfo(subjectSetToken.address)).positionMultiplier;

          await subject();

          const expectedPositionMultiplier = preciseDiv(
            prePositionMultiplier,
            PRECISE_UNIT.add(ether(.0025))
          );

          const positionMultiplier = (await indexModule.rebalanceInfo(subjectSetToken.address)).positionMultiplier;
          const daiUnits = await subjectSetToken.getDefaultPositionRealUnit(setup.dai.address);

          expect(positionMultiplier).to.eq(expectedPositionMultiplier);
          expect(daiUnits).to.eq(ZERO);
        });
      });

      describe("with alternative target units", async () => {
        describe("when the target has been met and no ETH remains", async () => {
          beforeEach(async () => {
            // current Units [ether(86.9565217), bitcoin(.01111111), ether(100)]
            oldTargetUnits = [ether(60.869565), bitcoin(.02), ether(50)];

            initialializeSubjectVariables();
            await startRebalance();

            await increaseTimeAsync(ONE_MINUTE_IN_SECONDS.mul(5));
            await indexModule.connect(trader.wallet).tradeRemainingWETH(subjectSetToken.address, setup.wbtc.address, ZERO);
          });

          it("the trade reverts", async () => {
            await expect(subject()).to.be.revertedWith("Targets not met or ETH =~ 0");
          });
        });

        describe("when set has weth as a component", async () => {
          describe("when the target has been met and ETH is below target unit", async () => {
            beforeEach(async () => {
              // current Units [ether(86.9565217), bitcoin(.01111111), ether(100), ether(0.434782609)]
              oldTargetUnits = [ether(86.9565217), bitcoin(.01111111), ether(100), ether(0.5)];

              subjectSetToken = indexWithWeth;
              subjectCaller = trader;

              await startRebalance(false);
            });

            it("the trade reverts", async () => {
              await expect(subject()).to.be.revertedWith("Targets not met or ETH =~ 0");
            });
          });
        });
      });
    });

    describe("#setTraderStatus", async () => {
      let subjectTraders: Address[];
      let subjectStatuses: boolean[];

      beforeEach(async () => {
        subjectCaller = owner;
        subjectSetToken = index;
        subjectTraders = [trader.address, await getRandomAddress(), await getRandomAddress()];
        subjectStatuses = [true, true, true];
      });

      async function subject(): Promise<ContractTransaction> {
        return await indexModule.connect(subjectCaller.wallet).setTraderStatus(
          subjectSetToken.address,
          subjectTraders,
          subjectStatuses
        );
      }

      it("the trader status should be flipped to true", async () => {
        await subject();

        const isTraderOne = await indexModule.getIsAllowedTrader(subjectSetToken.address, subjectTraders[0]);
        const isTraderTwo = await indexModule.getIsAllowedTrader(subjectSetToken.address, subjectTraders[1]);
        const isTraderThree = await indexModule.getIsAllowedTrader(subjectSetToken.address, subjectTraders[2]);

        expect(isTraderOne).to.be.true;
        expect(isTraderTwo).to.be.true;
        expect(isTraderThree).to.be.true;
      });

      it("should emit TraderStatusUpdated event", async () => {
        await expect(subject()).to.emit(indexModule, "TraderStatusUpdated").withArgs(
          subjectSetToken.address,
          subjectTraders[0],
          true
        );
      });

      describe("when de-authorizing a trader", async () => {
        beforeEach(async () => {
          await subject();
          subjectStatuses = [false, true, true];
        });

        it("the trader status should be flipped to false", async () => {
          const preConditionTrader = await indexModule.getIsAllowedTrader(subjectSetToken.address, subjectTraders[0]);
          expect(preConditionTrader).to.be.true;

          await subject();

          const postConditionTrader = await indexModule.getIsAllowedTrader(subjectSetToken.address, subjectTraders[0]);
          expect(postConditionTrader).to.be.false;
        });

        it("the tradersHistory should be updated correctly", async () => {
          const preConditionTraders = await indexModule.getAllowedTraders(subjectSetToken.address);
          expect(preConditionTraders).to.deep.equal(subjectTraders);

          await subject();

          const postConditionTraders = await indexModule.getAllowedTraders(subjectSetToken.address);
          const expectedTraders = subjectTraders.slice(1);

          expect(expectedTraders[0]).to.not.equal(expectedTraders[1]);
          expect(postConditionTraders[0]).to.not.equal(postConditionTraders[1]);

          expect(postConditionTraders.includes(expectedTraders[0])).to.be.true;
          expect(postConditionTraders.includes(expectedTraders[1])).to.be.true;
        });
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
          await expect(subject()).to.be.revertedWith("Cannot duplicate addresses");
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

    describe("#removeModule", async () => {
      let subjectStatuses: boolean[];
      let subjectTraders: Address[];

      beforeEach(async () => {
        subjectSetToken = index;
        subjectCaller = owner;
        subjectTraders = [trader.address, await getRandomAddress()];
        subjectStatuses = [true, false];
      });

      afterEach(restoreModule);

      async function restoreModule() {
        const isModuleEnabled = await subjectSetToken.isInitializedModule(indexModule.address);

        if (!isModuleEnabled) {
          await subjectSetToken.connect(subjectCaller.wallet).addModule(indexModule.address);
          await indexModule.connect(subjectCaller.wallet).initialize(subjectSetToken.address);
        }
      }

      describe("removal", async () => {
        async function subject(): Promise<any> {
          return subjectSetToken.connect(subjectCaller.wallet).removeModule(indexModule.address);
        }

        it("should remove the module", async () => {
          await subject();
          const isModuleEnabled = await subjectSetToken.isInitializedModule(indexModule.address);
          expect(isModuleEnabled).to.eq(false);
        });
      });

      describe("when restoring module after removal and using permissionInfo", async () => {
        beforeEach(async () => {
          await indexModule.connect(subjectCaller.wallet).setTraderStatus(
            subjectSetToken.address,
            subjectTraders,
            subjectStatuses
          );

          await indexModule.connect(subjectCaller.wallet).setAnyoneTrade(
            subjectSetToken.address,
            true
          );
        });

        async function subject(): Promise<any> {
          await subjectSetToken.connect(subjectCaller.wallet).removeModule(indexModule.address);
          await restoreModule();
        }

        it("should have removed traders from the permissions whitelist", async () => {
          let isTraderOne = await indexModule.getIsAllowedTrader(subjectSetToken.address, subjectTraders[0]);
          expect(isTraderOne).to.be.true;

          await subject();

          isTraderOne = await indexModule.getIsAllowedTrader(subjectSetToken.address, subjectTraders[0]);
          expect(isTraderOne).to.be.false;
        });

        it("should have set anyoneTrade to false", async () => {
          // The public getter return sig generated for permissionInfo's abi
          // is  <bool>anyoneTrade (and nothing else).
          let anyoneTrade = await indexModule.permissionInfo(subjectSetToken.address);
          expect(anyoneTrade).to.be.true;

          await subject();

          anyoneTrade = await indexModule.permissionInfo(subjectSetToken.address);
          expect(anyoneTrade).to.be.false;
        });
      });

      describe("when restoring module after removal and using rebalanceInfo", async () => {
        let subjectNewComponents;
        let subjectNewTargetUnits;
        let subjectOldTargetUnits;
        let subjectPositionMultiplier;

        beforeEach(async () => {
          subjectNewComponents = [sushiswapSetup.uni.address];
          subjectNewTargetUnits = [ether(50)];
          subjectOldTargetUnits = [ether("60.869565780223716593"), bitcoin(.02), ether(50)];
          subjectPositionMultiplier = MAX_UINT_256;

          await indexModule.startRebalance(
            subjectSetToken.address,
            subjectNewComponents,
            subjectNewTargetUnits,
            subjectOldTargetUnits,
            subjectPositionMultiplier
          );

          await indexModule.setRaiseTargetPercentage(subjectSetToken.address, MAX_UINT_256);
        });

        async function subject(): Promise<any> {
          await subjectSetToken.connect(subjectCaller.wallet).removeModule(indexModule.address);
          await restoreModule();
        }

        it("should have cleared the rebalance components array", async () => {
          const preRemoveComponents = await indexModule.getRebalanceComponents(subjectSetToken.address);

          await subject();

          const postRemoveComponents = await indexModule.getRebalanceComponents(subjectSetToken.address);

          expect(preRemoveComponents.length).to.equal(4);
          expect(postRemoveComponents.length).to.equal(ZERO);
        });

        it("should have reset the positionMultiplier to PRECISE_UNIT", async () => {
          const preRemoveMultiplier = (await indexModule.rebalanceInfo(subjectSetToken.address)).positionMultiplier;

          await subject();

          const postRemoveMultiplier = (await indexModule.rebalanceInfo(subjectSetToken.address)).positionMultiplier;
          expect(preRemoveMultiplier).to.equal(MAX_UINT_256);
          expect(postRemoveMultiplier).to.equal(PRECISE_UNIT);
        });

        it("should have zeroed out the raiseTargetPercentage", async () => {
          const preRemoveMultiplier = (await indexModule.rebalanceInfo(subjectSetToken.address)).raiseTargetPercentage;

          await subject();

          const postRemoveMultiplier = (await indexModule.rebalanceInfo(subjectSetToken.address)).raiseTargetPercentage;
          expect(preRemoveMultiplier).to.equal(MAX_UINT_256);
          expect(postRemoveMultiplier).to.equal(ZERO);
        });
      });
    });
  });
});
