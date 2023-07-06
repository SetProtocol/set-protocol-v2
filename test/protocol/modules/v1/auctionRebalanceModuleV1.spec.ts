import "module-alias/register";
import { BigNumber } from "ethers";

import { Address, AuctionExecutionParams, StreamingFeeState } from "@utils/types";
import { Account } from "@utils/test/types";
import { ADDRESS_ZERO, MAX_UINT_256, ONE_DAY_IN_SECONDS, ONE_HOUR_IN_SECONDS, PRECISE_UNIT, ZERO, ZERO_BYTES } from "@utils/constants";
import {
  AuctionRebalanceModuleV1,
  BoundedStepwiseExponentialPriceAdapter,
  BoundedStepwiseLinearPriceAdapter,
  BoundedStepwiseLogarithmicPriceAdapter,
  ConstantPriceAdapter,
  SetToken,
  StandardTokenMock,
  WETH9,
} from "@utils/contracts";
import DeployHelper from "@utils/deploys";
import {
  bitcoin,
  ether,
  preciseDiv,
  preciseMul,
  usdc
} from "@utils/index";
import {
  cacheBeforeEach,
  getAccounts,
  getRandomAccount,
  getSystemFixture,
  getWaffleExpect,
  increaseTimeAsync,
  getTransactionTimestamp,
  getRandomAddress,
} from "@utils/test/index";
import { SystemFixture } from "@utils/fixtures";
import { ContractTransaction } from "ethers";
import { before } from "mocha";

const expect = getWaffleExpect();

describe("AuctionRebalanceModuleV1", () => {
  let owner: Account;
  let bidder: Account;
  let positionModule: Account;
  let deployer: DeployHelper;
  let setup: SystemFixture;

  let indexWithQuoteAsset: SetToken;
  let indexWithoutQuoteAsset: SetToken;
  let auctionModule: AuctionRebalanceModuleV1;

  const AdapterNames = {
    CONSTANT_PRICE_ADAPTER: "CONSTANT_PRICE_ADAPTER",
    BOUNDED_STEPWISE_EXPONENTIAL_PRICE_ADAPTER: "BOUNDED_STEPWISE_EXPONENTIAL_PRICE_ADAPTER",
    BOUNDED_STEPWISE_LINEAR_PRICE_ADAPTER: "BOUNDED_STEPWISE_LINEAR_PRICE_ADAPTER",
    BOUNDED_STEPWISE_LOGARITHMIC_PRICE_ADAPTER: "BOUNDED_STEPWISE_LOGARITHMIC_PRICE_ADAPTER",
  };

  let constantPriceAdapter: ConstantPriceAdapter;
  let boundedStepwiseExponentialPriceAdapter: BoundedStepwiseExponentialPriceAdapter;
  let boundedStepwiseLinearPriceAdapter: BoundedStepwiseLinearPriceAdapter;
  let boundedStepwiseLogarithmicPriceAdapter: BoundedStepwiseLogarithmicPriceAdapter;

  let indexWithQuoteAssetComponents: Address[];
  let indexWithQuoteAssetUnits: BigNumber[];
  let indexWithoutQuoteAssetComponents: Address[];
  let indexWithoutQuoteAssetUnits: BigNumber[];

  before(async () => {
    [owner, bidder, positionModule] = await getAccounts();

    deployer = new DeployHelper(owner.wallet);
    setup = getSystemFixture(owner.address);

    await setup.initialize();

    auctionModule = await deployer.modules.deployAuctionRebalanceModuleV1(setup.controller.address);
    await setup.controller.addModule(auctionModule.address);
    await setup.controller.addModule(positionModule.address);

    constantPriceAdapter = await deployer.adapters.deployConstantPriceAdapter();
    boundedStepwiseExponentialPriceAdapter = await deployer.adapters.deployBoundedStepwiseExponentialPriceAdapter();
    boundedStepwiseLinearPriceAdapter = await deployer.adapters.deployBoundedStepwiseLinearPriceAdapter();
    boundedStepwiseLogarithmicPriceAdapter = await deployer.adapters.deployBoundedStepwiseLogarithmicPriceAdapter();

    await setup.integrationRegistry.batchAddIntegration(
      [auctionModule.address, auctionModule.address, auctionModule.address, auctionModule.address],
      [
        AdapterNames.CONSTANT_PRICE_ADAPTER,
        AdapterNames.BOUNDED_STEPWISE_EXPONENTIAL_PRICE_ADAPTER,
        AdapterNames.BOUNDED_STEPWISE_LINEAR_PRICE_ADAPTER,
        AdapterNames.BOUNDED_STEPWISE_LOGARITHMIC_PRICE_ADAPTER,
      ],
      [
        constantPriceAdapter.address,
        boundedStepwiseExponentialPriceAdapter.address,
        boundedStepwiseLinearPriceAdapter.address,
        boundedStepwiseLogarithmicPriceAdapter.address,
      ]
    );
  });

  cacheBeforeEach(async () => {
    const feeSettings = {
      feeRecipient: owner.address,
      maxStreamingFeePercentage: ether(.1),
      streamingFeePercentage: ether(.01),
      lastStreamingFeeTimestamp: ZERO,
    } as StreamingFeeState;

    // Setup for indexWithQuoteAsset.
    indexWithQuoteAssetComponents = [setup.dai.address, setup.wbtc.address, setup.weth.address];
    indexWithQuoteAssetUnits = [ether(10000), bitcoin(.5), ether(5)];
    indexWithQuoteAsset = await setup.createSetToken(
      indexWithQuoteAssetComponents,
      indexWithQuoteAssetUnits,
      [setup.issuanceModule.address, setup.streamingFeeModule.address, auctionModule.address, positionModule.address],
    );
    await setup.streamingFeeModule.initialize(indexWithQuoteAsset.address, feeSettings);
    await setup.issuanceModule.initialize(indexWithQuoteAsset.address, ADDRESS_ZERO);
    await indexWithQuoteAsset.connect(positionModule.wallet).initializeModule();
    await setup.approveAndIssueSetToken(indexWithQuoteAsset, ether(1));

    // Setup for indexWithoutQuoteAsset.
    indexWithoutQuoteAssetComponents = [setup.dai.address, setup.wbtc.address];
    indexWithoutQuoteAssetUnits = [ether(10000), bitcoin(.5)];
    indexWithoutQuoteAsset = await setup.createSetToken(
      indexWithoutQuoteAssetComponents,
      indexWithoutQuoteAssetUnits,
      [setup.issuanceModule.address, setup.streamingFeeModule.address, auctionModule.address],
    );
    await setup.streamingFeeModule.initialize(indexWithoutQuoteAsset.address, feeSettings);
    await setup.issuanceModule.initialize(indexWithoutQuoteAsset.address, ADDRESS_ZERO);
    await setup.approveAndIssueSetToken(indexWithoutQuoteAsset, ether(1));
  });

  describe("#constructor", async () => {
    it("should set the controller parameter correctly", async () => {
      const controller = await auctionModule.controller();

      expect(controller).to.eq(setup.controller.address);
    });
  });

  describe("#initialize", async () => {
    let subjectSetToken: SetToken;
    let subjectCaller: Account;

    beforeEach(async () => {
      subjectSetToken = indexWithQuoteAsset;
      subjectCaller = owner;
    });

    async function subject(): Promise<any> {
      auctionModule = auctionModule.connect(subjectCaller.wallet);
      return auctionModule.initialize(subjectSetToken.address);
    }

    it("should enable the Module on the SetToken", async () => {
      await subject();
      const isModuleEnabled = await subjectSetToken.isInitializedModule(auctionModule.address);
      expect(isModuleEnabled).to.eq(true);
    });

    it("should set the targetUnit for each component correctly", async () => {
      await subject();

      const positions = await subjectSetToken.getPositions();
      for (const position of positions) {
        const executionInfo = await auctionModule.executionInfo(subjectSetToken.address, position.component);
        expect(executionInfo.targetUnit).to.eq(position.unit);
      }
    });

    it("should set the positionMultiplier on the AuctionRebalanceModuleV1", async () => {
      await subject();

      const rebalanceInfo = await auctionModule.rebalanceInfo(subjectSetToken.address);
      expect(rebalanceInfo.positionMultiplier).to.eq(ether(1));
    });

    describe("when the caller is not the SetToken manager", async () => {
      beforeEach(async () => {
        subjectCaller = await getRandomAccount();
      });

      it("should revert with 'Must be the SetToken manager'", async () => {
        await expect(subject()).to.be.revertedWith("Must be the SetToken manager");
      });
    });

    describe("when the module is not pending", async () => {
      beforeEach(async () => {
        await subject();
      });

      it("should revert with 'Must be pending initialization'", async () => {
        await expect(subject()).to.be.revertedWith("Must be pending initialization");
      });
    });

    describe("when the SetToken is not enabled on the controller", async () => {
      beforeEach(async () => {
        const nonEnabledSetToken = await setup.createNonControllerEnabledSetToken(
          [setup.dai.address],
          [ether(1)],
          [auctionModule.address],
          owner.address
        );

        subjectSetToken = nonEnabledSetToken;
      });

      it("should revert with 'Must be controller-enabled SetToken'", async () => {
        await expect(subject()).to.be.revertedWith("Must be controller-enabled SetToken");
      });
    });

    describe("when there are external positions for a component", async () => {
      beforeEach(async () => {
        await subjectSetToken.connect(positionModule.wallet).addExternalPositionModule(
          indexWithQuoteAssetComponents[0],
          positionModule.address
        );
      });

      afterEach(async () => {
        await subjectSetToken.connect(positionModule.wallet).removeExternalPositionModule(
          indexWithQuoteAssetComponents[0],
          positionModule.address
        );
      });

      it("should revert with 'External positions not allowed", async () => {
        await expect(subject()).to.be.revertedWith("External positions not allowed");
      });
    });
  });

  describe("when module is initalized", async () => {
    let wbtcPerWethDecimalFactor: BigNumber;

    let defaultDaiPrice: BigNumber;
    let defaultWbtcPrice: BigNumber;
    let defaultWethPrice: BigNumber;

    let defaultDaiData: string;
    let defaultWbtcData: string;
    let defaultWethData: string;

    let defaultQuoteAsset: Address;
    let defaultNewComponents: Address[];
    let defaultNewComponentsAuctionParams: AuctionExecutionParams[];
    let defaultOldComponentsAuctionParams: AuctionExecutionParams[];
    let defaultShouldLockSetToken: boolean;
    let defaultDuration: BigNumber;
    let defaultPositionMultiplier: BigNumber;

    let subjectSetToken: SetToken;
    let subjectCaller: Account;

    async function initSetToken(
      setToken: SetToken
    ) {
      await auctionModule.initialize(setToken.address);
      await auctionModule.setBidderStatus(setToken.address, [bidder.address], [true]);
    }

    cacheBeforeEach(async () => {
      // initialize auctionModule on both SetTokens
      await initSetToken(
        indexWithQuoteAsset,
      );

      await initSetToken(
        indexWithoutQuoteAsset,
      );

      wbtcPerWethDecimalFactor = ether(1).div(bitcoin(1));

      defaultDaiPrice = ether(0.0005);
      defaultWbtcPrice = ether(14.5).mul(wbtcPerWethDecimalFactor);
      defaultWethPrice = ether(1);

      defaultDaiData = await constantPriceAdapter.getEncodedData(defaultDaiPrice);
      defaultWbtcData = await constantPriceAdapter.getEncodedData(defaultWbtcPrice);
      defaultWethData = await constantPriceAdapter.getEncodedData(defaultWethPrice);

      defaultOldComponentsAuctionParams = [
        {
          targetUnit: ether(9100),
          priceAdapterName: AdapterNames.CONSTANT_PRICE_ADAPTER,
          priceAdapterConfigData: defaultDaiData
        },
        {
          targetUnit: bitcoin(.6),
          priceAdapterName: AdapterNames.CONSTANT_PRICE_ADAPTER,
          priceAdapterConfigData: defaultWbtcData
        },
        {
          targetUnit: ether(4),
          priceAdapterName: AdapterNames.CONSTANT_PRICE_ADAPTER,
          priceAdapterConfigData: defaultWethData
        }
      ];

      defaultQuoteAsset = setup.weth.address;
      defaultShouldLockSetToken = false;
      defaultDuration = ONE_DAY_IN_SECONDS.mul(5);
      defaultPositionMultiplier = await indexWithQuoteAsset.positionMultiplier();
      defaultNewComponents = [];
      defaultNewComponentsAuctionParams = [];

      subjectSetToken = indexWithQuoteAsset;
    });

    const startRebalance = async (
      setTokenAddress = subjectSetToken.address,
      quoteAsset = defaultQuoteAsset,
      newComponents = defaultNewComponents,
      newComponentsAuctionParams = defaultNewComponentsAuctionParams,
      oldComponentsAuctionParams = defaultOldComponentsAuctionParams,
      shouldLockSetToken = defaultShouldLockSetToken,
      rebalanceDuration = defaultDuration,
      initialPositionMultiplier = defaultPositionMultiplier
    ) => {
      await auctionModule.startRebalance(
        setTokenAddress,
        quoteAsset,
        newComponents,
        newComponentsAuctionParams,
        oldComponentsAuctionParams,
        shouldLockSetToken,
        rebalanceDuration,
        initialPositionMultiplier
      );
    };

    const fundBidder = async (
      asset: WETH9 | StandardTokenMock = setup.weth,
      amount: BigNumber = ether(0.45)
    ) => {
      await asset.connect(owner.wallet).transfer(bidder.address, amount);
      await asset.connect(bidder.wallet).approve(auctionModule.address, amount);
    };

    const bid = async (
      setToken: SetToken,
      component: WETH9 | StandardTokenMock = setup.weth,
      componentAmount: BigNumber = ether(900),
      quoteAssetLimit: BigNumber = ether(0.45)
    ) => {
      await auctionModule.connect(bidder.wallet).bid(setToken.address, component.address, componentAmount, quoteAssetLimit);
    };

    describe("#startRebalance", async () => {
      let subjectQuoteAsset: Address;
      let subjectNewComponents: Address[];
      let subjectNewComponentsAuctionParams: AuctionExecutionParams[];
      let subjectOldComponentsAuctionParams: AuctionExecutionParams[];
      let subjectShouldLockSetToken: boolean;
      let subjectDuration: BigNumber;
      let subjectPositionMultiplier: BigNumber;

      beforeEach(async () => {
        const daiPrice = ether(0.0005);
        const wbtcPrice = ether(14.5).mul(wbtcPerWethDecimalFactor);
        const wethPrice = ether(1);

        subjectSetToken = indexWithQuoteAsset;
        subjectCaller = owner;

        subjectQuoteAsset = setup.weth.address;
        subjectShouldLockSetToken = false;

        subjectDuration = ONE_DAY_IN_SECONDS.mul(5);
        subjectPositionMultiplier = await subjectSetToken.positionMultiplier();

        subjectOldComponentsAuctionParams = [
          {
            targetUnit: ether(9100),
            priceAdapterName: AdapterNames.CONSTANT_PRICE_ADAPTER,
            priceAdapterConfigData: await constantPriceAdapter.getEncodedData(daiPrice)
          },
          {
            targetUnit: bitcoin(.6),
            priceAdapterName: AdapterNames.CONSTANT_PRICE_ADAPTER,
            priceAdapterConfigData: await constantPriceAdapter.getEncodedData(wbtcPrice)
          },
          {
            targetUnit: ether(4),
            priceAdapterName: AdapterNames.CONSTANT_PRICE_ADAPTER,
            priceAdapterConfigData: await constantPriceAdapter.getEncodedData(wethPrice)
          }
        ];

        subjectNewComponents = [];
        subjectNewComponentsAuctionParams = [];
      });

      async function subject(): Promise<ContractTransaction> {
        return await auctionModule.connect(subjectCaller.wallet).startRebalance(
          subjectSetToken.address,
          subjectQuoteAsset,
          subjectNewComponents,
          subjectNewComponentsAuctionParams,
          subjectOldComponentsAuctionParams,
          subjectShouldLockSetToken,
          subjectDuration,
          subjectPositionMultiplier
        );
      }

      it("should set the auction execution params correctly", async () => {
        await subject();

        const aggregateComponents = [...await subjectSetToken.getComponents(), ...subjectNewComponents];
        const aggregateAuctionParams = [...subjectOldComponentsAuctionParams, ...subjectNewComponentsAuctionParams];

        for (let i = 0; i < aggregateAuctionParams.length; i++) {
          const executionInfo = await auctionModule.executionInfo(subjectSetToken.address, aggregateComponents[i]);
          expect(executionInfo.targetUnit).to.eq(aggregateAuctionParams[i].targetUnit);
          expect(executionInfo.priceAdapterName).to.eq(aggregateAuctionParams[i].priceAdapterName);
          expect(executionInfo.priceAdapterConfigData).to.eq(aggregateAuctionParams[i].priceAdapterConfigData);
        }
      });

      it("should set the rebalance info correctly", async () => {
        const txnTimestamp = await getTransactionTimestamp(subject());

        const rebalanceInfo = await auctionModule.rebalanceInfo(subjectSetToken.address);

        expect(rebalanceInfo.quoteAsset).to.eq(subjectQuoteAsset);
        expect(rebalanceInfo.rebalanceStartTime).to.eq(txnTimestamp);
        expect(rebalanceInfo.rebalanceDuration).to.eq(subjectDuration);
        expect(rebalanceInfo.positionMultiplier).to.eq(subjectPositionMultiplier);
        expect(rebalanceInfo.raiseTargetPercentage).to.eq(ZERO);

        const rebalanceComponents = await auctionModule.getRebalanceComponents(subjectSetToken.address);
        const aggregateComponents = [...await subjectSetToken.getComponents(), ...subjectNewComponents];

        for (let i = 0; i < rebalanceComponents.length; i++) {
          expect(rebalanceComponents[i]).to.eq(aggregateComponents[i]);
        }
      });

      it("emits the correct RebalanceStarted event", async () => {
        const expectedAggregateComponents = [...await subjectSetToken.getComponents(), ...subjectNewComponents];
        const expectedAggregateComponentsAuctionParams = [...subjectOldComponentsAuctionParams, ...subjectNewComponentsAuctionParams];

        const tx = await subject();
        const receipt = await tx.wait();
        const rebalanceEvent = receipt.events?.find(e => e.event === "RebalanceStarted");

        expect(rebalanceEvent, "RebalanceStarted event not found").to.exist;

        expect(rebalanceEvent?.args?.setToken).to.eq(subjectSetToken.address);
        expect(rebalanceEvent?.args?.quoteAsset).to.eq(subjectQuoteAsset);
        expect(rebalanceEvent?.args?.isSetTokenLocked).to.eq(subjectShouldLockSetToken);
        expect(rebalanceEvent?.args?.rebalanceDuration).to.eq(subjectDuration);
        expect(rebalanceEvent?.args?.initialPositionMultiplier).to.eq(subjectPositionMultiplier);
        expect(rebalanceEvent?.args?.componentsInvolved).to.deep.eq(expectedAggregateComponents);

        for (let i = 0; i < expectedAggregateComponentsAuctionParams.length; i++) {
          const { targetUnit, priceAdapterName, priceAdapterConfigData } = rebalanceEvent?.args?.auctionParameters[i];
          expect(targetUnit).to.eq(expectedAggregateComponentsAuctionParams[i].targetUnit);
          expect(priceAdapterName).to.eq(expectedAggregateComponentsAuctionParams[i].priceAdapterName);
          expect(priceAdapterConfigData).to.eq(expectedAggregateComponentsAuctionParams[i].priceAdapterConfigData);
        }
      });

      describe("when an old component is missing Auction Execution Params", async () => {
        beforeEach(async () => {
          subjectOldComponentsAuctionParams = subjectOldComponentsAuctionParams.slice(0, 1);
        });

        it("should revert with 'Old components and params length mismatch'", async () => {
          await expect(subject()).to.be.revertedWith("Old components and params length mismatch");
        });
      });

      describe("when there are extra old component Auction Execution Params", async () => {
        beforeEach(async () => {
          subjectOldComponentsAuctionParams = subjectOldComponentsAuctionParams.concat(subjectOldComponentsAuctionParams);
        });

        it("should revert with 'Old components and params length mismatch'", async () => {
          await expect(subject()).to.be.revertedWith("Old components and params length mismatch");
        });
      });

      describe("when there are external positions for an old component", async () => {
        let firstComponent: Address;

        beforeEach(async () => {
          const components = await subjectSetToken.getComponents();
          firstComponent = components[0];
          await subjectSetToken.connect(positionModule.wallet).addExternalPositionModule(
            firstComponent,
            positionModule.address
          );
        });

        afterEach(async () => {
          await subjectSetToken.connect(positionModule.wallet).removeExternalPositionModule(
            firstComponent,
            positionModule.address
          );
        });

        it("should revert with 'External positions not allowed'", async () => {
          await expect(subject()).to.be.revertedWith("External positions not allowed");
        });
      });

      describe("when an invalid price adapter name is provided for an old component", async () => {
        beforeEach(async () => {
          const invalidAuctionExecutionParams = {
            targetUnit: ether(9100),
            priceAdapterName: "INVALID_ADAPTER_NAME",
            priceAdapterConfigData: ZERO_BYTES
          } as AuctionExecutionParams;

          subjectOldComponentsAuctionParams = [
            invalidAuctionExecutionParams,
            ...subjectOldComponentsAuctionParams.slice(1,3)
          ];
        });

        it("should revert with 'Must be valid adapter'", async () => {
          await expect(subject()).to.be.revertedWith("Must be valid adapter");
        });
      });

      describe("when invalid price adapter config data is passed for an old component", async () => {
        beforeEach(async () => {
          const invalidAdapterConfigData = await constantPriceAdapter.getEncodedData(ether(0));
          const invalidAuctionExecutionParams = {
            targetUnit: ether(9100),
            priceAdapterName: AdapterNames.CONSTANT_PRICE_ADAPTER,
            priceAdapterConfigData: invalidAdapterConfigData
          } as AuctionExecutionParams;

          subjectOldComponentsAuctionParams = [
            invalidAuctionExecutionParams,
            ...subjectOldComponentsAuctionParams.slice(1,3)
          ];
        });

        it("should revert with 'Price adapter config data invalid'", async () => {
          await expect(subject()).to.be.revertedWith("Price adapter config data invalid");
        });
      });

      describe("when the SetToken should be locked", async () => {
        beforeEach(async () => {
          subjectShouldLockSetToken = true;
        });

        afterEach(() => {
          subjectShouldLockSetToken = false;
        });

        it("locks the SetToken and prevents issuance, redemption, and fee collection", async () => {
          await subject();

          const isLocked = await subjectSetToken.isLocked();
          expect(isLocked).to.be.true;

          const locker = await subjectSetToken.locker();
          expect(locker).to.eq(auctionModule.address);

          const errorMsg = "When locked, only the locker can call";

          // Verify that issuance is not allowed
          await expect(setup.approveAndIssueSetToken(subjectSetToken, ether(1)))
            .to.be.revertedWith(errorMsg);

          // Verify that redemption is not allowed
          await expect(setup.issuanceModule.connect(owner.wallet).redeem(subjectSetToken.address, ether(1), owner.address))
            .to.be.revertedWith(errorMsg);

          // Verify that collecting streaming fees is not allowed
          await expect(setup.streamingFeeModule.accrueFee(subjectSetToken.address))
            .to.be.revertedWith(errorMsg);
        });

        describe("when the SetToken is already locked by the Auction Module", () => {
          beforeEach(async () => {
            await subject();

            const isLocked = await subjectSetToken.isLocked();
            const locker = await subjectSetToken.locker();

            expect(isLocked).to.be.true;
            expect(locker).to.eq(auctionModule.address);
          });

          it("succeeds without reverting", async () => {
            await subject();
          });
        });

        describe("when the SetToken is already locked by another Module", () => {
          beforeEach(async () => {
            const otherLockerModule = await deployer.modules.deployAuctionRebalanceModuleV1(setup.controller.address);

            await setup.controller.addModule(otherLockerModule.address);
            await setup.integrationRegistry.addIntegration(
              otherLockerModule.address,
              AdapterNames.CONSTANT_PRICE_ADAPTER,
              constantPriceAdapter.address
            );
            await indexWithQuoteAsset.addModule(otherLockerModule.address);
            await otherLockerModule.initialize(indexWithQuoteAsset.address);

            await otherLockerModule.startRebalance(
              subjectSetToken.address,
              subjectQuoteAsset,
              subjectNewComponents,
              subjectNewComponentsAuctionParams,
              subjectOldComponentsAuctionParams,
              subjectShouldLockSetToken,
              subjectDuration,
              subjectPositionMultiplier
            );

            const isLocked = await subjectSetToken.isLocked();
            const locker = await subjectSetToken.locker();

            expect(isLocked).to.be.true;
            expect(locker).to.eq(otherLockerModule.address);
          });

          it("should revert with 'Must not be locked'", async () => {
            await expect(subject()).to.be.revertedWith("Must not be locked");
          });
        });
      });

      describe("when adding new components via the auction", async () => {
        beforeEach(async () => {
          const usdcPerWethDecimalFactor = ether(1).div(usdc(1));
          const usdcPerWethPrice = ether(0.0005).mul(usdcPerWethDecimalFactor);
          const usdcPerWethBytes = await constantPriceAdapter.getEncodedData(usdcPerWethPrice);
          const indexUsdcAuctionExecutionParams = {
            targetUnit: usdc(100),
            priceAdapterName: AdapterNames.CONSTANT_PRICE_ADAPTER,
            priceAdapterConfigData: usdcPerWethBytes
          } as AuctionExecutionParams;

          subjectNewComponents = [setup.usdc.address];
          subjectNewComponentsAuctionParams = [indexUsdcAuctionExecutionParams];
        });

        it("should set the auction execution params correctly", async () => {
          await subject();

          const aggregateComponents = [...await subjectSetToken.getComponents(), ...subjectNewComponents];
          const aggregateAuctionParams = [...subjectOldComponentsAuctionParams, ...subjectNewComponentsAuctionParams];

          for (let i = 0; i < aggregateAuctionParams.length; i++) {
            const { targetUnit, priceAdapterName, priceAdapterConfigData } = await auctionModule.executionInfo(
              subjectSetToken.address,
              aggregateComponents[i]
            );

            expect(targetUnit).to.be.eq(aggregateAuctionParams[i].targetUnit);
            expect(priceAdapterName).to.be.eq(aggregateAuctionParams[i].priceAdapterName);
            expect(priceAdapterConfigData).to.be.eq(aggregateAuctionParams[i].priceAdapterConfigData);
          }
        });

        it("emits the correct RebalanceStarted event", async () => {
          const currentComponents = await subjectSetToken.getComponents();
          const expectedAggregateComponents = [...currentComponents, ...subjectNewComponents];
          const expectedAggregateComponentsAuctionParams = [...subjectOldComponentsAuctionParams, ...subjectNewComponentsAuctionParams];

          // Execute the transaction
          const tx = await subject();
          const receipt = await tx.wait();

          // Find the RebalanceStarted event in the receipt
          const rebalanceEvent = receipt.events?.find(e => e.event === "RebalanceStarted");

          // Ensure that the RebalanceStarted event is present
          expect(rebalanceEvent, "RebalanceStarted event not found").to.exist;

          // Assert individual components of the event
          expect(rebalanceEvent?.args?.setToken).to.eq(subjectSetToken.address);
          expect(rebalanceEvent?.args?.quoteAsset).to.eq(subjectQuoteAsset);
          expect(rebalanceEvent?.args?.isSetTokenLocked).to.eq(subjectShouldLockSetToken);
          expect(rebalanceEvent?.args?.rebalanceDuration).to.eq(subjectDuration);
          expect(rebalanceEvent?.args?.initialPositionMultiplier).to.eq(subjectPositionMultiplier);
          expect(rebalanceEvent?.args?.componentsInvolved).to.deep.eq(expectedAggregateComponents);

          // Assert auction parameters
          for (let i = 0; i < expectedAggregateComponentsAuctionParams.length; i++) {
            const { targetUnit, priceAdapterName, priceAdapterConfigData } = rebalanceEvent?.args?.auctionParameters[i];
            expect(targetUnit).to.eq(expectedAggregateComponentsAuctionParams[i].targetUnit);
            expect(priceAdapterName).to.eq(expectedAggregateComponentsAuctionParams[i].priceAdapterName);
            expect(priceAdapterConfigData).to.eq(expectedAggregateComponentsAuctionParams[i].priceAdapterConfigData);
          }
        });

        describe("newComponents and newComponentsAuctionParams are not of same length", async () => {
          describe("when newComponents is zero length", async () => {
            beforeEach(async () => {
              subjectNewComponents = [];
            });
            it("should revert with 'New components and params length mismatch'", async () => {
              await expect(subject()).to.be.revertedWith("New components and params length mismatch");
            });
          });

          describe("when newComponentsAuctionParams is zero length", async () => {
            beforeEach(async () => {
              subjectNewComponentsAuctionParams = [];
            });
            it("should revert with 'New components and params length mismatch'", async () => {
              await expect(subject()).to.be.revertedWith("New components and params length mismatch");
            });
          });

          describe("when newComponents is longer than newComponentsAuctionParams", async () => {
            beforeEach(async () => {
              subjectNewComponents = [setup.usdc.address, indexWithoutQuoteAsset.address];
            });
            it("should revert with 'New components and params length mismatch'", async () => {
              await expect(subject()).to.be.revertedWith("New components and params length mismatch");
            });
          });

          describe("when newComponentsAuctionParams is longer than newComponents", async () => {
            beforeEach(async () => {
              subjectNewComponentsAuctionParams = subjectNewComponentsAuctionParams.concat(subjectNewComponentsAuctionParams);
            });
            it("should revert with 'New components and params length mismatch'", async () => {
              await expect(subject()).to.be.revertedWith("New components and params length mismatch");
            });
          });
        });

        describe("when newComponents target unit is equal to zero", async () => {
          beforeEach(async () => {
            const usdcPerWethDecimalFactor = ether(1).div(usdc(1));
            const usdcPerWethPrice = ether(0.0005).mul(usdcPerWethDecimalFactor);
            const usdcPerWethBytes = await constantPriceAdapter.getEncodedData(usdcPerWethPrice);

            subjectNewComponentsAuctionParams = [{
              targetUnit: ZERO,
              priceAdapterName: AdapterNames.CONSTANT_PRICE_ADAPTER,
              priceAdapterConfigData: usdcPerWethBytes
            }];
          });

          it("should revert with 'New component target unit must be greater than 0'", async () => {
            await expect(subject()).to.be.revertedWith("New component target unit must be greater than 0");
          });
        });

        describe("when an invalid price adapter name is passed for a new component", async () => {
          beforeEach(async () => {
            subjectNewComponentsAuctionParams = [{
              targetUnit: usdc(100),
              priceAdapterName: "INVALID_ADAPTER_NAME",
              priceAdapterConfigData: ZERO_BYTES
            }];
          });

          it("should revert with 'Must be valid adapter'", async () => {
            await expect(subject()).to.be.revertedWith("Must be valid adapter");
          });
        });

        describe("when invalid price adapter config data is passed for a new component", async () => {
          beforeEach(async () => {
            const invalidAdapterConfigData = await constantPriceAdapter.getEncodedData(ZERO);

            subjectNewComponentsAuctionParams = [{
              targetUnit: usdc(100),
              priceAdapterName: AdapterNames.CONSTANT_PRICE_ADAPTER,
              priceAdapterConfigData: invalidAdapterConfigData
            }];
          });

          it("should revert with 'Price adapter config data invalid'", async () => {
            await expect(subject()).to.be.revertedWith("Price adapter config data invalid");
          });
        });

        describe("when newComponents contains an old component", async () => {
          beforeEach(async () => {
            subjectNewComponents = [setup.wbtc.address];
          });

          it("should revert with 'Cannot have duplicate components'", async () => {
            await expect(subject()).to.be.revertedWith("Cannot have duplicate components");
          });
        });
      });
    });

    describe("#isRebalanceDurationElapsed", async () => {
      let subjectIncreaseTime: BigNumber;
      let subjectSetTokenAddress: Address;

      beforeEach(async () => {
        await startRebalance();
        subjectSetToken = indexWithQuoteAsset;
        subjectSetTokenAddress = subjectSetToken.address;

        subjectIncreaseTime = ZERO;
      });

      async function subject(setTokenAddress: Address): Promise<any> {
        await increaseTimeAsync(subjectIncreaseTime);
        return await auctionModule.isRebalanceDurationElapsed(setTokenAddress);
      }

      it("should return false if the rebalance duration has not elapsed", async () => {
        const isElapsed = await subject(subjectSetTokenAddress);

        expect(isElapsed).to.be.false;
      });

      describe("when the rebalance duration has elapsed", async () => {
        beforeEach(async () => {
          subjectIncreaseTime = defaultDuration.add(1);
        });

        it("should return true", async () => {
          const isElapsed = await subject(subjectSetTokenAddress);

          expect(isElapsed).to.be.true;
        });
      });
    });

    describe("#getRebalanceComponents", async () => {
      let subjectSetTokenAddress: Address;

      beforeEach(async () => {
        await startRebalance();
        subjectSetToken = indexWithQuoteAsset;
        subjectSetTokenAddress = subjectSetToken.address;
      });

      async function subject(setTokenAddress: Address): Promise<any> {
        return await auctionModule.getRebalanceComponents(setTokenAddress);
      }

      it("should return the components being rebalanced", async () => {
        const expectedComponents = [setup.dai.address, setup.wbtc.address, setup.weth.address];

        const rebalanceComponents = await subject(subjectSetTokenAddress);

        expect(rebalanceComponents).to.deep.eq(expectedComponents);
      });

      describe("when set token is not valid", async () => {
        it("should revert with 'Must be a valid and initialized SetToken'", async () => {
          await expect(subject(ADDRESS_ZERO)).to.be.revertedWith("Must be a valid and initialized SetToken");
        });
      });
    });

    describe("#getAuctionSizeAndDirection", async () => {
      let totalSupply: BigNumber;

      let subjectSetTokenAddress: Address;
      let subjectComponent: Address;

      beforeEach(async () => {
        await startRebalance();
        totalSupply = await indexWithQuoteAsset.totalSupply();

        subjectSetToken = indexWithQuoteAsset;
        subjectSetTokenAddress = subjectSetToken.address;
        subjectComponent = setup.dai.address;
      });

      async function subject(): Promise<any> {
        return await auctionModule.getAuctionSizeAndDirection(
          subjectSetTokenAddress,
          subjectComponent
        );
      }

      it("returns correct auction size and confirms it's a sell auction", async () => {
        const expectedDaiSize = preciseMul(ether(900), totalSupply);

        const [isSellAuction, componentQuantity] = await subject();

        expect(componentQuantity).to.eq(expectedDaiSize);
        expect(isSellAuction).to.be.true;
      });

      describe("when it's a buy auction", async () => {
        beforeEach(() => {
          subjectComponent = setup.wbtc.address;
        });

        it("returns correct auction size and confirms it's not a sell auction", async () => {
          const expectedWbtcSize = preciseMul(bitcoin(0.1), totalSupply);

          const [isSellAuction, componentQuantity] = await subject();

          expect(componentQuantity).to.eq(expectedWbtcSize);
          expect(isSellAuction).to.be.false;
        });
      });

      describe("when there is a protocol fee charged", async () => {
        let feePercentage: BigNumber;

        beforeEach(async () => {
          feePercentage = ether(0.005);
          setup.controller = setup.controller.connect(owner.wallet);
          await setup.controller.addFee(auctionModule.address, ZERO, feePercentage);
        });

        it("returns the unchanged auction size for a sell auction", async () => {
          const expectedDaiSize = preciseMul(ether(900), totalSupply);

          const [isSellAuction, componentQuantity] = await subject();

          expect(componentQuantity).to.eq(expectedDaiSize);
          expect(isSellAuction).to.be.true;
        });

        describe("when it's a buy auction", () => {
          beforeEach(() => {
            subjectComponent = setup.wbtc.address;
          });

          it("returns the changed auction size", async () => {
            const expectedWbtcSize = preciseDiv(preciseMul(bitcoin(0.1), totalSupply), PRECISE_UNIT.sub(feePercentage));

            const [isSellAuction, componentQuantity] = await subject();

            expect(componentQuantity).to.eq(expectedWbtcSize);
            expect(isSellAuction).to.be.false;
          });
        });
      });

      describe("when the setToken is not valid", async () => {
        beforeEach(() => {
          subjectSetTokenAddress = ADDRESS_ZERO;
        });

        it("should revert with 'Must be a valid and initialized SetToken'", async () => {
          expect(subject()).to.be.revertedWith("Must be a valid and initialized SetToken");
        });
      });

      describe("when the component is not part of the rebalance", async () => {
        beforeEach(() => {
          subjectComponent = setup.usdc.address;
        });

        it("should revert with 'Component not part of rebalance'", async () => {
          expect(subject()).to.be.revertedWith("Component not part of rebalance");
        });
      });
    });

    describe("#getQuoteAssetBalance", async () => {
      let subjectSetTokenAddress: Address;

      beforeEach(async () => {
        await startRebalance();
        subjectSetTokenAddress = subjectSetToken.address;
      });

      async function subject(setTokenAddress: Address): Promise<any> {
        return await auctionModule.getQuoteAssetBalance(setTokenAddress);
      }

      it("should return the correct quote asset balance", async () => {
        const quoteAssetBalance = await subject(subjectSetTokenAddress);

        expect(quoteAssetBalance).to.eq(ether(5));
      });
    });

    describe("#getBidPreview", async () => {
      let subjectComponent: Address;
      let subjectComponentQuantity: BigNumber;
      let subjectQuoteAssetLimit: BigNumber;

      beforeEach(async () => {
        await startRebalance();

        subjectSetToken = indexWithQuoteAsset;
        subjectComponent = setup.dai.address;
        subjectComponentQuantity = ether(900);
        subjectQuoteAssetLimit = ether(0.45);
      });

      async function subject(): Promise<any> {
        return await auctionModule.getBidPreview(
          subjectSetToken.address,
          subjectComponent,
          subjectComponentQuantity,
          subjectQuoteAssetLimit
        );
      }

      it("should return correct bid info", async () => {
        const [
          setToken,
          sendToken,
          receiveToken,
          priceAdapter,
          priceAdapterConfigData,
          isSellAuction,
          auctionQuantity,
          componentPrice,
          quantitySentBySet,
          quantityReceivedBySet,
          preBidTokenSentBalance,
          preBidTokenReceivedBalance,
          setTotalSupply,
        ] = await subject();

        expect(setToken).to.eq(subjectSetToken.address);
        expect(sendToken).to.eq(subjectComponent);
        expect(receiveToken).to.eq(setup.weth.address);
        expect(priceAdapter).to.eq(constantPriceAdapter.address);
        expect(priceAdapterConfigData).to.eq(defaultDaiData);
        expect(isSellAuction).to.be.true;
        expect(auctionQuantity).to.eq(ether(900));
        expect(componentPrice).to.eq(defaultDaiPrice);
        expect(quantitySentBySet).to.eq(subjectComponentQuantity);
        expect(quantityReceivedBySet).to.eq(subjectQuoteAssetLimit);
        expect(preBidTokenSentBalance).to.eq(ether(10000));
        expect(preBidTokenReceivedBalance).to.eq(ether(5));
        expect(setTotalSupply).to.eq(ether(1));
      });

      describe("when it is a buy auction", async () => {
        beforeEach(async () => {
          subjectComponent = setup.wbtc.address;
          subjectComponentQuantity = bitcoin(0.1);
          subjectQuoteAssetLimit = ether(1.45);
        });

        it("should return correct bid info", async () => {
          const [
            setToken,
            sendToken,
            receiveToken,
            priceAdapter,
            priceAdapterConfigData,
            isSellAuction,
            auctionQuantity,
            componentPrice,
            quantitySentBySet,
            quantityReceivedBySet,
            preBidTokenSentBalance,
            preBidTokenReceivedBalance,
            setTotalSupply,
          ] = await subject();

          expect(setToken).to.eq(subjectSetToken.address);
          expect(sendToken).to.eq(setup.weth.address);
          expect(receiveToken).to.eq(subjectComponent);
          expect(priceAdapter).to.eq(constantPriceAdapter.address);
          expect(priceAdapterConfigData).to.eq(defaultWbtcData);
          expect(isSellAuction).to.be.false;
          expect(auctionQuantity).to.eq(bitcoin(0.1));
          expect(componentPrice).to.eq(defaultWbtcPrice);
          expect(quantitySentBySet).to.eq(subjectQuoteAssetLimit);
          expect(quantityReceivedBySet).to.eq(subjectComponentQuantity);
          expect(preBidTokenSentBalance).to.eq(ether(5));
          expect(preBidTokenReceivedBalance).to.eq(bitcoin(0.5));
          expect(setTotalSupply).to.eq(ether(1));
        });
      });
    });

    describe("#canUnlockEarly", async () => {
      let subjectSetTokenAddress: Address;

      beforeEach(async () => {
        await startRebalance(
          indexWithQuoteAsset.address,
          defaultQuoteAsset,
          defaultNewComponents,
          defaultNewComponentsAuctionParams,
          defaultOldComponentsAuctionParams,
          true, // lock set token
          defaultDuration,
          defaultPositionMultiplier
        );

        await fundBidder(setup.weth, ether(0.45));
        await bid(indexWithQuoteAsset, setup.dai, ether(900), ether(0.45));

        await fundBidder(setup.wbtc, bitcoin(0.1));
        await bid(indexWithQuoteAsset, setup.wbtc, bitcoin(0.1), ether(1.45));

        subjectSetToken = indexWithQuoteAsset;
        subjectSetTokenAddress = subjectSetToken.address;
      });

      async function subject(setTokenAddress: Address): Promise<any> {
        return await auctionModule.canUnlockEarly(setTokenAddress);
      }

      it("should return true when the Set Token can be unlocked early", async () => {
        const canUnlock = await subject(subjectSetTokenAddress);

        expect(canUnlock).to.be.true;
      });

      describe("when the Set Token can not be unlocked early", async () => {
        beforeEach(async () => {
          await auctionModule.connect(owner.wallet).setRaiseTargetPercentage(subjectSetTokenAddress, ether(0.01));
        });

        it("should return false", async () => {
          const canUnlock = await subject(subjectSetTokenAddress);

          expect(canUnlock).to.be.false;
        });
      });
    });

    describe("#canRaiseAssetTargets", async () => {
      let oldComponentsAuctionParams: AuctionExecutionParams[];

      let subjectSetTokenAddress: Address;

      beforeEach(async () => {
        oldComponentsAuctionParams = [
          {
            targetUnit: ether(9100),
            priceAdapterName: AdapterNames.CONSTANT_PRICE_ADAPTER,
            priceAdapterConfigData: defaultDaiData
          },
          {
            targetUnit: bitcoin(.54),
            priceAdapterName: AdapterNames.CONSTANT_PRICE_ADAPTER,
            priceAdapterConfigData: defaultWbtcData
          },
          {
            targetUnit: ether(4),
            priceAdapterName: AdapterNames.CONSTANT_PRICE_ADAPTER,
            priceAdapterConfigData: defaultWethData
          }
        ];

        subjectSetToken = indexWithQuoteAsset;
        subjectSetTokenAddress = subjectSetToken.address;

        await startRebalance(
          subjectSetToken.address,
          defaultQuoteAsset,
          defaultNewComponents,
          defaultNewComponentsAuctionParams,
          oldComponentsAuctionParams,
          defaultShouldLockSetToken,
          defaultDuration,
          defaultPositionMultiplier
        );

        await auctionModule.connect(owner.wallet).setRaiseTargetPercentage(subjectSetToken.address, ether(.0025));

        await fundBidder(setup.weth, ether(0.45));
        await bid(subjectSetToken, setup.dai, ether(900), ether(0.45));
      });

      async function subject(setTokenAddress: Address): Promise<any> {
        return await auctionModule.canRaiseAssetTargets(setTokenAddress);
      }

      it("should return false when the asset targets cannot be raised", async () => {
        const canRaiseTargets = await subject(subjectSetTokenAddress);

        expect(canRaiseTargets).to.be.false;
      });

      describe("when the asset targets cannot be raised", async () => {
        beforeEach(async () => {
          await fundBidder(setup.wbtc, bitcoin(0.04));
          await bid(subjectSetToken, setup.wbtc, bitcoin(0.04), ether(0.58));
        });

        it("should return true", async () => {
          const canUnlock = await subject(subjectSetTokenAddress);

          expect(canUnlock).to.be.true;
        });
      });
    });

    describe("#allTargetsMet", async () => {
      let subjectSetTokenAddress: Address;

      beforeEach(async () => {
        await startRebalance();

        await fundBidder(setup.weth, ether(0.45));
        await bid(indexWithQuoteAsset, setup.dai, ether(900), ether(0.45));

        subjectSetToken = indexWithQuoteAsset;
        subjectSetTokenAddress = subjectSetToken.address;
      });

      async function subject(setTokenAddress: Address): Promise<any> {
        return await auctionModule.allTargetsMet(setTokenAddress);
      }

      it("should return false when all targets not met", async () => {
        const targetsMet = await subject(subjectSetTokenAddress);

        expect(targetsMet).to.be.false;
      });

      describe("when the targets are met", async () => {
        beforeEach(async () => {
          await fundBidder(setup.wbtc, bitcoin(0.1));
          await bid(indexWithQuoteAsset, setup.wbtc, bitcoin(0.1), ether(1.45));
        });

        it("should return true", async () => {
          const targetsMet = await subject(subjectSetTokenAddress);

          expect(targetsMet).to.be.true;
        });
      });
    });

    describe("#isQuoteAssetExcessOrAtTarget", async () => {
      let subjectSetTokenAddress: Address;

      beforeEach(async () => {
        await startRebalance();

        subjectSetToken = indexWithQuoteAsset;
        subjectSetTokenAddress = subjectSetToken.address;
      });

      async function subject(setTokenAddress: Address): Promise<any> {
        return await auctionModule.isQuoteAssetExcessOrAtTarget(setTokenAddress);
      }

      it("should return true when the quote asset is in excess", async () => {
        const inExcess = await subject(subjectSetTokenAddress);

        expect(inExcess).to.be.true;
      });

      describe("when the quote asset is at target", async () => {
        beforeEach(async () => {
          await fundBidder(setup.weth, ether(0.45));
          await bid(indexWithQuoteAsset, setup.dai, ether(900), ether(0.45));

          await fundBidder(setup.wbtc, bitcoin(0.1));
          await bid(indexWithQuoteAsset, setup.wbtc, bitcoin(0.1), ether(1.45));
        });

        it("should return true", async () => {
          const inExcess = await subject(subjectSetTokenAddress);

          expect(inExcess).to.be.true;
        });
      });

      describe("when the quote asset is under the target", async () => {
        beforeEach(async () => {
          await fundBidder(setup.wbtc, bitcoin(0.1));
          await bid(indexWithQuoteAsset, setup.wbtc, bitcoin(0.1), ether(1.45));
        });

        it("should return false", async () => {
          const inExcess = await subject(subjectSetTokenAddress);

          expect(inExcess).to.be.false;
        });
      });
    });

    describe("#isAllowedBidder", async () => {
      let subjectBidders: Address[];
      let subjectStatuses: boolean[];

      beforeEach(async () => {
        subjectCaller = owner;
        subjectSetToken = indexWithQuoteAsset;
        subjectBidders = [bidder.address];
        subjectStatuses = [true];

        return await auctionModule.connect(subjectCaller.wallet).setBidderStatus(
          subjectSetToken.address,
          subjectBidders,
          subjectStatuses
        );
      });

      async function subject(): Promise<Boolean> {
        return await auctionModule.connect(subjectCaller.wallet).isAllowedBidder(
          subjectSetToken.address,
          subjectBidders[0],
        );
      }

      it("should return true if the address is an allowed bidder", async () => {
        const isBidder = await subject();

        expect(isBidder).to.be.true;
      });

      it("should return false if the address is not an allowed bidder", async () => {
        // Setting the bidder status to false
        subjectStatuses = [false];
        await auctionModule.connect(subjectCaller.wallet).setBidderStatus(
          subjectSetToken.address,
          subjectBidders,
          subjectStatuses
        );

        const isBidder = await subject();

        expect(isBidder).to.be.false;
      });

      describe("when the setToken is not valid", async () => {
        beforeEach(() => {
          subjectSetToken = { address: ADDRESS_ZERO } as SetToken;
        });

        it("should revert with 'Must be a valid and initialized SetToken'", async () => {
          expect(subject()).to.be.revertedWith("Must be a valid and initialized SetToken");
        });
      });
    });

    describe("#getAllowedBidders", async () => {
      let subjectBidders: Address[];
      let subjectStatuses: boolean[];

      beforeEach(async () => {
        subjectCaller = owner;
        subjectSetToken = indexWithQuoteAsset;
        subjectBidders = [bidder.address];
        subjectStatuses = [true];

        return await auctionModule.connect(subjectCaller.wallet).setBidderStatus(
          subjectSetToken.address,
          subjectBidders,
          subjectStatuses
        );
      });

      async function subject(): Promise<Address[]> {
        return await auctionModule.connect(subjectCaller.wallet).getAllowedBidders(subjectSetToken.address);
      }

      it("should return the addresses of the allowed bidders", async () => {
        const allowedBidders = await subject();

        expect(allowedBidders).to.deep.equal(subjectBidders);
      });

      describe("when the setToken is not valid", async () => {
        beforeEach(() => {
          subjectSetToken = { address: ADDRESS_ZERO } as SetToken;
        });

        it("should revert with 'Must be a valid and initialized SetToken'", async () => {
          expect(subject()).to.be.revertedWith("Must be a valid and initialized SetToken");
        });
      });
    });

    describe("#setBidderStatus", async () => {
      let subjectBidders: Address[];
      let subjectStatuses: boolean[];

      beforeEach(async () => {
        subjectCaller = owner;
        subjectSetToken = indexWithQuoteAsset;
        subjectBidders = [bidder.address, await getRandomAddress(), await getRandomAddress()];
        subjectStatuses = [true, true, true];
      });

      async function subject(): Promise<ContractTransaction> {
        return await auctionModule.connect(subjectCaller.wallet).setBidderStatus(
          subjectSetToken.address,
          subjectBidders,
          subjectStatuses
        );
      }

      it("should set the bidder status to true for multiple bidders", async () => {
        await subject();

        const isBidderOne = await auctionModule.isAllowedBidder(subjectSetToken.address, subjectBidders[0]);
        const isBidderTwo = await auctionModule.isAllowedBidder(subjectSetToken.address, subjectBidders[1]);
        const isBidderThree = await auctionModule.isAllowedBidder(subjectSetToken.address, subjectBidders[2]);

        expect(isBidderOne).to.be.true;
        expect(isBidderTwo).to.be.true;
        expect(isBidderThree).to.be.true;
      });

      it("should emit a BidderStatusUpdated event", async () => {
        await expect(subject()).to.emit(auctionModule, "BidderStatusUpdated").withArgs(
          subjectSetToken.address,
          subjectBidders[0],
          true
        );
      });

      describe("when de-authorizing a bidder", async () => {
        beforeEach(async () => {
          await subject();
          subjectStatuses = [false, true, true];
        });

        it("should set the bidder status to false for the de-authorized bidder", async () => {
          const initialStatus = await auctionModule.isAllowedBidder(subjectSetToken.address, subjectBidders[0]);
          expect(initialStatus).to.be.true;

          await subject();

          const finalStatus = await auctionModule.isAllowedBidder(subjectSetToken.address, subjectBidders[0]);
          expect(finalStatus).to.be.false;
        });

        it("should update the biddersHistory correctly", async () => {
          const initialBidders = await auctionModule.getAllowedBidders(subjectSetToken.address);
          expect(initialBidders).to.deep.equal(subjectBidders);

          await subject();

          const finalBidders = await auctionModule.getAllowedBidders(subjectSetToken.address);
          const expectedBidders = subjectBidders.slice(1);

          expect(expectedBidders[0]).to.not.equal(expectedBidders[1]);
          expect(finalBidders[0]).to.not.equal(finalBidders[1]);

          expect(finalBidders.includes(expectedBidders[0])).to.be.true;
          expect(finalBidders.includes(expectedBidders[1])).to.be.true;
        });
      });

      describe("when array lengths don't match", async () => {
        beforeEach(async () => {
          subjectBidders = [bidder.address, await getRandomAddress()];
          subjectStatuses = [false];
        });

        it("should revert with 'Array length mismatch'", async () => {
          await expect(subject()).to.be.revertedWith("Array length mismatch");
        });
      });

      describe("when bidders are duplicated", async () => {
        beforeEach(async () => {
          subjectBidders = [bidder.address, bidder.address, await getRandomAddress()];
        });

        it("should revert with 'Cannot duplicate addresses'", async () => {
          await expect(subject()).to.be.revertedWith("Cannot duplicate addresses");
        });
      });

      describe("when arrays are empty", async () => {
        beforeEach(async () => {
          subjectBidders = [];
          subjectStatuses = [];
        });

        it("should revert with 'Array length must be > 0'", async () => {
          await expect(subject()).to.be.revertedWith("Array length must be > 0");
        });
      });

      describe("when the caller is not the manager", async () => {
        beforeEach(async () => {
          subjectCaller = await getRandomAccount();
        });

        it("should revert with 'Must be the SetToken manager'", async () => {
          await expect(subject()).to.be.revertedWith("Must be the SetToken manager");
        });
      });

      describe("when the SetToken has not initialized the module", async () => {
        beforeEach(async () => {
          await setup.controller.removeSet(indexWithQuoteAsset.address);
        });

        it("should revert with 'Must be a valid and initialized SetToken'", async () => {
          await expect(subject()).to.be.revertedWith("Must be a valid and initialized SetToken");
        });
      });
    });

    describe("#setAnyoneBid", async () => {
      let subjectStatus: boolean;

      beforeEach(async () => {
        subjectCaller = owner;
        subjectSetToken = indexWithQuoteAsset;
        subjectStatus = true;
      });

      async function subject(): Promise<ContractTransaction> {
        return await auctionModule.connect(subjectCaller.wallet).setAnyoneBid(
          subjectSetToken.address,
          subjectStatus
        );
      }

      it("should set isAnyoneAllowedToBid to true", async () => {
        await subject();
        const isAnyoneAllowedToBid = await auctionModule.permissionInfo(subjectSetToken.address);
        expect(isAnyoneAllowedToBid).to.be.true;
      });

      it("should emit an AnyoneBidUpdated event", async () => {
        await expect(subject()).to.emit(auctionModule, "AnyoneBidUpdated").withArgs(
          subjectSetToken.address,
          true
        );
      });

      describe("when the caller is not the manager", async () => {
        beforeEach(async () => {
          subjectCaller = await getRandomAccount();
        });

        it("should revert with 'Must be the SetToken manager'", async () => {
          await expect(subject()).to.be.revertedWith("Must be the SetToken manager");
        });
      });

      describe("when the SetToken has not initialized the module", async () => {
        beforeEach(async () => {
          await setup.controller.removeSet(indexWithQuoteAsset.address);
        });

        it("should revert with 'Must be a valid and initialized SetToken'", async () => {
          await expect(subject()).to.be.revertedWith("Must be a valid and initialized SetToken");
        });
      });
    });

    describe("#unlock", async () => {
      let subjectIncreaseTime: BigNumber;

      beforeEach(async () => {
        subjectIncreaseTime = defaultDuration.add(1);
        subjectSetToken = indexWithQuoteAsset;
        subjectCaller = await getRandomAccount();
      });

      async function subject(): Promise<ContractTransaction> {
        await increaseTimeAsync(subjectIncreaseTime);
        return await auctionModule.connect(subjectCaller.wallet).unlock(subjectSetToken.address);
      }

      describe("when the rebalance duration has elapsed", async () => {
        beforeEach(async () => {
          await startRebalance(
            indexWithQuoteAsset.address,
            defaultQuoteAsset,
            defaultNewComponents,
            defaultNewComponentsAuctionParams,
            defaultOldComponentsAuctionParams,
            true, // lock set token
            defaultDuration,
            defaultPositionMultiplier
          );
        });

        it("should unlock the SetToken", async () => {
          const isLockedBefore = await subjectSetToken.isLocked();
          expect(isLockedBefore).to.be.true;

          await subject();

          const isLockedAfter = await subjectSetToken.isLocked();
          expect(isLockedAfter).to.be.false;
        });
      });

      describe("when the rebalance duration has not elapsed, targets are met, and raise target percentage is zero", async () => {
        beforeEach(async () => {
          await startRebalance(
            indexWithQuoteAsset.address,
            defaultQuoteAsset,
            defaultNewComponents,
            defaultNewComponentsAuctionParams,
            defaultOldComponentsAuctionParams,
            true, // lock set token
            defaultDuration,
            defaultPositionMultiplier
          );

          await fundBidder(setup.weth, ether(0.45));
          await bid(indexWithQuoteAsset, setup.dai, ether(900), ether(0.45));

          await fundBidder(setup.wbtc, bitcoin(0.1));
          await bid(indexWithQuoteAsset, setup.wbtc, bitcoin(0.1), ether(1.45));

          subjectIncreaseTime = ONE_HOUR_IN_SECONDS;
        });

        it("should unlock the SetToken", async () => {
          const isLockedBefore = await subjectSetToken.isLocked();
          expect(isLockedBefore).to.be.true;

          await subject();

          const isLockedAfter = await subjectSetToken.isLocked();
          expect(isLockedAfter).to.be.false;
        });

        it("should emit the LockedRebalanceEndedEarly event", async () => {
          await expect(subject()).to.emit(auctionModule, "LockedRebalanceEndedEarly").withArgs(subjectSetToken.address);
        });
      });

      describe("when the rebalance duration has not elapsed, targets are met, but raise target percentage is greater than zero", async () => {
        beforeEach(async () => {
          await startRebalance(
            indexWithQuoteAsset.address,
            defaultQuoteAsset,
            defaultNewComponents,
            defaultNewComponentsAuctionParams,
            defaultOldComponentsAuctionParams,
            true, // lock set token
            defaultDuration,
            defaultPositionMultiplier
          );

          await fundBidder(setup.weth, ether(0.45));
          await bid(indexWithQuoteAsset, setup.dai, ether(900), ether(0.45));

          await fundBidder(setup.wbtc, bitcoin(0.1));
          await bid(indexWithQuoteAsset, setup.wbtc, bitcoin(0.1), ether(1.45));

          await auctionModule.connect(owner.wallet).setRaiseTargetPercentage(subjectSetToken.address, ether(0.0025));

          subjectIncreaseTime = ONE_HOUR_IN_SECONDS;
        });

        it("should revert with 'Cannot unlock early unless all targets are met and raiseTargetPercentage is zero'", async () => {
          await expect(subject()).to.be.revertedWith("Cannot unlock early unless all targets are met and raiseTargetPercentage is zero");
        });
      });

      describe("when the rebalance duration has not elapsed, raise target percentage is zero, but sell auction target not met", async () => {
        beforeEach(async () => {
          await startRebalance(
            indexWithQuoteAsset.address,
            defaultQuoteAsset,
            defaultNewComponents,
            defaultNewComponentsAuctionParams,
            defaultOldComponentsAuctionParams,
            true, // lock set token
            defaultDuration,
            defaultPositionMultiplier
          );

          await fundBidder(setup.wbtc, bitcoin(0.1));
          await bid(indexWithQuoteAsset, setup.wbtc, bitcoin(0.1), ether(1.45));

          subjectIncreaseTime = ONE_HOUR_IN_SECONDS;
        });

        it("should revert with 'Cannot unlock early unless all targets are met and raiseTargetPercentage is zero'", async () => {
          await expect(subject()).to.be.revertedWith("Cannot unlock early unless all targets are met and raiseTargetPercentage is zero");
        });
      });

      describe("when the rebalance duration has not elapsed, raise target percentage is zero, but buy auction target not met", async () => {
        beforeEach(async () => {
          await startRebalance(
            indexWithQuoteAsset.address,
            defaultQuoteAsset,
            defaultNewComponents,
            defaultNewComponentsAuctionParams,
            defaultOldComponentsAuctionParams,
            true, // lock set token
            defaultDuration,
            defaultPositionMultiplier
          );

          await fundBidder(setup.weth, ether(0.45));
          await bid(indexWithQuoteAsset, setup.dai, ether(900), ether(0.45));

          subjectIncreaseTime = ONE_HOUR_IN_SECONDS;
        });

        it("should revert with 'Cannot unlock early unless all targets are met and raiseTargetPercentage is zero'", async () => {
          await expect(subject()).to.be.revertedWith("Cannot unlock early unless all targets are met and raiseTargetPercentage is zero");
        });
      });

      describe("when the rebalance duration has not elapsed, raise target percentage is zero, but buy auction target not met", async () => {
        beforeEach(async () => {
          const oldComponentsAuctionParams = [
            ...defaultOldComponentsAuctionParams.slice(0, 2),
            {
              targetUnit: ether(200),
              priceAdapterName: AdapterNames.CONSTANT_PRICE_ADAPTER,
              priceAdapterConfigData: defaultWethData
            }
          ];

          await startRebalance(
            indexWithQuoteAsset.address,
            defaultQuoteAsset,
            defaultNewComponents,
            defaultNewComponentsAuctionParams,
            oldComponentsAuctionParams,
            true, // lock set token
            defaultDuration,
            defaultPositionMultiplier
          );

          await fundBidder(setup.weth, ether(0.45));
          await bid(indexWithQuoteAsset, setup.dai, ether(900), ether(0.45));

          await fundBidder(setup.wbtc, bitcoin(0.1));
          await bid(indexWithQuoteAsset, setup.wbtc, bitcoin(0.1), ether(1.45));

          subjectIncreaseTime = ONE_HOUR_IN_SECONDS;
        });

        it("should revert with 'Cannot unlock early unless all targets are met and raiseTargetPercentage is zero'", async () => {
          await expect(subject()).to.be.revertedWith("Cannot unlock early unless all targets are met and raiseTargetPercentage is zero");
        });
      });
    });

    describe("#setRaiseTargetPercentage", async () => {
      let subjectRaiseTargetPercentage: BigNumber;

      beforeEach(async () => {
        subjectSetToken = indexWithQuoteAsset;
        subjectCaller = owner;
        subjectRaiseTargetPercentage = ether(0.02);
      });

      async function subject(): Promise<ContractTransaction> {
        return await auctionModule.connect(subjectCaller.wallet).setRaiseTargetPercentage(
          subjectSetToken.address,
          subjectRaiseTargetPercentage
        );
      }

      it("should set the raiseTargetPercentage", async () => {
        await subject();
        const newRaiseTargetPercentage = (await auctionModule.rebalanceInfo(subjectSetToken.address)).raiseTargetPercentage;

        expect(newRaiseTargetPercentage).to.eq(subjectRaiseTargetPercentage);
      });

      it("should emit the RaiseTargetPercentageUpdated event", async () => {
        await expect(subject()).to.emit(auctionModule, "RaiseTargetPercentageUpdated").withArgs(
          subjectSetToken.address,
          subjectRaiseTargetPercentage
        );
      });

      describe("when the target percentage is set to 0", async () => {
        beforeEach(async () => {
          subjectRaiseTargetPercentage = ZERO;
        });

        it("should revert with 'Target percentage must be greater than 0'", async () => {
          await expect(subject()).to.be.revertedWith("Target percentage must be greater than 0");
        });
      });
    });

    describe("#raiseAssetTargets", async () => {
      let oldComponentsAuctionParams: AuctionExecutionParams[];

      let subjectRaiseTargetPercentage: BigNumber;
      let subjectIncreaseTime: BigNumber;

      beforeEach(async () => {
        oldComponentsAuctionParams = [
          {
            targetUnit: ether(9100),
            priceAdapterName: AdapterNames.CONSTANT_PRICE_ADAPTER,
            priceAdapterConfigData: defaultDaiData
          },
          {
            targetUnit: bitcoin(.54),
            priceAdapterName: AdapterNames.CONSTANT_PRICE_ADAPTER,
            priceAdapterConfigData: defaultWbtcData
          },
          {
            targetUnit: ether(4),
            priceAdapterName: AdapterNames.CONSTANT_PRICE_ADAPTER,
            priceAdapterConfigData: defaultWethData
          }
        ];

        await startRebalance(
          subjectSetToken.address,
          defaultQuoteAsset,
          defaultNewComponents,
          defaultNewComponentsAuctionParams,
          oldComponentsAuctionParams,
          defaultShouldLockSetToken,
          defaultDuration,
          defaultPositionMultiplier
        );

        subjectSetToken = indexWithQuoteAsset;
        subjectCaller = bidder;
        subjectRaiseTargetPercentage = ether(.0025);
        subjectIncreaseTime = ZERO;

        await auctionModule.connect(owner.wallet).setRaiseTargetPercentage(subjectSetToken.address, subjectRaiseTargetPercentage);
      });

      async function subject(): Promise<ContractTransaction> {
        await increaseTimeAsync(subjectIncreaseTime);
        return await auctionModule.connect(subjectCaller.wallet).raiseAssetTargets(subjectSetToken.address);
      }

      describe("when all the target units are reached and there is remaining quote asset", async () => {
        beforeEach(async () => {
          await fundBidder(setup.weth, ether(0.45));
          await bid(subjectSetToken, setup.dai, ether(900), ether(0.45));

          await fundBidder(setup.wbtc, bitcoin(0.04));
          await bid(subjectSetToken, setup.wbtc, bitcoin(0.04), ether(0.58));
        });

        it("should increase the target units by the raiseTargetPercentage", async () => {
          const prePositionMultiplier = (await auctionModule.rebalanceInfo(subjectSetToken.address)).positionMultiplier;

          await expect(auctionModule.getAuctionSizeAndDirection(subjectSetToken.address, setup.dai.address)).to.be.revertedWith("Target already met");
          await expect(
            auctionModule.getAuctionSizeAndDirection(subjectSetToken.address, setup.wbtc.address)
          ).to.be.revertedWith("Target already met");

          await subject();

          const expectedPositionMultiplier = preciseDiv(prePositionMultiplier, PRECISE_UNIT.add(ether(.0025)));
          const positionMultiplier = (await auctionModule.rebalanceInfo(subjectSetToken.address)).positionMultiplier;

          expect(positionMultiplier).to.eq(expectedPositionMultiplier);

          const [daiDirection, daiSize] = await auctionModule.getAuctionSizeAndDirection(subjectSetToken.address, setup.dai.address);
          const [wbtcDirection, wbtcSize] = await auctionModule.getAuctionSizeAndDirection(subjectSetToken.address, setup.wbtc.address);

          expect(daiSize).to.be.gt(ether(2.25));
          expect(daiDirection).to.be.false;
          expect(wbtcSize).to.be.gt(bitcoin(0.0001));
          expect(wbtcDirection).to.be.false;
        });

        it("emits correct AssetTargetsRaised event", async () => {
          const prePositionMultiplier = (await auctionModule.rebalanceInfo(subjectSetToken.address)).positionMultiplier;
          const expectedPositionMultiplier = preciseDiv(prePositionMultiplier, PRECISE_UNIT.add(ether(.0025)));

          await expect(subject()).to.emit(auctionModule, "AssetTargetsRaised").withArgs(
            subjectSetToken.address,
            expectedPositionMultiplier
          );
        });

        describe("when the calling address is not a permissioned address", async () => {
          beforeEach(async () => {
            subjectCaller = await getRandomAccount();
          });

          it("should revert with 'Address not permitted to bid'", async () => {
            await expect(subject()).to.be.revertedWith("Address not permitted to bid");
          });
        });
      });

      describe("when the raiseTargetPercentage is the lowest valid decimal (1e-6)", () => {
        beforeEach(async () => {
          subjectRaiseTargetPercentage = ether(.000001);
          await auctionModule.connect(owner.wallet).setRaiseTargetPercentage(subjectSetToken.address, subjectRaiseTargetPercentage);

          await fundBidder(setup.weth, ether(0.45));
          await bid(subjectSetToken, setup.dai, ether(900), ether(0.45));

          await fundBidder(setup.wbtc, bitcoin(0.04));
          await bid(subjectSetToken, setup.wbtc, bitcoin(0.04), ether(0.58));
        });

        afterEach(() => {
          subjectRaiseTargetPercentage = ether(.0025);
        });

        it("the position multiplier should be set as expected", async () => {
          const prePositionMultiplier = (await auctionModule.rebalanceInfo(subjectSetToken.address)).positionMultiplier;

          await subject();

          const expectedPositionMultiplier = preciseDiv(
            prePositionMultiplier,
            PRECISE_UNIT.add(subjectRaiseTargetPercentage)
          );

          const positionMultiplier = (await auctionModule.rebalanceInfo(subjectSetToken.address)).positionMultiplier;

          expect(positionMultiplier).to.eq(expectedPositionMultiplier);
        });
      });

      describe("when the raiseTargetPercentage is MAX_UINT_256", () => {
        beforeEach(async () => {
          subjectRaiseTargetPercentage = MAX_UINT_256;
          await auctionModule.connect(owner.wallet).setRaiseTargetPercentage(subjectSetToken.address, subjectRaiseTargetPercentage);

          await fundBidder(setup.weth, ether(0.45));
          await bid(subjectSetToken, setup.dai, ether(900), ether(0.45));

          await fundBidder(setup.wbtc, bitcoin(0.04));
          await bid(subjectSetToken, setup.wbtc, bitcoin(0.04), ether(0.58));
        });

        afterEach(() => {
          subjectRaiseTargetPercentage = ether(.0025);
        });

        it("should revert with 'addition overflow'", async () => {
          await expect(subject()).to.be.revertedWith("addition overflow");
        });
      });

      describe("when protocol fees are charged", () => {
        beforeEach(async () => {
          const feePercentage = ether(0.005);
          setup.controller = setup.controller.connect(owner.wallet);
          await setup.controller.addFee(
            auctionModule.address,
            ZERO, // Fee type on bid function denoted as 0
            feePercentage // Set fee to 5 bps
          );

          await fundBidder(setup.weth, ether(0.45));
          await bid(subjectSetToken, setup.dai, ether(900), ether(0.45));

          await fundBidder(setup.wbtc, bitcoin(0.040201));
          await bid(subjectSetToken, setup.wbtc, bitcoin(0.040201), ether(0.5829145));
        });

        it("should increase the target units by the raiseTargetPercentage", async () => {
          const prePositionMultiplier = (await auctionModule.rebalanceInfo(subjectSetToken.address)).positionMultiplier;

          await expect(auctionModule.getAuctionSizeAndDirection(subjectSetToken.address, setup.dai.address)).to.be.revertedWith("Target already met");
          await expect(
            auctionModule.getAuctionSizeAndDirection(subjectSetToken.address, setup.wbtc.address)
          ).to.be.revertedWith("Target already met");

          await subject();

          const expectedPositionMultiplier = preciseDiv(prePositionMultiplier, PRECISE_UNIT.add(ether(.0025)));
          const positionMultiplier = (await auctionModule.rebalanceInfo(subjectSetToken.address)).positionMultiplier;

          expect(positionMultiplier).to.eq(expectedPositionMultiplier);

          const [daiDirection, daiSize] = await auctionModule.getAuctionSizeAndDirection(subjectSetToken.address, setup.dai.address);
          const [wbtcDirection, wbtcSize] = await auctionModule.getAuctionSizeAndDirection(subjectSetToken.address, setup.wbtc.address);

          expect(daiSize).to.be.gt(ether(2.25));
          expect(daiDirection).to.be.false;
          expect(wbtcSize).to.be.gt(bitcoin(0.0001));
          expect(wbtcDirection).to.be.false;
        });
      });

      describe("when a component is being removed", async () => {
        beforeEach(async () => {
          const oldComponentsAuctionParams = [
            {
              targetUnit: ZERO,
              priceAdapterName: AdapterNames.CONSTANT_PRICE_ADAPTER,
              priceAdapterConfigData: defaultDaiData
            },
            {
              targetUnit: bitcoin(.54),
              priceAdapterName: AdapterNames.CONSTANT_PRICE_ADAPTER,
              priceAdapterConfigData: defaultWbtcData
            },
            {
              targetUnit: ether(4),
              priceAdapterName: AdapterNames.CONSTANT_PRICE_ADAPTER,
              priceAdapterConfigData: defaultWethData
            }
          ];

          startRebalance(
            subjectSetToken.address,
            defaultQuoteAsset,
            defaultNewComponents,
            defaultNewComponentsAuctionParams,
            oldComponentsAuctionParams,
            defaultShouldLockSetToken,
            defaultDuration,
            defaultPositionMultiplier
          );

          await fundBidder(setup.weth, ether(5));
          await bid(subjectSetToken, setup.dai, ether(10000), ether(5));

          await fundBidder(setup.wbtc, bitcoin(0.04));
          await bid(subjectSetToken, setup.wbtc, bitcoin(0.04), ether(0.58));
        });

        it("the position units should be set as expected and the unit should be zeroed out", async () => {
          const prePositionMultiplier = (await auctionModule.rebalanceInfo(subjectSetToken.address)).positionMultiplier;

          await expect(auctionModule.getAuctionSizeAndDirection(subjectSetToken.address, setup.dai.address)).to.be.revertedWith("Target already met");
          await expect(
            auctionModule.getAuctionSizeAndDirection(subjectSetToken.address, setup.wbtc.address)
          ).to.be.revertedWith("Target already met");

          await subject();

          const expectedPositionMultiplier = preciseDiv(prePositionMultiplier, PRECISE_UNIT.add(ether(.0025)));
          const positionMultiplier = (await auctionModule.rebalanceInfo(subjectSetToken.address)).positionMultiplier;

          expect(positionMultiplier).to.eq(expectedPositionMultiplier);

          await expect(auctionModule.getAuctionSizeAndDirection(subjectSetToken.address, setup.dai.address)).to.be.revertedWith("Target already met");
          const [wbtcDirection, wbtcSize] = await auctionModule.getAuctionSizeAndDirection(subjectSetToken.address, setup.wbtc.address);

          expect(wbtcSize).to.be.gt(bitcoin(0.0001));
          expect(wbtcDirection).to.be.false;
        });
      });

      describe("when the rebalance duration has elapsed", async () => {
        beforeEach(async () => {
          subjectIncreaseTime = defaultDuration.add(1);
        });

        it("should revert with 'Rebalance must be in progress'", async () => {
          await expect(subject()).to.be.revertedWith("Rebalance must be in progress");
        });
      });

      describe("when a buy auction target has not been met", async () => {
        beforeEach(async () => {
          await fundBidder(setup.weth, ether(0.45));
          await bid(subjectSetToken, setup.dai, ether(900), ether(0.45));
        });

        it("should revert with 'Targets not met or quote asset =~ 0'", async () => {
          await expect(subject()).to.be.revertedWith("Targets not met or quote asset =~ 0");
        });
      });

      describe("when a sell auction target has not been met", async () => {
        beforeEach(async () => {
          await fundBidder(setup.wbtc, bitcoin(0.04));
          await bid(subjectSetToken, setup.wbtc, bitcoin(0.04), ether(0.58));
        });

        it("should revert with Targets not met or quote asset =~ 0", async () => {
          await expect(subject()).to.be.revertedWith("Targets not met or quote asset =~ 0");
        });
      });

      describe("when the targets have been met but there is no remaining quote asset", async () => {
        beforeEach(async () => {
          const oldComponentsAuctionParams = [
            {
              targetUnit: ether(9100),
              priceAdapterName: AdapterNames.CONSTANT_PRICE_ADAPTER,
              priceAdapterConfigData: defaultDaiData
            },
            {
              targetUnit: bitcoin(.54),
              priceAdapterName: AdapterNames.CONSTANT_PRICE_ADAPTER,
              priceAdapterConfigData: defaultWbtcData
            },
            {
              targetUnit: ether(4.87),
              priceAdapterName: AdapterNames.CONSTANT_PRICE_ADAPTER,
              priceAdapterConfigData: defaultWethData
            },
          ];

          startRebalance(
            subjectSetToken.address,
            defaultQuoteAsset,
            defaultNewComponents,
            defaultNewComponentsAuctionParams,
            oldComponentsAuctionParams,
            defaultShouldLockSetToken,
            defaultDuration,
            defaultPositionMultiplier
          );

          await fundBidder(setup.weth, ether(0.45));
          await bid(subjectSetToken, setup.dai, ether(900), ether(0.45));

          await fundBidder(setup.wbtc, bitcoin(0.04));
          await bid(subjectSetToken, setup.wbtc, bitcoin(0.04), ether(0.58));
        });

        it("should revert with Targets not met or quote asset =~ 0", async () => {
          await expect(subject()).to.be.revertedWith("Targets not met or quote asset =~ 0");
        });
      });

      describe("when the targets have been met but the quote asset is below its target unit", async () => {
        beforeEach(async () => {
          const oldComponentsAuctionParams = [
            {
              targetUnit: ether(9100),
              priceAdapterName: AdapterNames.CONSTANT_PRICE_ADAPTER,
              priceAdapterConfigData: defaultDaiData
            },
            {
              targetUnit: bitcoin(.54),
              priceAdapterName: AdapterNames.CONSTANT_PRICE_ADAPTER,
              priceAdapterConfigData: defaultWbtcData
            },
            {
              targetUnit: ether(200),
              priceAdapterName: AdapterNames.CONSTANT_PRICE_ADAPTER,
              priceAdapterConfigData: defaultWethData
            },
          ];

          startRebalance(
            subjectSetToken.address,
            defaultQuoteAsset,
            defaultNewComponents,
            defaultNewComponentsAuctionParams,
            oldComponentsAuctionParams,
            defaultShouldLockSetToken,
            defaultDuration,
            defaultPositionMultiplier
          );

          await fundBidder(setup.weth, ether(0.45));
          await bid(subjectSetToken, setup.dai, ether(900), ether(0.45));

          await fundBidder(setup.wbtc, bitcoin(0.04));
          await bid(subjectSetToken, setup.wbtc, bitcoin(0.04), ether(0.58));
        });

        it("should revert with 'Targets not met or quote asset =~ 0'", async () => {
          await expect(subject()).to.be.revertedWith("Targets not met or quote asset =~ 0");
        });
      });
    });

    describe("#removeModule", async () => {
      let subjectStatuses: boolean[];
      let subjectBidders: Address[];

      beforeEach(async () => {
        subjectSetToken = indexWithQuoteAsset;
        subjectCaller = owner;
        subjectBidders = [bidder.address, await getRandomAddress()];
        subjectStatuses = [true, false];
      });

      afterEach(restoreModule);

      async function restoreModule() {
        const isModuleEnabled = await subjectSetToken.isInitializedModule(auctionModule.address);

        if (!isModuleEnabled) {
          await subjectSetToken.connect(subjectCaller.wallet).addModule(auctionModule.address);
          await auctionModule.connect(subjectCaller.wallet).initialize(subjectSetToken.address);
        }
      }

      describe("module removal", async () => {
        async function subject(): Promise<any> {
          return subjectSetToken.connect(subjectCaller.wallet).removeModule(auctionModule.address);
        }

        it("should remove the module", async () => {
          await subject();
          const isModuleEnabled = await subjectSetToken.isInitializedModule(auctionModule.address);
          expect(isModuleEnabled).to.eq(false);
        });
      });

      describe("restoring module after removal and checking permissions", async () => {
        beforeEach(async () => {
          await auctionModule.connect(subjectCaller.wallet).setBidderStatus(
            subjectSetToken.address,
            subjectBidders,
            subjectStatuses
          );

          await auctionModule.connect(subjectCaller.wallet).setAnyoneBid(
            subjectSetToken.address,
            true
          );
        });

        async function subject(): Promise<any> {
          await subjectSetToken.connect(subjectCaller.wallet).removeModule(auctionModule.address);
          await restoreModule();
        }

        it("should have removed bidders from the permissions whitelist", async () => {
          let isBidderOne = await auctionModule.isAllowedBidder(subjectSetToken.address, subjectBidders[0]);
          expect(isBidderOne).to.be.true;

          await subject();

          isBidderOne = await auctionModule.isAllowedBidder(subjectSetToken.address, subjectBidders[0]);
          expect(isBidderOne).to.be.false;
        });

        it("should have set isAnyoneAllowedToBid to false", async () => {
          // The public getter return sig generated for permissionInfo's abi
          // is  <bool>anyoneBid (and nothing else).
          let isAnyoneAllowedToBid = await auctionModule.permissionInfo(subjectSetToken.address);
          expect(isAnyoneAllowedToBid).to.be.true;

          await subject();

          isAnyoneAllowedToBid = await auctionModule.permissionInfo(subjectSetToken.address);
          expect(isAnyoneAllowedToBid).to.be.false;
        });
      });
    });

    describe("#bid", async () => {
      let subjectComponent: Address;
      let subjectComponentAmount: BigNumber;
      let subjectQuoteAssetLimit: BigNumber;

      let subjectIncreaseTime: BigNumber;

      beforeEach(async () => {
        subjectSetToken = indexWithQuoteAsset;
        subjectCaller = bidder;
        subjectComponent = setup.dai.address;
        subjectComponentAmount = ether(900);
        subjectQuoteAssetLimit = ether(0.45);
        subjectIncreaseTime = ONE_HOUR_IN_SECONDS;
      });

      async function subject(): Promise<ContractTransaction> {
        await increaseTimeAsync(subjectIncreaseTime);
        return await auctionModule.connect(subjectCaller.wallet).bid(
          subjectSetToken.address,
          subjectComponent,
          subjectComponentAmount,
          subjectQuoteAssetLimit
        );
      }

      describe("when the bid is placed on a component sell auction and priced using the ConstantPriceAdapter", async () => {
        beforeEach(async () => {
          await startRebalance();
          await fundBidder();
        });

        it("updates position units and transfers tokens correctly on a component sell auction with ConstantPriceAdapter", async () => {
          const preBidBalances = {
            bidderDai: await setup.dai.balanceOf(bidder.address),
            bidderWeth: await setup.weth.balanceOf(bidder.address),
            setTokenDai: await setup.dai.balanceOf(subjectSetToken.address),
            setTokenWeth: await setup.weth.balanceOf(subjectSetToken.address)
          };
          const setTokenTotalSupply = await subjectSetToken.totalSupply();

          await subject();

          const expectedWethPositionUnits = preciseDiv(preBidBalances.setTokenWeth.add(subjectQuoteAssetLimit), setTokenTotalSupply);
          const expectedDaiPositionUnits = preciseDiv(preBidBalances.setTokenDai.sub(subjectComponentAmount), setTokenTotalSupply);

          const wethPositionUnits = await subjectSetToken.getDefaultPositionRealUnit(setup.weth.address);
          const daiPositionUnits = await subjectSetToken.getDefaultPositionRealUnit(setup.dai.address);

          expect(wethPositionUnits).to.eq(expectedWethPositionUnits);
          expect(daiPositionUnits).to.eq(expectedDaiPositionUnits);

          const postBidBalances = {
            bidderDai: await setup.dai.balanceOf(bidder.address),
            bidderWeth: await setup.weth.balanceOf(bidder.address),
            setTokenDai: await setup.dai.balanceOf(subjectSetToken.address),
            setTokenWeth: await setup.weth.balanceOf(subjectSetToken.address)
          };

          expect(postBidBalances.bidderDai).to.eq(preBidBalances.bidderDai.add(subjectComponentAmount));
          expect(postBidBalances.bidderWeth).to.eq(preBidBalances.bidderWeth.sub(subjectQuoteAssetLimit));
          expect(postBidBalances.setTokenDai).to.eq(preBidBalances.setTokenDai.sub(subjectComponentAmount));
          expect(postBidBalances.setTokenWeth).to.eq(preBidBalances.setTokenWeth.add(subjectQuoteAssetLimit));
        });

        it("emits the correct BidExecuted event", async () => {
          const totalSupply = await subjectSetToken.totalSupply();

          await expect(subject()).to.emit(auctionModule, "BidExecuted").withArgs(
            subjectSetToken.address,
            subjectComponent,
            defaultQuoteAsset,
            subjectCaller.address,
            constantPriceAdapter.address,
            true,
            ether(0.0005),
            subjectComponentAmount,
            subjectQuoteAssetLimit,
            0,
            totalSupply
          );
        });

        describe("when there is a protcol fee charged", async () => {
          let feePercentage: BigNumber;

          beforeEach(async () => {
            feePercentage = ether(0.005);
            setup.controller = setup.controller.connect(owner.wallet);
            await setup.controller.addFee(
              auctionModule.address,
              ZERO, // Fee type on bid function denoted as 0
              feePercentage // Set fee to 5 bps
            );
          });

          it("updates position units and transfers tokens correctly on a component sell auction with ConstantPriceAdapter", async () => {
            const preBidBalances = {
              bidderDai: await setup.dai.balanceOf(bidder.address),
              bidderWeth: await setup.weth.balanceOf(bidder.address),
              setTokenDai: await setup.dai.balanceOf(subjectSetToken.address),
              setTokenWeth: await setup.weth.balanceOf(subjectSetToken.address)
            };
            const setTokenTotalSupply = await subjectSetToken.totalSupply();

            await subject();

            const protocolFee = subjectQuoteAssetLimit.mul(feePercentage).div(ether(1));
            const expectedWethPositionUnits = preciseDiv(
              preBidBalances.setTokenWeth.add(subjectQuoteAssetLimit).sub(protocolFee),
              setTokenTotalSupply
            );
            const expectedDaiPositionUnits = preciseDiv(preBidBalances.setTokenDai.sub(subjectComponentAmount), setTokenTotalSupply);

            const wethPositionUnits = await subjectSetToken.getDefaultPositionRealUnit(setup.weth.address);
            const daiPositionUnits = await subjectSetToken.getDefaultPositionRealUnit(setup.dai.address);

            expect(wethPositionUnits).to.eq(expectedWethPositionUnits);
            expect(daiPositionUnits).to.eq(expectedDaiPositionUnits);

            const postBidBalances = {
              bidderDai: await setup.dai.balanceOf(bidder.address),
              bidderWeth: await setup.weth.balanceOf(bidder.address),
              setTokenDai: await setup.dai.balanceOf(subjectSetToken.address),
              setTokenWeth: await setup.weth.balanceOf(subjectSetToken.address)
            };

            expect(postBidBalances.bidderDai).to.eq(preBidBalances.bidderDai.add(subjectComponentAmount));
            expect(postBidBalances.bidderWeth).to.eq(preBidBalances.bidderWeth.sub(subjectQuoteAssetLimit));
            expect(postBidBalances.setTokenDai).to.eq(preBidBalances.setTokenDai.sub(subjectComponentAmount));
            expect(postBidBalances.setTokenWeth).to.eq(preBidBalances.setTokenWeth.add(subjectQuoteAssetLimit).sub(protocolFee));
          });

          it("the fees should be received by the fee recipient", async () => {
            const feeRecipient = await setup.controller.feeRecipient();
            const beforeWethBalance = await setup.weth.balanceOf(feeRecipient);

            await subject();

            const wethBalance = await setup.weth.balanceOf(feeRecipient);

            const protocolFee = subjectQuoteAssetLimit.mul(feePercentage).div(ether(1));
            const expectedWethBalance = beforeWethBalance.add(protocolFee);

            expect(wethBalance).to.eq(expectedWethBalance);
          });

          it("emits the correct BidExecuted event", async () => {
            const protocolFee = subjectQuoteAssetLimit.mul(feePercentage).div(ether(1));
            const totalSupply = await subjectSetToken.totalSupply();

            await expect(subject()).to.emit(auctionModule, "BidExecuted").withArgs(
              subjectSetToken.address,
              subjectComponent,
              defaultQuoteAsset,
              subjectCaller.address,
              constantPriceAdapter.address,
              true,
              ether(0.0005),
              subjectComponentAmount,
              subjectQuoteAssetLimit.sub(protocolFee),
              protocolFee,
              totalSupply
            );
          });
        });

        describe("when bid consumes more than maximum output quote asset amount, while selling component", async () => {
          beforeEach(async () => {
            subjectQuoteAssetLimit = ether(0.45).sub(1);
          });

          it("should revert with 'Quote asset quantity exceeds limit'", async () => {
            await expect(subject()).to.be.revertedWith("Quote asset quantity exceeds limit");
          });
        });

        describe("when bid component amount exceeds auction size, while selling component", async () => {
          beforeEach(async () => {
            await fundBidder();
            subjectComponentAmount = ether(1000);
          });

          it("should revert with 'Bid size exceeds auction quantity'", async () => {
            await expect(subject()).to.be.revertedWith("Bid size exceeds auction quantity");
          });
        });

        describe("when bidding on an auction that zeros out the component position unit", async () => {
          beforeEach(async () => {
            const oldComponentsAuctionParams: AuctionExecutionParams[] = [
              {
                targetUnit: ZERO,
                priceAdapterName: AdapterNames.CONSTANT_PRICE_ADAPTER,
                priceAdapterConfigData: defaultDaiData
              },
              {
                targetUnit: bitcoin(.6),
                priceAdapterName: AdapterNames.CONSTANT_PRICE_ADAPTER,
                priceAdapterConfigData: defaultWbtcData
              },
              {
                targetUnit: ether(4),
                priceAdapterName: AdapterNames.CONSTANT_PRICE_ADAPTER,
                priceAdapterConfigData: defaultWethData
              }
            ];

            await startRebalance(
              subjectSetToken.address,
              defaultQuoteAsset,
              defaultNewComponents,
              defaultNewComponentsAuctionParams,
              oldComponentsAuctionParams,
              defaultShouldLockSetToken,
              defaultDuration,
              defaultPositionMultiplier
            );
            await fundBidder(
              setup.weth,
              ether(5)
            );

            subjectComponentAmount = ether(10000);
            subjectQuoteAssetLimit = ether(5);
          });

          it("should remove the component from the SetToken", async () => {
            const components = await subjectSetToken.getComponents();

            await subject();

            const postComponents = await subjectSetToken.getComponents();

            expect(postComponents).to.not.contain(subjectComponent);
            expect(postComponents.length).to.eq(components.length - 1);
          });
        });
      });

      describe("when the bid is placed on a component buy auction and priced using the ConstantPriceAdapter", async () => {
        beforeEach(async () => {
          await startRebalance();
          await fundBidder(setup.wbtc, bitcoin(0.1));

          subjectComponent = setup.wbtc.address;
          subjectComponentAmount = bitcoin(0.1);
          subjectQuoteAssetLimit = ether(1.45);
        });

        it("updates position units and transfers tokens correctly on a component buy auction with ConstantPriceAdapter", async () => {
          const preBidBalances = {
            bidderWbtc: await setup.wbtc.balanceOf(bidder.address),
            bidderWeth: await setup.weth.balanceOf(bidder.address),
            setTokenWbtc: await setup.wbtc.balanceOf(subjectSetToken.address),
            setTokenWeth: await setup.weth.balanceOf(subjectSetToken.address)
          };
          const setTokenTotalSupply = await subjectSetToken.totalSupply();

          await subject();

          const expectedWethPositionUnits = preciseDiv(preBidBalances.setTokenWeth.sub(subjectQuoteAssetLimit), setTokenTotalSupply);
          const expectedWbtcPositionUnits = preciseDiv(preBidBalances.setTokenWbtc.add(subjectComponentAmount), setTokenTotalSupply);

          const wethPositionUnits = await subjectSetToken.getDefaultPositionRealUnit(setup.weth.address);
          const wbtcPositionUnits = await subjectSetToken.getDefaultPositionRealUnit(setup.wbtc.address);

          expect(wethPositionUnits).to.eq(expectedWethPositionUnits);
          expect(wbtcPositionUnits).to.eq(expectedWbtcPositionUnits);

          const postBidBalances = {
            bidderWbtc: await setup.wbtc.balanceOf(bidder.address),
            bidderWeth: await setup.weth.balanceOf(bidder.address),
            setTokenWbtc: await setup.wbtc.balanceOf(subjectSetToken.address),
            setTokenWeth: await setup.weth.balanceOf(subjectSetToken.address)
          };

          expect(postBidBalances.bidderWbtc).to.eq(preBidBalances.bidderWbtc.sub(subjectComponentAmount));
          expect(postBidBalances.bidderWeth).to.eq(preBidBalances.bidderWeth.add(subjectQuoteAssetLimit));
          expect(postBidBalances.setTokenWbtc).to.eq(preBidBalances.setTokenWbtc.add(subjectComponentAmount));
          expect(postBidBalances.setTokenWeth).to.eq(preBidBalances.setTokenWeth.sub(subjectQuoteAssetLimit));
        });

        it("emits the correct BidExecuted event", async () => {
          const totalSupply = await subjectSetToken.totalSupply();

          await expect(subject()).to.emit(auctionModule, "BidExecuted").withArgs(
            subjectSetToken.address,
            defaultQuoteAsset,
            subjectComponent,
            subjectCaller.address,
            constantPriceAdapter.address,
            defaultShouldLockSetToken,
            defaultWbtcPrice,
            subjectQuoteAssetLimit,
            subjectComponentAmount,
            0,
            totalSupply
          );
        });

        describe("when there is a protcol fee charged", async () => {
          let feePercentage: BigNumber;

          beforeEach(async () => {
            feePercentage = ether(0.005);
            setup.controller = setup.controller.connect(owner.wallet);
            await setup.controller.addFee(
              auctionModule.address,
              ZERO, // Fee type on bid function denoted as 0
              feePercentage // Set fee to 5 bps
            );
          });

          it("updates position units and transfers tokens correctly on a component sell auction with ConstantPriceAdapter", async () => {
            const preBidBalances = {
              bidderWbtc: await setup.wbtc.balanceOf(bidder.address),
              bidderWeth: await setup.weth.balanceOf(bidder.address),
              setTokenWbtc: await setup.wbtc.balanceOf(subjectSetToken.address),
              setTokenWeth: await setup.weth.balanceOf(subjectSetToken.address)
            };
            const setTokenTotalSupply = await subjectSetToken.totalSupply();

            await subject();

            const protocolFee = subjectComponentAmount.mul(feePercentage).div(ether(1));
            const expectedWethPositionUnits = preciseDiv(preBidBalances.setTokenWeth.sub(subjectQuoteAssetLimit), setTokenTotalSupply);
            const expectedWbtcPositionUnits = preciseDiv(
              preBidBalances.setTokenWbtc.add(subjectComponentAmount).sub(protocolFee),
              setTokenTotalSupply
            );

            const wethPositionUnits = await subjectSetToken.getDefaultPositionRealUnit(setup.weth.address);
            const wbtcPositionUnits = await subjectSetToken.getDefaultPositionRealUnit(setup.wbtc.address);

            expect(wethPositionUnits).to.eq(expectedWethPositionUnits);
            expect(wbtcPositionUnits).to.eq(expectedWbtcPositionUnits);

            const postBidBalances = {
              bidderWbtc: await setup.wbtc.balanceOf(bidder.address),
              bidderWeth: await setup.weth.balanceOf(bidder.address),
              setTokenWbtc: await setup.wbtc.balanceOf(subjectSetToken.address),
              setTokenWeth: await setup.weth.balanceOf(subjectSetToken.address)
            };

            expect(postBidBalances.bidderWbtc).to.eq(preBidBalances.bidderWbtc.sub(subjectComponentAmount));
            expect(postBidBalances.bidderWeth).to.eq(preBidBalances.bidderWeth.add(subjectQuoteAssetLimit));
            expect(postBidBalances.setTokenWbtc).to.eq(preBidBalances.setTokenWbtc.add(subjectComponentAmount).sub(protocolFee));
            expect(postBidBalances.setTokenWeth).to.eq(preBidBalances.setTokenWeth.sub(subjectQuoteAssetLimit));
          });

          it("the fees should be received by the fee recipient", async () => {
            const feeRecipient = await setup.controller.feeRecipient();
            const beforeWbtcBalance = await setup.wbtc.balanceOf(feeRecipient);

            await subject();

            const wbtcBalance = await setup.wbtc.balanceOf(feeRecipient);

            const protocolFee = subjectComponentAmount.mul(feePercentage).div(ether(1));
            const expectedWbtcBalance = beforeWbtcBalance.add(protocolFee);

            expect(wbtcBalance).to.eq(expectedWbtcBalance);
          });

          it("emits the correct BidExecuted event", async () => {
            const protocolFee = subjectComponentAmount.mul(feePercentage).div(ether(1));
            const totalSupply = await subjectSetToken.totalSupply();

            await expect(subject()).to.emit(auctionModule, "BidExecuted").withArgs(
              subjectSetToken.address,
              defaultQuoteAsset,
              subjectComponent,
              subjectCaller.address,
              constantPriceAdapter.address,
              false,
              defaultWbtcPrice,
              subjectQuoteAssetLimit,
              subjectComponentAmount.sub(protocolFee),
              protocolFee,
              totalSupply
            );
          });
        });

        describe("when bid returns less than minimum output quote asset amount, while buying component", async () => {
          beforeEach(async () => {
            subjectQuoteAssetLimit = ether(1.45).add(1);
          });

          it("should revert with 'Quote asset quantity below limit'", async () => {
            await expect(subject()).to.be.revertedWith("Quote asset quantity below limit");
          });
        });

        describe("when bid component amount exceeds auction size, while buying component", async () => {
          beforeEach(async () => {
            await fundBidder(setup.wbtc, bitcoin(10));
            subjectComponentAmount = ether(10);
          });

          it("should revert with 'Bid size exceeds auction quantity'", async () => {
            await expect(subject()).to.be.revertedWith("Bid size exceeds auction quantity");
          });
        });

        describe("when the index does not contain the quote asset", async () => {
          const acquiredCapital = ether(0.145);

          beforeEach(async () => {
            await startRebalance(
              indexWithoutQuoteAsset.address,
              defaultQuoteAsset,
              defaultNewComponents,
              defaultNewComponentsAuctionParams,
              defaultOldComponentsAuctionParams.slice(0, 2),
              defaultShouldLockSetToken,
              defaultDuration,
              defaultPositionMultiplier
            );
            await fundBidder(setup.wbtc, bitcoin(10));

            subjectSetToken = indexWithoutQuoteAsset;
            subjectComponent = setup.wbtc.address;
            subjectComponentAmount = bitcoin(0.01);
            subjectQuoteAssetLimit = acquiredCapital;
          });

          it("should revert on initial buy bids with 'Insufficient quote asset balance'", async () => {
            await expect(subject()).to.be.revertedWith("Insufficient quote asset balance");
          });

          describe("after placing an initial sell bid", async () => {
            beforeEach(async () => {
              await fundBidder(setup.weth, ether(0.145));
              auctionModule.connect(subjectCaller.wallet).bid(
                indexWithoutQuoteAsset.address,
                setup.dai.address,
                ether(290),
                ether(0.145)
              );
            });

            it("should allow buy auction for up to the amount of acquired capital", async () => {
              await subject();
            });

            it("should revert for buy auction quantities greater than the acquired capital with 'Insufficient quote asset balance", async () => {
              subjectComponentAmount = subjectComponentAmount.add(1);
              await expect(subject()).to.be.revertedWith("Insufficient quote asset balance");
            });
          });
        });

        describe("when the index does not have enough of the quote asset to meet the buy auction size", async () => {
          beforeEach(async () => {
            const oldComponentsAuctionParams: AuctionExecutionParams[] = [
              {
                targetUnit: ZERO,
                priceAdapterName: AdapterNames.CONSTANT_PRICE_ADAPTER,
                priceAdapterConfigData: defaultDaiData
              },
              {
                targetUnit: bitcoin(10.5),
                priceAdapterName: AdapterNames.CONSTANT_PRICE_ADAPTER,
                priceAdapterConfigData: defaultWbtcData
              },
              {
                targetUnit: ether(4),
                priceAdapterName: AdapterNames.CONSTANT_PRICE_ADAPTER,
                priceAdapterConfigData: defaultWethData
              }
            ];

            await startRebalance(
              indexWithQuoteAsset.address,
              defaultQuoteAsset,
              defaultNewComponents,
              defaultNewComponentsAuctionParams,
              oldComponentsAuctionParams,
              defaultShouldLockSetToken,
              defaultDuration,
              defaultPositionMultiplier
            );
            await fundBidder(setup.wbtc, bitcoin(10));

            subjectSetToken = indexWithQuoteAsset;
            subjectComponent = setup.wbtc.address;
            subjectComponentAmount = bitcoin(10);
            subjectQuoteAssetLimit = ether(145);
          });

          it("should revert for buy auction quantities greater than the available capital with 'Insufficient quote asset balance'", async () => {
            await expect(subject()).to.be.revertedWith("Insufficient quote asset balance");
          });

          it("should allow buy auction for up to the amount of available capital", async () => {
            subjectComponentAmount = bitcoin(0.344827);
            subjectQuoteAssetLimit = ether(4.9);
            await subject(); // should not revert
          });
        });

        describe("when adding a new component to the index that is not the quote asset", async () => {
          beforeEach(async () => {
            const usdcPerWethDecimalFactor = ether(1).div(usdc(1));
            const usdcPerWethPrice = ether(0.0005).mul(usdcPerWethDecimalFactor);
            const usdcPerWethBytes = await constantPriceAdapter.getEncodedData(usdcPerWethPrice);
            const indexUsdcAuctionExecutionParams = {
              targetUnit: usdc(100),
              priceAdapterName: AdapterNames.CONSTANT_PRICE_ADAPTER,
              priceAdapterConfigData: usdcPerWethBytes
            } as AuctionExecutionParams;

            const newComponents = [setup.usdc.address];
            const newComponentsAuctionParams = [indexUsdcAuctionExecutionParams];

            await startRebalance(
              indexWithQuoteAsset.address,
              defaultQuoteAsset,
              newComponents,
              newComponentsAuctionParams,
              defaultOldComponentsAuctionParams,
              defaultShouldLockSetToken,
              defaultDuration,
              defaultPositionMultiplier
            );

            await fundBidder(setup.usdc, usdc(100));

            subjectSetToken = indexWithQuoteAsset;
            subjectComponent = setup.usdc.address;
            subjectComponentAmount = usdc(100);
            subjectQuoteAssetLimit = ether(0.05);
          });

          it("should add the component to the SetToken", async () => {
            const components = await subjectSetToken.getComponents();
            expect(components).to.not.contain(subjectComponent);

            await subject();

            const postComponents = await subjectSetToken.getComponents();

            expect(postComponents).to.contain(subjectComponent);
            expect(postComponents.length).to.eq(components.length + 1);
          });
        });
      });

      describe("when the bid is priced using the BoundedStepwiseLinearPriceAdapter", async () => {
        let oldComponentsAuctionParams: AuctionExecutionParams[];

        beforeEach(async () => {
          const daiLinearCurveParams = await boundedStepwiseLinearPriceAdapter.getEncodedData(
            ether(0.00055),
            ether(0.00001),
            ONE_HOUR_IN_SECONDS,
            true,
            ether(0.00055),
            ether(0.00049)
          );

          const wbtcPerWethDecimalFactor = ether(1).div(bitcoin(1));
          const wbtcLinearCurveParams = await boundedStepwiseLinearPriceAdapter.getEncodedData(
            ether(14).mul(wbtcPerWethDecimalFactor),
            ether(0.1).mul(wbtcPerWethDecimalFactor),
            ONE_HOUR_IN_SECONDS,
            false,
            ether(15).mul(wbtcPerWethDecimalFactor),
            ether(14).mul(wbtcPerWethDecimalFactor),
          );

          const wethLinearCurveParams = await boundedStepwiseLinearPriceAdapter.getEncodedData(
            ether(1),
            0,
            ONE_HOUR_IN_SECONDS,
            false,
            ether(1),
            ether(1),
          );

          oldComponentsAuctionParams = [
            {
              targetUnit: ether(9100),
              priceAdapterName: AdapterNames.BOUNDED_STEPWISE_LINEAR_PRICE_ADAPTER,
              priceAdapterConfigData: daiLinearCurveParams
            },
            {
              targetUnit: bitcoin(.6),
              priceAdapterName: AdapterNames.BOUNDED_STEPWISE_LINEAR_PRICE_ADAPTER,
              priceAdapterConfigData: wbtcLinearCurveParams
            },
            {
              targetUnit: ether(4),
              priceAdapterName: AdapterNames.CONSTANT_PRICE_ADAPTER,
              priceAdapterConfigData: wethLinearCurveParams
            }
          ];

          await startRebalance(
            subjectSetToken.address,
            defaultQuoteAsset,
            defaultNewComponents,
            defaultNewComponentsAuctionParams,
            oldComponentsAuctionParams,
            defaultShouldLockSetToken,
            defaultDuration,
            defaultPositionMultiplier
          );

          subjectIncreaseTime = ONE_HOUR_IN_SECONDS.mul(5);
        });


        describe("when the bid is placed on a component sell auction", async () => {
          beforeEach(async () => {
            await fundBidder();
          });

          it("updates position units and transfers tokens correctly on a component sell auction with BoundedStepwiseLinearPriceAdapter", async () => {
            const preBidBalances = {
              bidderDai: await setup.dai.balanceOf(bidder.address),
              bidderWeth: await setup.weth.balanceOf(bidder.address),
              setTokenDai: await setup.dai.balanceOf(subjectSetToken.address),
              setTokenWeth: await setup.weth.balanceOf(subjectSetToken.address)
            };
            const setTokenTotalSupply = await subjectSetToken.totalSupply();

            await subject();

            const expectedWethPositionUnits = preciseDiv(preBidBalances.setTokenWeth.add(subjectQuoteAssetLimit), setTokenTotalSupply);
            const expectedDaiPositionUnits = preciseDiv(preBidBalances.setTokenDai.sub(subjectComponentAmount), setTokenTotalSupply);

            const wethPositionUnits = await subjectSetToken.getDefaultPositionRealUnit(setup.weth.address);
            const daiPositionUnits = await subjectSetToken.getDefaultPositionRealUnit(setup.dai.address);

            expect(wethPositionUnits).to.eq(expectedWethPositionUnits);
            expect(daiPositionUnits).to.eq(expectedDaiPositionUnits);

            const postBidBalances = {
              bidderDai: await setup.dai.balanceOf(bidder.address),
              bidderWeth: await setup.weth.balanceOf(bidder.address),
              setTokenDai: await setup.dai.balanceOf(subjectSetToken.address),
              setTokenWeth: await setup.weth.balanceOf(subjectSetToken.address)
            };

            expect(postBidBalances.bidderDai).to.eq(preBidBalances.bidderDai.add(subjectComponentAmount));
            expect(postBidBalances.bidderWeth).to.eq(preBidBalances.bidderWeth.sub(subjectQuoteAssetLimit));
            expect(postBidBalances.setTokenDai).to.eq(preBidBalances.setTokenDai.sub(subjectComponentAmount));
            expect(postBidBalances.setTokenWeth).to.eq(preBidBalances.setTokenWeth.add(subjectQuoteAssetLimit));
          });

          it("emits the correct BidExecuted event", async () => {
            const totalSupply = await subjectSetToken.totalSupply();

            await expect(subject()).to.emit(auctionModule, "BidExecuted").withArgs(
              subjectSetToken.address,
              subjectComponent,
              defaultQuoteAsset,
              subjectCaller.address,
              boundedStepwiseLinearPriceAdapter.address,
              true,
              defaultDaiPrice,
              subjectComponentAmount,
              subjectQuoteAssetLimit,
              0,
              totalSupply
            );
          });
        });

        describe("when the bid is placed on a component buy auction", async () => {
          beforeEach(async () => {
            await fundBidder(setup.wbtc, bitcoin(0.1));

            subjectComponent = setup.wbtc.address;
            subjectComponentAmount = bitcoin(0.1);
            subjectQuoteAssetLimit = ether(1.45);
          });

          it("updates position units and transfers tokens correctly on a component buy auction with BoundedStepwiseLinearPriceAdapter", async () => {
            const preBidBalances = {
              bidderWbtc: await setup.wbtc.balanceOf(bidder.address),
              bidderWeth: await setup.weth.balanceOf(bidder.address),
              setTokenWbtc: await setup.wbtc.balanceOf(subjectSetToken.address),
              setTokenWeth: await setup.weth.balanceOf(subjectSetToken.address)
            };
            const setTokenTotalSupply = await subjectSetToken.totalSupply();

            await subject();

            const expectedWethPositionUnits = preciseDiv(preBidBalances.setTokenWeth.sub(subjectQuoteAssetLimit), setTokenTotalSupply);
            const expectedWbtcPositionUnits = preciseDiv(preBidBalances.setTokenWbtc.add(subjectComponentAmount), setTokenTotalSupply);

            const wethPositionUnits = await subjectSetToken.getDefaultPositionRealUnit(setup.weth.address);
            const wbtcPositionUnits = await subjectSetToken.getDefaultPositionRealUnit(setup.wbtc.address);

            expect(wethPositionUnits).to.eq(expectedWethPositionUnits);
            expect(wbtcPositionUnits).to.eq(expectedWbtcPositionUnits);

            const postBidBalances = {
              bidderWbtc: await setup.wbtc.balanceOf(bidder.address),
              bidderWeth: await setup.weth.balanceOf(bidder.address),
              setTokenWbtc: await setup.wbtc.balanceOf(subjectSetToken.address),
              setTokenWeth: await setup.weth.balanceOf(subjectSetToken.address)
            };

            expect(postBidBalances.bidderWbtc).to.eq(preBidBalances.bidderWbtc.sub(subjectComponentAmount));
            expect(postBidBalances.bidderWeth).to.eq(preBidBalances.bidderWeth.add(subjectQuoteAssetLimit));
            expect(postBidBalances.setTokenWbtc).to.eq(preBidBalances.setTokenWbtc.add(subjectComponentAmount));
            expect(postBidBalances.setTokenWeth).to.eq(preBidBalances.setTokenWeth.sub(subjectQuoteAssetLimit));
          });

          it("emits the correct BidExecuted event", async () => {
            const totalSupply = await subjectSetToken.totalSupply();

            await expect(subject()).to.emit(auctionModule, "BidExecuted").withArgs(
              subjectSetToken.address,
              defaultQuoteAsset,
              subjectComponent,
              subjectCaller.address,
              boundedStepwiseLinearPriceAdapter.address,
              defaultShouldLockSetToken,
              defaultWbtcPrice,
              subjectQuoteAssetLimit,
              subjectComponentAmount,
              0,
              totalSupply
            );
          });
        });
      });

      describe("when the bid is priced using the BoundedStepwiseExponentialPriceAdapter", async () => {
        let oldComponentsAuctionParams: AuctionExecutionParams[];

        beforeEach(async () => {
          const daiExponentialCurveParams = await boundedStepwiseExponentialPriceAdapter.getEncodedData(
            ether(0.0005),
            1,
            ether(0.00001),
            ONE_HOUR_IN_SECONDS,
            true,
            ether(0.00055),
            ether(0.00049)
          );

          const wbtcPerWethDecimalFactor = ether(1).div(bitcoin(1));
          const wbtcExponentialCurveParams = await boundedStepwiseExponentialPriceAdapter.getEncodedData(
            ether(14.5).mul(wbtcPerWethDecimalFactor),
            1,
            ether(0.1).mul(wbtcPerWethDecimalFactor),
            ONE_HOUR_IN_SECONDS,
            false,
            ether(15).mul(wbtcPerWethDecimalFactor),
            ether(14).mul(wbtcPerWethDecimalFactor),
          );

          const wethExponentialCurveParams = await boundedStepwiseExponentialPriceAdapter.getEncodedData(
            ether(1),
            1,
            ether(0.1),
            ONE_HOUR_IN_SECONDS,
            false,
            ether(1),
            ether(1),
          );

          oldComponentsAuctionParams = [
            {
              targetUnit: ether(9100),
              priceAdapterName: AdapterNames.BOUNDED_STEPWISE_EXPONENTIAL_PRICE_ADAPTER,
              priceAdapterConfigData: daiExponentialCurveParams
            },
            {
              targetUnit: bitcoin(.6),
              priceAdapterName: AdapterNames.BOUNDED_STEPWISE_EXPONENTIAL_PRICE_ADAPTER,
              priceAdapterConfigData: wbtcExponentialCurveParams
            },
            {
              targetUnit: ether(4),
              priceAdapterName: AdapterNames.BOUNDED_STEPWISE_EXPONENTIAL_PRICE_ADAPTER,
              priceAdapterConfigData: wethExponentialCurveParams
            }
          ];

          await startRebalance(
            subjectSetToken.address,
            defaultQuoteAsset,
            defaultNewComponents,
            defaultNewComponentsAuctionParams,
            oldComponentsAuctionParams,
            defaultShouldLockSetToken,
            defaultDuration,
            defaultPositionMultiplier
          );

          subjectIncreaseTime = ZERO;
        });


        describe("when the bid is placed on a component sell auction", async () => {
          beforeEach(async () => {
            await fundBidder();
          });

          it("updates position units and transfers tokens correctly on a sell auction with BoundedStepwiseExponentialPriceAdapter", async () => {
            const preBidBalances = {
              bidderDai: await setup.dai.balanceOf(bidder.address),
              bidderWeth: await setup.weth.balanceOf(bidder.address),
              setTokenDai: await setup.dai.balanceOf(subjectSetToken.address),
              setTokenWeth: await setup.weth.balanceOf(subjectSetToken.address)
            };
            const setTokenTotalSupply = await subjectSetToken.totalSupply();

            await subject();

            const expectedWethPositionUnits = preciseDiv(preBidBalances.setTokenWeth.add(subjectQuoteAssetLimit), setTokenTotalSupply);
            const expectedDaiPositionUnits = preciseDiv(preBidBalances.setTokenDai.sub(subjectComponentAmount), setTokenTotalSupply);

            const wethPositionUnits = await subjectSetToken.getDefaultPositionRealUnit(setup.weth.address);
            const daiPositionUnits = await subjectSetToken.getDefaultPositionRealUnit(setup.dai.address);

            expect(wethPositionUnits).to.eq(expectedWethPositionUnits);
            expect(daiPositionUnits).to.eq(expectedDaiPositionUnits);

            const postBidBalances = {
              bidderDai: await setup.dai.balanceOf(bidder.address),
              bidderWeth: await setup.weth.balanceOf(bidder.address),
              setTokenDai: await setup.dai.balanceOf(subjectSetToken.address),
              setTokenWeth: await setup.weth.balanceOf(subjectSetToken.address)
            };

            expect(postBidBalances.bidderDai).to.eq(preBidBalances.bidderDai.add(subjectComponentAmount));
            expect(postBidBalances.bidderWeth).to.eq(preBidBalances.bidderWeth.sub(subjectQuoteAssetLimit));
            expect(postBidBalances.setTokenDai).to.eq(preBidBalances.setTokenDai.sub(subjectComponentAmount));
            expect(postBidBalances.setTokenWeth).to.eq(preBidBalances.setTokenWeth.add(subjectQuoteAssetLimit));
          });

          it("emits the correct BidExecuted event", async () => {
            const totalSupply = await subjectSetToken.totalSupply();

            await expect(subject()).to.emit(auctionModule, "BidExecuted").withArgs(
              subjectSetToken.address,
              subjectComponent,
              defaultQuoteAsset,
              subjectCaller.address,
              boundedStepwiseExponentialPriceAdapter.address,
              true,
              defaultDaiPrice,
              subjectComponentAmount,
              subjectQuoteAssetLimit,
              0,
              totalSupply
            );
          });
        });

        describe("when the bid is placed on a component buy auction", async () => {
          beforeEach(async () => {
            await fundBidder(setup.wbtc, bitcoin(0.1));

            subjectComponent = setup.wbtc.address;
            subjectComponentAmount = bitcoin(0.1);
            subjectQuoteAssetLimit = ether(1.45);
          });

          it("updates position units and transfers tokens correctly on a buy auction with BoundedStepwiseExponentialPriceAdapter", async () => {
            const preBidBalances = {
              bidderWbtc: await setup.wbtc.balanceOf(bidder.address),
              bidderWeth: await setup.weth.balanceOf(bidder.address),
              setTokenWbtc: await setup.wbtc.balanceOf(subjectSetToken.address),
              setTokenWeth: await setup.weth.balanceOf(subjectSetToken.address)
            };
            const setTokenTotalSupply = await subjectSetToken.totalSupply();

            await subject();

            const expectedWethPositionUnits = preciseDiv(preBidBalances.setTokenWeth.sub(subjectQuoteAssetLimit), setTokenTotalSupply);
            const expectedWbtcPositionUnits = preciseDiv(preBidBalances.setTokenWbtc.add(subjectComponentAmount), setTokenTotalSupply);

            const wethPositionUnits = await subjectSetToken.getDefaultPositionRealUnit(setup.weth.address);
            const wbtcPositionUnits = await subjectSetToken.getDefaultPositionRealUnit(setup.wbtc.address);

            expect(wethPositionUnits).to.eq(expectedWethPositionUnits);
            expect(wbtcPositionUnits).to.eq(expectedWbtcPositionUnits);

            const postBidBalances = {
              bidderWbtc: await setup.wbtc.balanceOf(bidder.address),
              bidderWeth: await setup.weth.balanceOf(bidder.address),
              setTokenWbtc: await setup.wbtc.balanceOf(subjectSetToken.address),
              setTokenWeth: await setup.weth.balanceOf(subjectSetToken.address)
            };

            expect(postBidBalances.bidderWbtc).to.eq(preBidBalances.bidderWbtc.sub(subjectComponentAmount));
            expect(postBidBalances.bidderWeth).to.eq(preBidBalances.bidderWeth.add(subjectQuoteAssetLimit));
            expect(postBidBalances.setTokenWbtc).to.eq(preBidBalances.setTokenWbtc.add(subjectComponentAmount));
            expect(postBidBalances.setTokenWeth).to.eq(preBidBalances.setTokenWeth.sub(subjectQuoteAssetLimit));
          });

          it("emits the correct BidExecuted event", async () => {
            const totalSupply = await subjectSetToken.totalSupply();

            await expect(subject()).to.emit(auctionModule, "BidExecuted").withArgs(
              subjectSetToken.address,
              defaultQuoteAsset,
              subjectComponent,
              subjectCaller.address,
              boundedStepwiseExponentialPriceAdapter.address,
              defaultShouldLockSetToken,
              defaultWbtcPrice,
              subjectQuoteAssetLimit,
              subjectComponentAmount,
              0,
              totalSupply
            );
          });
        });
      });

      describe("when the bid is priced using the BoundedStepwiseLogarithmicPriceAdapter", async () => {
        let oldComponentsAuctionParams: AuctionExecutionParams[];

        beforeEach(async () => {
          const daiLogarithmicCurveParams = await boundedStepwiseLogarithmicPriceAdapter.getEncodedData(
            ether(0.0005),
            1,
            ether(0.00001),
            ONE_HOUR_IN_SECONDS,
            true,
            ether(0.00055),
            ether(0.00049)
          );

          const wbtcPerWethDecimalFactor = ether(1).div(bitcoin(1));
          const wbtcLogarithmicCurveParams = await boundedStepwiseLogarithmicPriceAdapter.getEncodedData(
            ether(14.5).mul(wbtcPerWethDecimalFactor),
            1,
            ether(0.1).mul(wbtcPerWethDecimalFactor),
            ONE_HOUR_IN_SECONDS,
            false,
            ether(15).mul(wbtcPerWethDecimalFactor),
            ether(14).mul(wbtcPerWethDecimalFactor),
          );

          const wethLogarithmicCurveParams = await boundedStepwiseLogarithmicPriceAdapter.getEncodedData(
            ether(1),
            1,
            ether(0.1),
            ONE_HOUR_IN_SECONDS,
            false,
            ether(1),
            ether(1),
          );

          oldComponentsAuctionParams = [
            {
              targetUnit: ether(9100),
              priceAdapterName: AdapterNames.BOUNDED_STEPWISE_LOGARITHMIC_PRICE_ADAPTER,
              priceAdapterConfigData: daiLogarithmicCurveParams
            },
            {
              targetUnit: bitcoin(.6),
              priceAdapterName: AdapterNames.BOUNDED_STEPWISE_LOGARITHMIC_PRICE_ADAPTER,
              priceAdapterConfigData: wbtcLogarithmicCurveParams
            },
            {
              targetUnit: ether(4),
              priceAdapterName: AdapterNames.BOUNDED_STEPWISE_LOGARITHMIC_PRICE_ADAPTER,
              priceAdapterConfigData: wethLogarithmicCurveParams
            }
          ];

          await startRebalance(
            subjectSetToken.address,
            defaultQuoteAsset,
            defaultNewComponents,
            defaultNewComponentsAuctionParams,
            oldComponentsAuctionParams,
            defaultShouldLockSetToken,
            defaultDuration,
            defaultPositionMultiplier
          );

          subjectIncreaseTime = ZERO;
        });


        describe("when the bid is placed on a component sell auction", async () => {
          beforeEach(async () => {
            await fundBidder();
          });

          it("updates position units and transfers tokens correctly on a sell auction with BoundedStepwiseLogarithmicPriceAdapter", async () => {
            const preBidBalances = {
              bidderDai: await setup.dai.balanceOf(bidder.address),
              bidderWeth: await setup.weth.balanceOf(bidder.address),
              setTokenDai: await setup.dai.balanceOf(subjectSetToken.address),
              setTokenWeth: await setup.weth.balanceOf(subjectSetToken.address)
            };
            const setTokenTotalSupply = await subjectSetToken.totalSupply();

            await subject();

            const expectedWethPositionUnits = preciseDiv(preBidBalances.setTokenWeth.add(subjectQuoteAssetLimit), setTokenTotalSupply);
            const expectedDaiPositionUnits = preciseDiv(preBidBalances.setTokenDai.sub(subjectComponentAmount), setTokenTotalSupply);

            const wethPositionUnits = await subjectSetToken.getDefaultPositionRealUnit(setup.weth.address);
            const daiPositionUnits = await subjectSetToken.getDefaultPositionRealUnit(setup.dai.address);

            expect(wethPositionUnits).to.eq(expectedWethPositionUnits);
            expect(daiPositionUnits).to.eq(expectedDaiPositionUnits);

            const postBidBalances = {
              bidderDai: await setup.dai.balanceOf(bidder.address),
              bidderWeth: await setup.weth.balanceOf(bidder.address),
              setTokenDai: await setup.dai.balanceOf(subjectSetToken.address),
              setTokenWeth: await setup.weth.balanceOf(subjectSetToken.address)
            };

            expect(postBidBalances.bidderDai).to.eq(preBidBalances.bidderDai.add(subjectComponentAmount));
            expect(postBidBalances.bidderWeth).to.eq(preBidBalances.bidderWeth.sub(subjectQuoteAssetLimit));
            expect(postBidBalances.setTokenDai).to.eq(preBidBalances.setTokenDai.sub(subjectComponentAmount));
            expect(postBidBalances.setTokenWeth).to.eq(preBidBalances.setTokenWeth.add(subjectQuoteAssetLimit));
          });

          it("emits the correct BidExecuted event", async () => {
            const totalSupply = await subjectSetToken.totalSupply();

            await expect(subject()).to.emit(auctionModule, "BidExecuted").withArgs(
              subjectSetToken.address,
              subjectComponent,
              defaultQuoteAsset,
              subjectCaller.address,
              boundedStepwiseLogarithmicPriceAdapter.address,
              true,
              defaultDaiPrice,
              subjectComponentAmount,
              subjectQuoteAssetLimit,
              0,
              totalSupply
            );
          });
        });

        describe("when the bid is placed on a component buy auction", async () => {
          beforeEach(async () => {
            await fundBidder(setup.wbtc, bitcoin(0.1));

            subjectComponent = setup.wbtc.address;
            subjectComponentAmount = bitcoin(0.1);
            subjectQuoteAssetLimit = ether(1.45);
          });

          it("updates position units and transfers tokens correctly on a buy auction with BoundedStepwiseLogarithmicPriceAdapter", async () => {
            const preBidBalances = {
              bidderWbtc: await setup.wbtc.balanceOf(bidder.address),
              bidderWeth: await setup.weth.balanceOf(bidder.address),
              setTokenWbtc: await setup.wbtc.balanceOf(subjectSetToken.address),
              setTokenWeth: await setup.weth.balanceOf(subjectSetToken.address)
            };
            const setTokenTotalSupply = await subjectSetToken.totalSupply();

            await subject();

            const expectedWethPositionUnits = preciseDiv(preBidBalances.setTokenWeth.sub(subjectQuoteAssetLimit), setTokenTotalSupply);
            const expectedWbtcPositionUnits = preciseDiv(preBidBalances.setTokenWbtc.add(subjectComponentAmount), setTokenTotalSupply);

            const wethPositionUnits = await subjectSetToken.getDefaultPositionRealUnit(setup.weth.address);
            const wbtcPositionUnits = await subjectSetToken.getDefaultPositionRealUnit(setup.wbtc.address);

            expect(wethPositionUnits).to.eq(expectedWethPositionUnits);
            expect(wbtcPositionUnits).to.eq(expectedWbtcPositionUnits);

            const postBidBalances = {
              bidderWbtc: await setup.wbtc.balanceOf(bidder.address),
              bidderWeth: await setup.weth.balanceOf(bidder.address),
              setTokenWbtc: await setup.wbtc.balanceOf(subjectSetToken.address),
              setTokenWeth: await setup.weth.balanceOf(subjectSetToken.address)
            };

            expect(postBidBalances.bidderWbtc).to.eq(preBidBalances.bidderWbtc.sub(subjectComponentAmount));
            expect(postBidBalances.bidderWeth).to.eq(preBidBalances.bidderWeth.add(subjectQuoteAssetLimit));
            expect(postBidBalances.setTokenWbtc).to.eq(preBidBalances.setTokenWbtc.add(subjectComponentAmount));
            expect(postBidBalances.setTokenWeth).to.eq(preBidBalances.setTokenWeth.sub(subjectQuoteAssetLimit));
          });

          it("emits the correct BidExecuted event", async () => {
            const totalSupply = await subjectSetToken.totalSupply();

            await expect(subject()).to.emit(auctionModule, "BidExecuted").withArgs(
              subjectSetToken.address,
              defaultQuoteAsset,
              subjectComponent,
              subjectCaller.address,
              boundedStepwiseLogarithmicPriceAdapter.address,
              defaultShouldLockSetToken,
              defaultWbtcPrice,
              subjectQuoteAssetLimit,
              subjectComponentAmount,
              0,
              totalSupply
            );
          });
        });
      });

      describe("when the rebalance duration has elapsed", async () => {
        beforeEach(async () => {
          await startRebalance();

          subjectIncreaseTime = ONE_DAY_IN_SECONDS.mul(5).add(1);
        });

        it("should revert with 'Rebalance must be in progress'", async () => {
          await expect(subject()).to.be.revertedWith("Rebalance must be in progress");
        });
      });

      describe("when there are external positions for a component", async () => {
        beforeEach(async () => {
          await startRebalance();
          await fundBidder();
          await subject();

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

        it("should revert with 'External positions not allowed'", async () => {
          await expect(subject()).to.be.revertedWith("External positions not allowed");
        });
      });

      describe("when the price adapter has been removed from integration registry", async () => {
        beforeEach(async () => {
          await startRebalance();
          await fundBidder();

          await setup.integrationRegistry.removeIntegration(auctionModule.address, AdapterNames.CONSTANT_PRICE_ADAPTER);
        });

        afterEach(async () => {
          await setup.integrationRegistry.addIntegration(
            auctionModule.address,
            AdapterNames.CONSTANT_PRICE_ADAPTER,
            constantPriceAdapter.address
          );
        });

        it("should revert with 'Must be valid adapter'", async () => {
          await expect(subject()).to.be.revertedWith("Must be valid adapter");
        });
      });

      describe("when isAnyoneAllowedToBid is true and a random address calls", async () => {
        beforeEach(async () => {
          await startRebalance();

          // Set isAnyoneAllowedToBid to true
          await auctionModule.setAnyoneBid(subjectSetToken.address, true);
          subjectCaller = await getRandomAccount();

          // Fund random address with WETH
          await setup.weth.connect(owner.wallet).transfer(subjectCaller.address, ether(1));
          await setup.weth.connect(subjectCaller.wallet).approve(auctionModule.address, ether(1));
        });

        it("the bid should not revert", async () => {
          await expect(subject()).to.not.be.reverted;
        });
      });

      describe("when isAnyoneAllowedToBid is false and a random address calls", async () => {
        beforeEach(async () => {
          await startRebalance();
          subjectCaller = await getRandomAccount();
        });

        it("should revert with 'Address not permitted to bid'", async () => {
          await expect(subject()).to.be.revertedWith("Address not permitted to bid");
        });
      });

      describe("when the passed component is not included in the rebalance", async () => {
        beforeEach(async () => {
          await startRebalance();
          await fundBidder();
          subjectComponent = setup.usdc.address;
        });

        it("should revert with 'Component not part of rebalance'", async () => {
          await expect(subject()).to.be.revertedWith("Component not part of rebalance");
        });
      });

      describe("when the bid is placed on the quote asset", async () => {
        beforeEach(async () => {
          await startRebalance();
          await fundBidder();

          subjectSetToken = indexWithQuoteAsset;
          subjectComponent = defaultQuoteAsset;
        });

        it("should revert with 'Cannot bid explicitly on Quote Asset'", async () => {
          expect(subject()).to.be.revertedWith("Cannot bid explicitly on Quote Asset");
        });
      });
    });
  });
});
