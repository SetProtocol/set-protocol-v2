import "module-alias/register";

import { Address } from "@utils/types";
import { Account } from "@utils/test/types";
import {
  PositionV2,
  PerpV2LibraryV2,
  PerpV2Positions,
  PerpV2LeverageModuleV2,
  DebtIssuanceMock,
  StandardTokenMock,
  SetToken
} from "@utils/contracts";

import { PerpV2BaseToken } from "@utils/contracts/perpV2";

import DeployHelper from "@utils/deploys";
import {
  ether,
  bitcoin,
  usdc as usdcUnits,
  preciseDiv,
  preciseMul
} from "@utils/index";

import {
  calculateExternalPositionUnit,
  calculateUSDCTransferIn,
  calculateUSDCTransferOut,
  calculateUSDCTransferInPreciseUnits,
  calculateUSDCTransferOutPreciseUnits,
  getUSDCDeltaDueToFundingGrowth,
  leverUp,
  toUSDCDecimals,
} from "@utils/common";

import {
  cacheBeforeEach,
  getAccounts,
  getWaffleExpect,
  getSystemFixture,
  getPerpV2Fixture,
  getRandomAccount,
  getRandomAddress,
  increaseTimeAsync
} from "@utils/test/index";

import { PerpV2Fixture, SystemFixture } from "@utils/fixtures";
import { ADDRESS_ZERO, ZERO, ZERO_BYTES, MAX_UINT_256, ONE_DAY_IN_SECONDS, ONE, TWO, THREE } from "@utils/constants";
import { BigNumber } from "ethers";

const expect = getWaffleExpect();

describe("PerpV2LeverageModuleV2", () => {
  let owner: Account;
  let maker: Account;
  let otherTrader: Account;
  let mockModule: Account;
  let deployer: DeployHelper;

  let positionLib: PositionV2;
  let perpLib: PerpV2LibraryV2;
  let perpPositionsLib: PerpV2Positions;
  let perpLeverageModule: PerpV2LeverageModuleV2;
  let debtIssuanceMock: DebtIssuanceMock;
  let setup: SystemFixture;
  let perpSetup: PerpV2Fixture;
  let maxPerpPositionsPerSet: BigNumber;

  let vETH: PerpV2BaseToken;
  let vBTC: PerpV2BaseToken;
  let usdc: StandardTokenMock;

  cacheBeforeEach(async () => {
    [
      owner,
      maker,
      otherTrader,
      mockModule,
    ] = await getAccounts();

    deployer = new DeployHelper(owner.wallet);
    setup = getSystemFixture(owner.address);
    await setup.initialize();

    perpSetup = getPerpV2Fixture(owner.address);
    await perpSetup.initialize(maker, otherTrader);

    // set funding rate to zero; allows us to avoid calculating small amounts of funding
    // accrued in our test cases
    await perpSetup.clearingHouseConfig.setMaxFundingRate(ZERO);

    vETH = perpSetup.vETH;
    vBTC = perpSetup.vBTC;
    usdc = perpSetup.usdc;

    // Create liquidity
    await perpSetup.setBaseTokenOraclePrice(vETH, usdcUnits(10));
    await perpSetup.initializePoolWithLiquidityWide(
      vETH,
      ether(10_000),
      ether(100_000)
    );

    await perpSetup.setBaseTokenOraclePrice(vBTC, usdcUnits(20));
    await perpSetup.initializePoolWithLiquidityWide(
      vBTC,
      ether(10_000),
      ether(200_000)
    );

    debtIssuanceMock = await deployer.mocks.deployDebtIssuanceMock();
    await setup.controller.addModule(debtIssuanceMock.address);

    maxPerpPositionsPerSet = TWO;

    // Deploy libraries
    positionLib = await deployer.libraries.deployPositionV2();
    perpLib = await deployer.libraries.deployPerpV2LibraryV2();
    perpPositionsLib = await deployer.libraries.deployPerpV2Positions();

    perpLeverageModule = await deployer.modules.deployPerpV2LeverageModuleV2(
      setup.controller.address,
      perpSetup.vault.address,
      perpSetup.quoter.address,
      perpSetup.marketRegistry.address,
      maxPerpPositionsPerSet,
      "contracts/protocol/lib/PositionV2.sol:PositionV2",
      positionLib.address,
      "contracts/protocol/integration/lib/PerpV2LibraryV2.sol:PerpV2LibraryV2",
      perpLib.address,
      "contracts/protocol/integration/lib/PerpV2Positions.sol:PerpV2Positions",
      perpPositionsLib.address,
    );
    await setup.controller.addModule(perpLeverageModule.address);

    await setup.integrationRegistry.addIntegration(
      perpLeverageModule.address,
      "DefaultIssuanceModule",
      debtIssuanceMock.address
    );
  });

  /**
   * HELPERS
   */

  // Creates SetToken, issues sets (default: 1), initializes PerpV2LeverageModuleV2 and deposits to Perp
  async function issueSetsAndDepositToPerp(
    depositQuantityUnit: BigNumber,
    isInitialized: boolean = true,
    issueQuantity: BigNumber = ether(1),
    skipMockModuleInitialization = false
  ): Promise<SetToken> {
    const setToken = await setup.createSetToken(
      [setup.wbtc.address, usdc.address, setup.weth.address],
      [bitcoin(10), usdcUnits(100), ether(10)],
      [perpLeverageModule.address, debtIssuanceMock.address, setup.issuanceModule.address]
    );

    if (isInitialized) {
      await debtIssuanceMock.initialize(setToken.address);
      await perpLeverageModule.updateAllowedSetToken(setToken.address, true);

      await perpLeverageModule.connect(owner.wallet).initialize(setToken.address);

      // Initialize mock module
      if (!skipMockModuleInitialization) {
        await setup.controller.addModule(mockModule.address);
        await setToken.addModule(mockModule.address);
        await setToken.connect(mockModule.wallet).initializeModule();
      }

      await usdc.approve(setup.issuanceModule.address, preciseMul(usdcUnits(100), issueQuantity));
      await setup.issuanceModule.initialize(setToken.address, ADDRESS_ZERO);
      await setup.issuanceModule.issue(setToken.address, issueQuantity, owner.address);

      await perpLeverageModule.deposit(setToken.address, depositQuantityUnit);
    }

    return setToken;
  }

  async function syncOracleToSpot(baseToken: PerpV2BaseToken): Promise<void> {
    const baseTokenSpotPrice = await perpSetup.getSpotPrice(baseToken.address);
    await perpSetup.setBaseTokenOraclePrice(baseToken, baseTokenSpotPrice.div(10 ** 12));
  }

  describe("#constructor", async () => {
    let subjectController: Address;
    let subjectVault: Address;
    let subjectQuoter: Address;
    let subjectMarketRegistry: Address;
    let subjectMaxPerpPositionsPerSet: BigNumber;

    beforeEach(async () => {
      subjectController = setup.controller.address;
      subjectVault = perpSetup.vault.address;
      subjectQuoter = perpSetup.quoter.address;
      subjectMarketRegistry = perpSetup.marketRegistry.address;
      subjectMaxPerpPositionsPerSet = ONE;
    });

    async function subject(): Promise<PerpV2LeverageModuleV2> {
      return deployer.modules.deployPerpV2LeverageModuleV2(
        subjectController,
        subjectVault,
        subjectQuoter,
        subjectMarketRegistry,
        subjectMaxPerpPositionsPerSet,
        "contracts/protocol/lib/PositionV2.sol:PositionV2",
        positionLib.address,
        "contracts/protocol/integration/lib/PerpV2LibraryV2.sol:PerpV2LibraryV2",
        perpLib.address,
        "contracts/protocol/integration/lib/PerpV2Positions.sol:PerpV2Positions",
        perpPositionsLib.address
      );
    }

    it("should set the correct controller", async () => {
      const perpLeverageModule = await subject();

      const controller = await perpLeverageModule.controller();
      expect(controller).to.eq(subjectController);
    });

    it("should set the correct PerpV2 contracts and collateralToken", async () => {
      const perpLeverageModule = await subject();

      const perpAccountBalance = await perpLeverageModule.perpAccountBalance();
      const perpClearingHouse = await perpLeverageModule.perpClearingHouse();
      const perpExchange = await perpLeverageModule.perpExchange();
      const perpVault = await perpLeverageModule.perpVault();
      const perpQuoter = await perpLeverageModule.perpQuoter();
      const perpMarketRegistry = await perpLeverageModule.perpMarketRegistry();
      const collateralToken = await perpLeverageModule.collateralToken();

      expect(perpAccountBalance).to.eq(perpSetup.accountBalance.address);
      expect(perpClearingHouse).to.eq(perpSetup.clearingHouse.address);
      expect(perpExchange).to.eq(perpSetup.exchange.address);
      expect(perpVault).to.eq(perpSetup.vault.address);
      expect(perpQuoter).to.eq(perpSetup.quoter.address);
      expect(perpMarketRegistry).to.eq(perpSetup.marketRegistry.address);
      expect(collateralToken).to.eq(perpSetup.usdc.address);
    });

    it("should set the correct max perp positions per Set", async () => {
      const perpLeverageModule = await subject();

      const maxPerpPositionsPerSet = await perpLeverageModule.maxPerpPositionsPerSet();

      expect(maxPerpPositionsPerSet).to.eq(ONE);
    });
  });

  describe("#initialize", async () => {
    let setToken: SetToken;
    let isAllowListed: boolean;
    let subjectSetToken: Address;
    let subjectCaller: Account;

    const initializeContracts = async () => {
      setToken = await setup.createSetToken(
        [usdc.address],
        [ether(100)],
        [perpLeverageModule.address, debtIssuanceMock.address]
      );
      await debtIssuanceMock.initialize(setToken.address);

      if (isAllowListed) {
        // Add SetToken to allow list
        await perpLeverageModule.updateAllowedSetToken(setToken.address, true);
      }
    };

    const initializeSubjectVariables = () => {
      subjectSetToken = setToken.address;
      subjectCaller = owner;
    };

    async function subject(): Promise<any> {
      return perpLeverageModule.connect(subjectCaller.wallet).initialize(
        subjectSetToken,
      );
    }

    describe("when isAllowListed is true", () => {
      before(async () => {
        isAllowListed = true;
      });

      cacheBeforeEach(initializeContracts);
      beforeEach(initializeSubjectVariables);

      it("should enable the Module on the SetToken", async () => {
        await subject();
        const isModuleEnabled = await setToken.isInitializedModule(perpLeverageModule.address);
        expect(isModuleEnabled).to.eq(true);
      });

      it("should register on the debt issuance module", async () => {
        await subject();
        const isRegistered = await debtIssuanceMock.isRegistered(setToken.address);
        expect(isRegistered).to.be.true;
      });

      describe("when debt issuance module is not added to integration registry", async () => {
        beforeEach(async () => {
          await setup.integrationRegistry.removeIntegration(perpLeverageModule.address, "DefaultIssuanceModule");
        });

        afterEach(async () => {
          // Add debt issuance address to integration
          await setup.integrationRegistry.addIntegration(
            perpLeverageModule.address,
            "DefaultIssuanceModule",
            debtIssuanceMock.address
          );
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("Must be valid adapter");
        });
      });

      describe("when debt issuance module is not initialized on SetToken", async () => {
        beforeEach(async () => {
          await setToken.removeModule(debtIssuanceMock.address);
        });

        afterEach(async () => {
          await setToken.addModule(debtIssuanceMock.address);
          await debtIssuanceMock.initialize(setToken.address);
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("Issuance not initialized");
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

          const perpLeverageModuleNotPendingSetToken = await setup.createSetToken(
            [usdc.address],
            [usdcUnits(100)],
            [newModule]
          );

          subjectSetToken = perpLeverageModuleNotPendingSetToken.address;
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("Must be pending initialization");
        });
      });

      describe("when the SetToken is not enabled on the controller", async () => {
        beforeEach(async () => {
          const nonEnabledSetToken = await setup.createNonControllerEnabledSetToken(
            [setup.weth.address],
            [usdcUnits(100)],
            [perpLeverageModule.address]
          );

          subjectSetToken = nonEnabledSetToken.address;
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("Must be controller-enabled SetToken");
        });
      });
    });

    describe("when isAllowListed is false", async () => {
      before(async () => {
        isAllowListed = false;
      });

      cacheBeforeEach(initializeContracts);
      beforeEach(initializeSubjectVariables);

      describe("when SetToken is not allowlisted", async () => {
        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("Not allowed SetToken");
        });
      });

      describe("when any Set can initialize this module", async () => {
        beforeEach(async () => {
          await perpLeverageModule.updateAnySetAllowed(true);
        });

        it("should enable the Module on the SetToken", async () => {
          await subject();
          const isModuleEnabled = await setToken.isInitializedModule(perpLeverageModule.address);
          expect(isModuleEnabled).to.eq(true);
        });
      });
    });
  });

  describe("#trade", () => {
    let setToken: SetToken;
    let isInitialized: boolean = true;
    let depositQuantity: BigNumber;

    let subjectSetToken: Address;
    let subjectCaller: Account;
    let subjectBaseToken: Address;
    let subjectBaseTradeQuantityUnits: BigNumber;
    let subjectQuoteBoundQuantityUnits: BigNumber;

    const initializeContracts = async () => {
      depositQuantity = usdcUnits(10);
      setToken = await issueSetsAndDepositToPerp(depositQuantity, isInitialized);
    };

    const initializeSubjectVariables = async () => {
      subjectSetToken = setToken.address;
      subjectCaller = owner;
      subjectBaseToken = vETH.address;
    };

    cacheBeforeEach(initializeContracts);
    beforeEach(initializeSubjectVariables);

    async function subject(): Promise<any> {
      return await perpLeverageModule.connect(subjectCaller.wallet).trade(
        subjectSetToken,
        subjectBaseToken,
        subjectBaseTradeQuantityUnits,
        subjectQuoteBoundQuantityUnits
      );
    }

    describe("when module is initialized", async () => {
      describe("when going long", () => {
        describe("when no positions are open (total supply is 1)", async () => {
          beforeEach(async () => {
            // Long ~10 USDC of vETH
            subjectBaseTradeQuantityUnits = ether(1);
            subjectQuoteBoundQuantityUnits = ether(10.15);
          });

          it("should open the expected position", async () => {
            const totalSupply = await setToken.totalSupply();

            const expectedBaseBalance = preciseMul(subjectBaseTradeQuantityUnits, totalSupply);
            const expectedQuoteBalance =
              (await perpSetup.getSwapQuote(subjectBaseToken, subjectBaseTradeQuantityUnits, true)).deltaQuote;

            const initialPositionInfo = await perpLeverageModule.getPositionNotionalInfo(subjectSetToken);

            await subject();

            const finalPositionInfo = (await perpLeverageModule.getPositionNotionalInfo(subjectSetToken))[0];

            expect(initialPositionInfo.length).to.eq(0);
            expect(finalPositionInfo.baseBalance).gt(0);
            expect(finalPositionInfo.quoteBalance).lt(0);
            expect(finalPositionInfo.baseBalance).eq(expectedBaseBalance);
            expect(finalPositionInfo.quoteBalance).eq(expectedQuoteBalance.mul(-1));
            expect(finalPositionInfo.quoteBalance.mul(-1)).lt(subjectQuoteBoundQuantityUnits);
          });

          it("should emit the correct PerpTraded event", async () => {
            const {
              deltaBase: expectedDeltaBase,
              deltaQuote: expectedDeltaQuote
            } = await perpSetup.getSwapQuote(subjectBaseToken, subjectBaseTradeQuantityUnits, true);

            const expectedProtocolFee = ether(0);
            const expectedIsBuy = true;

            await expect(subject()).to.emit(perpLeverageModule, "PerpTraded").withArgs(
              subjectSetToken,
              subjectBaseToken,
              expectedDeltaBase,
              expectedDeltaQuote,
              expectedProtocolFee,
              expectedIsBuy
            );
          });

          it("should not update the USDC defaultPositionUnit", async () => {
            const initialDefaultPositionUnit = await setToken.getDefaultPositionRealUnit(usdc.address);
            await subject();
            const finalDefaultPositionUnit = await setToken.getDefaultPositionRealUnit(usdc.address);

            expect(initialDefaultPositionUnit).eq(finalDefaultPositionUnit);
          });

          it("should not update the USDC externalPositionUnit", async () => {
            const initialExternalPositionUnit = await setToken.getExternalPositionRealUnit(usdc.address, perpLeverageModule.address);
            await subject();
            const finalExternalPositionUnit = await setToken.getExternalPositionRealUnit(usdc.address, perpLeverageModule.address);

            expect(initialExternalPositionUnit).eq(finalExternalPositionUnit);
          });
        });

        describe("when trading on margin", async () => {
          beforeEach(async () => {
            // Long ~20 USDC of vETH with 10 USDC collateral
            subjectBaseTradeQuantityUnits = ether(2);
            subjectQuoteBoundQuantityUnits = ether(20.3);
          });

          it("should open expected position", async () => {
            const totalSupply = await setToken.totalSupply();
            const collateralBalance = (await perpLeverageModule.getAccountInfo(subjectSetToken)).collateralBalance;
            const quoteBalanceMin = preciseMul(subjectQuoteBoundQuantityUnits, totalSupply);

            const expectedQuoteBalance =
              (await perpSetup.getSwapQuote(subjectBaseToken, subjectBaseTradeQuantityUnits, true)).deltaQuote;

            await subject();

            const positionInfo = (await perpLeverageModule.getPositionNotionalInfo(subjectSetToken))[0];
            const expectedBaseBalance = preciseMul(subjectBaseTradeQuantityUnits, totalSupply);

            // Check that a levered trade happened
            expect(toUSDCDecimals(collateralBalance)).to.eq(depositQuantity);
            expect(toUSDCDecimals(quoteBalanceMin)).to.be.gt(depositQuantity);

            // Check balances
            expect(positionInfo.baseBalance).to.eq(expectedBaseBalance);
            expect(positionInfo.quoteBalance.mul(-1)).eq(expectedQuoteBalance);
            expect(positionInfo.quoteBalance.mul(-1)).to.be.lt(quoteBalanceMin);
          });
        });

        describe("when total supply is 2", async () => {
          let issueQuantity: BigNumber;
          let otherSetToken: SetToken;

          beforeEach(async () => {
            depositQuantity = usdcUnits(10);
            issueQuantity = ether(2);

            otherSetToken = await issueSetsAndDepositToPerp(
              depositQuantity,
              isInitialized,
              issueQuantity,
              true
            );

            subjectSetToken = otherSetToken.address;
            subjectBaseTradeQuantityUnits = ether(1);
            subjectQuoteBoundQuantityUnits = ether(10.15);
          });

          it("should open position for the expected amount", async () => {
            const totalSupply = await otherSetToken.totalSupply();
            const expectedBaseBalance = preciseMul(subjectBaseTradeQuantityUnits, totalSupply);

            await subject();

            const positionInfo = (await perpLeverageModule.getPositionNotionalInfo(subjectSetToken))[0];

            expect(totalSupply).eq(issueQuantity);
            expect(positionInfo.baseBalance).to.eq(expectedBaseBalance);
          });
        });

        describe("when slippage is greater than allowed", async () => {
          beforeEach(async () => {
            // Long ~10 USDC of vETH: slippage incurred as larger negative quote delta
            subjectBaseTradeQuantityUnits = ether(1);
            subjectQuoteBoundQuantityUnits = ether(10);
          });

          it("should revert", async () => {
            // ClearingHouse: too much quote received when long
            await expect(subject()).to.be.revertedWith("CH_TMRL");
          });
        });

        describe("when an existing position is long", async () => {
          beforeEach(async () => {
            subjectBaseTradeQuantityUnits = ether(1);
            subjectQuoteBoundQuantityUnits = ether(10.15);

            await perpLeverageModule.connect(subjectCaller.wallet).trade(
              subjectSetToken,
              subjectBaseToken,
              subjectBaseTradeQuantityUnits,
              subjectQuoteBoundQuantityUnits
            );
          });

          it("long trade should increase the position size", async () => {
            const totalSupply = await setToken.totalSupply();
            const initialPositionInfo = await perpLeverageModule.getPositionNotionalInfo(subjectSetToken);
            const expectedDeltaBase = preciseMul(subjectBaseTradeQuantityUnits, totalSupply);
            const expectedBaseBalance = initialPositionInfo[0].baseBalance.add(expectedDeltaBase);

            await subject();

            const finalPositionInfo = (await perpLeverageModule.getPositionNotionalInfo(subjectSetToken))[0];

            expect(initialPositionInfo.length).to.eq(1);
            expect(finalPositionInfo.baseBalance).eq(expectedBaseBalance);
          });
        });

        describe("when an existing position is short", async () => {
          beforeEach(async () => {
            // Short ~10 USDC vETH
            await perpLeverageModule.connect(subjectCaller.wallet).trade(
              subjectSetToken,
              subjectBaseToken,
              ether(-1),
              ether(9.85)
            );

            subjectBaseTradeQuantityUnits = ether(.5);
            subjectQuoteBoundQuantityUnits = ether(5.15);
          });

          it("long trade should reduce the position", async () => {
            const totalSupply = await setToken.totalSupply();
            const baseTradeQuantityNotional = preciseMul(subjectBaseTradeQuantityUnits, totalSupply);

            const initialPositionInfo = (await perpLeverageModule.getPositionNotionalInfo(subjectSetToken))[0];

            await subject();

            const finalPositionInfo = (await perpLeverageModule.getPositionNotionalInfo(subjectSetToken))[0];
            const closeRatio = preciseDiv(baseTradeQuantityNotional, initialPositionInfo.baseBalance);
            const reducedOpenNotional = preciseMul(initialPositionInfo.quoteBalance, closeRatio);

            const expectedBaseBalance = initialPositionInfo.baseBalance.add(baseTradeQuantityNotional);
            const expectedQuoteBalance = initialPositionInfo.quoteBalance.add(reducedOpenNotional);

            expect(finalPositionInfo.baseBalance).gt(initialPositionInfo.baseBalance);
            expect(finalPositionInfo.quoteBalance).lt(initialPositionInfo.quoteBalance);

            expect(finalPositionInfo.baseBalance).eq(expectedBaseBalance);
            expect(finalPositionInfo.quoteBalance).eq(expectedQuoteBalance);
          });

          describe("when the position is zeroed out", async () => {
            beforeEach(async () => {
              subjectBaseTradeQuantityUnits = ether(1);
              subjectQuoteBoundQuantityUnits = ether(10.15);
            });

            it("should remove the position from the positions array", async () => {
              const initialPositionInfo = await perpLeverageModule.getPositionNotionalInfo(subjectSetToken);
              await subject();
              const finalPositionInfo = await perpLeverageModule.getPositionNotionalInfo(subjectSetToken);

              expect(initialPositionInfo.length).eq(1);
              expect(finalPositionInfo.length).eq(0);
            });

            it("should ensure no dust amount is left on PerpV2", async () => {
              await subject();

              const baseBalance = await perpSetup.accountBalance.getBase(setToken.address, vETH.address);
              expect(baseBalance).to.be.eq(ZERO);
            });
          });

          describe("when reversing the position", async () => {
            beforeEach(async () => {
              subjectBaseTradeQuantityUnits = ether(2);
              subjectQuoteBoundQuantityUnits = ether(20.45);
            });

            it("long trade should reverse the short position to a long position", async () => {
              const totalSupply = await setToken.totalSupply();
              const baseTradeQuantityNotional = preciseMul(subjectBaseTradeQuantityUnits, totalSupply);

              const { deltaQuote } = await perpSetup.getSwapQuote(
                subjectBaseToken,
                baseTradeQuantityNotional.abs(),
                true    // long
              );
              const quote = deltaQuote.mul(-1);

              const initialPositionInfo = (await perpLeverageModule.getPositionNotionalInfo(subjectSetToken))[0];

              await subject();

              const finalPositionInfo = (await perpLeverageModule.getPositionNotionalInfo(subjectSetToken))[0];
              const closeRatio = preciseDiv(baseTradeQuantityNotional.abs(), initialPositionInfo.baseBalance.abs());
              const closedPositionNotional = preciseDiv(quote, closeRatio);

              const expectedBaseBalance = initialPositionInfo.baseBalance.add(baseTradeQuantityNotional);
              const expectedQuoteBalance = quote.sub(closedPositionNotional);

              expect(finalPositionInfo.baseBalance).gt(ZERO);
              expect(finalPositionInfo.quoteBalance).lt(ZERO);

              expect(finalPositionInfo.baseBalance).eq(expectedBaseBalance);
              expect(finalPositionInfo.quoteBalance).eq(expectedQuoteBalance);
            });
          });
        });

        describe("when a protocol fee is charged", async () => {
          let feePercentage: BigNumber;

          cacheBeforeEach(async () => {
            feePercentage = ether(0.05);
            setup.controller = setup.controller.connect(owner.wallet);

            await setup.controller.addFee(
              perpLeverageModule.address,
              ZERO,         // Fee type on trade function denoted as 0
              feePercentage
            );

            // Long ~10 USDC of vETH
            subjectBaseTradeQuantityUnits = ether(1);
            subjectQuoteBoundQuantityUnits = ether(10.15);
          });

          it("should withdraw the expected collateral amount from the Perp vault", async () => {
            const {
              collateralBalance: initialCollateralBalance
            } = await perpLeverageModule.getAccountInfo(subjectSetToken);

            await subject();

            const {
              collateralBalance: finalCollateralBalance
            } = await perpLeverageModule.getAccountInfo(subjectSetToken);

            // Levering up from 0, the absolute value of position quote balance is size of our trade
            const { quoteBalance } = (await perpLeverageModule.getPositionNotionalInfo(subjectSetToken))[0];
            const feeAmountInQuoteDecimals = preciseMul(quoteBalance.abs(), feePercentage);

            const expectedCollateralBalance = toUSDCDecimals(initialCollateralBalance).sub(toUSDCDecimals(feeAmountInQuoteDecimals));
            expect(toUSDCDecimals(finalCollateralBalance)).to.eq(expectedCollateralBalance);
          });

          it("should transfer the correct protocol fee to the protocol", async () => {
            const feeRecipient = await setup.controller.feeRecipient();
            const initialFeeRecipientBalance = await usdc.balanceOf(feeRecipient);

            await subject();

            const { quoteBalance } = (await perpLeverageModule.getPositionNotionalInfo(subjectSetToken))[0];
            const feeAmountInQuoteDecimals = preciseMul(quoteBalance.mul(-1), feePercentage);
            const feeAmountInUSDCDecimals = toUSDCDecimals(feeAmountInQuoteDecimals);
            const expectedFeeRecipientBalance = initialFeeRecipientBalance.add(feeAmountInUSDCDecimals);

            const finalFeeRecipientBalance = await usdc.balanceOf(feeRecipient);
            expect(finalFeeRecipientBalance).to.eq(expectedFeeRecipientBalance);
          });

          it("should not change the value of the SetToken USDC defaultPositionUnit", async () => {
            const initialUSDCDefaultPositionUnit = await setToken.getDefaultPositionRealUnit(usdc.address);
            await subject();
            const finalUSDCDefaultPositionUnit = await setToken.getDefaultPositionRealUnit(usdc.address);

            expect(initialUSDCDefaultPositionUnit).to.eq(finalUSDCDefaultPositionUnit);
          });

          it("should not update the USDC externalPositionUnit", async () => {
            const initialExternalPositionUnit = await setToken.getExternalPositionRealUnit(usdc.address, perpLeverageModule.address);
            await subject();
            const finalExternalPositionUnit = await setToken.getExternalPositionRealUnit(usdc.address, perpLeverageModule.address);

            expect(initialExternalPositionUnit).eq(finalExternalPositionUnit);
          });

          it("should emit the correct PerpTraded event", async () => {
            const {
              deltaBase: expectedDeltaBase,
              deltaQuote: expectedDeltaQuote
            } = await perpSetup.getSwapQuote(subjectBaseToken, subjectBaseTradeQuantityUnits, true);

            const expectedProtocolFee = toUSDCDecimals(preciseMul(expectedDeltaQuote, feePercentage));
            const expectedIsBuy = true;

            await expect(subject()).to.emit(perpLeverageModule, "PerpTraded").withArgs(
              subjectSetToken,
              subjectBaseToken,
              expectedDeltaBase,
              expectedDeltaQuote,
              expectedProtocolFee,
              expectedIsBuy
            );
          });
        });

        describe("when amount of token to trade is 0", async () => {
          beforeEach(async () => {
            subjectBaseTradeQuantityUnits = ZERO;
          });

          it("should revert", async () => {
            await expect(subject()).to.be.revertedWith("Amount is 0");
          });
        });

        describe("when baseToken does not exist in Perp system", async () => {
          beforeEach(async () => {
            subjectBaseTradeQuantityUnits = ether(1);
            subjectQuoteBoundQuantityUnits = ether(10.15);
            subjectBaseToken = await getRandomAddress();
          });

          it("should revert", async () => {
            await expect(subject()).to.be.revertedWith("Base token does not exist");
          });
        });
      });

      describe("when going short", () => {
        beforeEach(async () => {
          // Short ~10 USDC of vETH
          subjectBaseTradeQuantityUnits = ether(-1);
          subjectQuoteBoundQuantityUnits = ether(9.85);
        });

        it("should open the expected position", async () => {
          const totalSupply = await setToken.totalSupply();
          const expectedBaseBalance = preciseMul(subjectBaseTradeQuantityUnits, totalSupply);

          const expectedQuoteBalance = (await perpSetup.getSwapQuote(
            subjectBaseToken,
            subjectBaseTradeQuantityUnits.mul(-1),
            false
          )).deltaQuote;

          const initialPositionInfo = await perpLeverageModule.getPositionNotionalInfo(subjectSetToken);
          await subject();
          const finalPositionInfo = (await perpLeverageModule.getPositionNotionalInfo(subjectSetToken))[0];

          expect(initialPositionInfo.length).to.eq(0);
          expect(finalPositionInfo.baseBalance).lt(0);
          expect(finalPositionInfo.quoteBalance).gt(0);
          expect(finalPositionInfo.baseBalance).eq(expectedBaseBalance);
          expect(finalPositionInfo.quoteBalance).eq(expectedQuoteBalance);
          expect(finalPositionInfo.quoteBalance).gt(subjectQuoteBoundQuantityUnits);
        });

        it("should emit the correct PerpTraded event", async () => {
          const {
            deltaBase: expectedDeltaBase,
            deltaQuote: expectedDeltaQuote
          } = await perpSetup.getSwapQuote(subjectBaseToken, subjectBaseTradeQuantityUnits.mul(-1), false);

          const expectedProtocolFee = ether(0);
          const expectedIsBuy = false;

          await expect(subject()).to.emit(perpLeverageModule, "PerpTraded").withArgs(
            subjectSetToken,
            subjectBaseToken,
            expectedDeltaBase,
            expectedDeltaQuote,
            expectedProtocolFee,
            expectedIsBuy
          );
        });

        describe("when an existing position is long", async () => {
          beforeEach(async () => {
            await perpLeverageModule.connect(subjectCaller.wallet).trade(
              subjectSetToken,
              subjectBaseToken,
              ether(1),
              ether(10.15)
            );

            // Partial close
            subjectBaseTradeQuantityUnits = ether(-.5);
            subjectQuoteBoundQuantityUnits = ether(4.85);
          });

          it("short trade should reduce the position", async () => {
            const totalSupply = await setToken.totalSupply();
            const baseTradeQuantityNotional = preciseMul(subjectBaseTradeQuantityUnits, totalSupply);

            const initialPositionInfo = (await perpLeverageModule.getPositionNotionalInfo(subjectSetToken))[0];

            await subject();

            const finalPositionInfo = (await perpLeverageModule.getPositionNotionalInfo(subjectSetToken))[0];
            const closeRatio = preciseDiv(baseTradeQuantityNotional, initialPositionInfo.baseBalance);
            const reducedOpenNotional = preciseMul(initialPositionInfo.quoteBalance, closeRatio);

            const expectedBaseBalance = initialPositionInfo.baseBalance.sub(baseTradeQuantityNotional.abs());
            const expectedQuoteBalance = initialPositionInfo.quoteBalance.add(reducedOpenNotional);

            expect(finalPositionInfo.baseBalance).lt(initialPositionInfo.baseBalance);
            expect(finalPositionInfo.quoteBalance).gt(initialPositionInfo.quoteBalance);

            expect(finalPositionInfo.baseBalance).eq(expectedBaseBalance);
            expect(finalPositionInfo.quoteBalance).eq(expectedQuoteBalance);
          });

          describe("when the position is zeroed out", async () => {
            beforeEach(async () => {
              subjectBaseTradeQuantityUnits = ether(-1);
              subjectQuoteBoundQuantityUnits = ether(9.85);
            });

            it("should remove the position from the positions array", async () => {
              const initialPositionInfo = await perpLeverageModule.getPositionNotionalInfo(subjectSetToken);
              await subject();
              const finalPositionInfo = await perpLeverageModule.getPositionNotionalInfo(subjectSetToken);

              expect(initialPositionInfo.length).eq(1);
              expect(finalPositionInfo.length).eq(0);
            });

            it("should ensure no dust amount is left on PerpV2", async () => {
              await subject();

              const baseBalance = await perpSetup.accountBalance.getBase(setToken.address, vETH.address);
              expect(baseBalance).to.be.eq(ZERO);
            });
          });

          describe("when the position reversed", async () => {
            beforeEach(async () => {
              subjectBaseTradeQuantityUnits = ether(-2);
              subjectQuoteBoundQuantityUnits = ether(19.45);
            });

            it("short trade should reverse the long position to a short position", async () => {
              const totalSupply = await setToken.totalSupply();
              const baseTradeQuantityNotional = preciseMul(subjectBaseTradeQuantityUnits, totalSupply);

              const { deltaQuote } = await perpSetup.getSwapQuote(
                subjectBaseToken,
                baseTradeQuantityNotional.abs(),
                false   // short
              );

              const initialPositionInfo = (await perpLeverageModule.getPositionNotionalInfo(subjectSetToken))[0];

              await subject();

              const finalPositionInfo = (await perpLeverageModule.getPositionNotionalInfo(subjectSetToken))[0];
              const closeRatio = preciseDiv(baseTradeQuantityNotional.abs(), initialPositionInfo.baseBalance.abs());
              const closedPositionNotional = preciseDiv(deltaQuote, closeRatio);

              const expectedBaseBalance = initialPositionInfo.baseBalance.sub(baseTradeQuantityNotional.abs());
              const expectedQuoteBalance = deltaQuote.sub(closedPositionNotional);

              expect(finalPositionInfo.baseBalance).lt(ZERO);
              expect(finalPositionInfo.quoteBalance).gt(ZERO);

              expect(finalPositionInfo.baseBalance).eq(expectedBaseBalance);
              expect(finalPositionInfo.quoteBalance).eq(expectedQuoteBalance);
            });
          });
        });

        describe("when an existing position is short", async () => {
          beforeEach(async () => {
            await perpLeverageModule.connect(subjectCaller.wallet).trade(
              subjectSetToken,
              subjectBaseToken,
              ether(-1),
              ether(9.85)
            );
          });

          it("short trade should increase the position size", async () => {
            const totalSupply = await setToken.totalSupply();
            const initialPositionInfo = await perpLeverageModule.getPositionNotionalInfo(subjectSetToken);
            const expectedDeltaBase = preciseMul(subjectBaseTradeQuantityUnits, totalSupply);
            const expectedBaseBalance = initialPositionInfo[0].baseBalance.add(expectedDeltaBase);

            await subject();

            const finalPositionInfo = (await perpLeverageModule.getPositionNotionalInfo(subjectSetToken))[0];

            expect(initialPositionInfo.length).to.eq(1);
            expect(initialPositionInfo[0].baseBalance).gt(finalPositionInfo.baseBalance);
            expect(finalPositionInfo.baseBalance).eq(expectedBaseBalance);
          });
        });

        describe("when a protocol fee is charged", async () => {
          let feePercentage: BigNumber;

          cacheBeforeEach(async () => {
            feePercentage = ether(0.05);
            setup.controller = setup.controller.connect(owner.wallet);

            await setup.controller.addFee(
              perpLeverageModule.address,
              ZERO,         // Fee type on trade function denoted as 0
              feePercentage
            );

            // Short ~10 USDC of vETH
            subjectBaseTradeQuantityUnits = ether(-1);
            subjectQuoteBoundQuantityUnits = ether(9.85);
          });

          it("should withdraw the expected collateral amount from the Perp vault", async () => {
            const {
              collateralBalance: initialCollateralBalance
            } = await perpLeverageModule.getAccountInfo(subjectSetToken);

            await subject();

            const {
              collateralBalance: finalCollateralBalance
            } = await perpLeverageModule.getAccountInfo(subjectSetToken);

            // Levering up from 0, the position quote balance is size of our trade
            const { quoteBalance } = (await perpLeverageModule.getPositionNotionalInfo(subjectSetToken))[0];
            const feeAmountInQuoteDecimals = preciseMul(quoteBalance, feePercentage);

            const expectedCollateralBalance = toUSDCDecimals(initialCollateralBalance).sub(toUSDCDecimals(feeAmountInQuoteDecimals));
            expect(toUSDCDecimals(finalCollateralBalance)).to.eq(expectedCollateralBalance);
          });
        });

        describe("when slippage is greater than allowed", async () => {
          beforeEach(async () => {
            // Short ~10 USDC of vETH, slippage incurred as smaller positive quote delta
            subjectBaseTradeQuantityUnits = ether(-1);
            subjectQuoteBoundQuantityUnits = ether(10);
          });

          it("should revert", async () => {
            // ClearingHouse: too little quote received when short
            await expect(subject()).to.be.revertedWith("CH_TLRS");
          });
        });
      });
    });

    describe("when exceeds the max number of postions", async () => {
      beforeEach(async () => {
        // Open a WBTC position to max out the number of positions that can be opened per Set
        await perpLeverageModule.connect(owner.wallet).updateMaxPerpPositionsPerSet(ONE);

        await perpLeverageModule.trade(
          subjectSetToken,
          vBTC.address,
          ether(0.1),
          ether(2.1)    // 2.1 > 2 (20 * 0.1)
        );

        // Long ~10 USDC of vETH
        subjectBaseTradeQuantityUnits = ether(1);
        subjectQuoteBoundQuantityUnits = ether(10.15);
      });

      after(async () => {
        await perpLeverageModule.connect(owner.wallet).updateMaxPerpPositionsPerSet(TWO);
      });

      it("should revert with exceeds max perpetual positions per set", async () => {
        await expect(subject()).to.be.revertedWith("Exceeds max perpetual positions per set");
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

    describe("when SetToken is not valid", async () => {
      beforeEach(async () => {
        const nonEnabledSetToken = await setup.createNonControllerEnabledSetToken(
          [perpSetup.usdc.address],
          [usdcUnits(100)],
          [perpLeverageModule.address],
          owner.address
        );

        subjectSetToken = nonEnabledSetToken.address;
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Must be a valid and initialized SetToken");
      });
    });

    describe("when module is not initialized", async () => {
      beforeEach(async () => {
        isInitialized = false;
        await initializeContracts();
        await initializeSubjectVariables();
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Must be a valid and initialized SetToken");
      });
    });
  });

  describe("#deposit", () => {
    let subjectSetToken: SetToken;
    let subjectDepositAmount: number;
    let subjectDepositQuantity: BigNumber;
    let subjectCaller: Account;
    let isInitialized: boolean;

    const initializeContracts = async () => {
      subjectSetToken = await setup.createSetToken(
        [usdc.address],
        [usdcUnits(100)],
        [perpLeverageModule.address, debtIssuanceMock.address, setup.issuanceModule.address]
      );

      await debtIssuanceMock.initialize(subjectSetToken.address);
      await perpLeverageModule.updateAllowedSetToken(subjectSetToken.address, true);

      if (isInitialized) {
        await perpLeverageModule.initialize(subjectSetToken.address);

        const issueQuantity = ether(2);
        await usdc.approve(setup.issuanceModule.address, usdcUnits(1000));
        await setup.issuanceModule.initialize(subjectSetToken.address, ADDRESS_ZERO);
        await setup.issuanceModule.issue(subjectSetToken.address, issueQuantity, owner.address);
      }
    };

    const initializeSubjectVariables = () => {
      subjectCaller = owner;
      subjectDepositAmount = 1;
      subjectDepositQuantity = usdcUnits(subjectDepositAmount);
    };

    async function subject(): Promise<any> {
      return await perpLeverageModule
        .connect(subjectCaller.wallet)
        .deposit(subjectSetToken.address, subjectDepositQuantity);
    }

    describe("when module is initialized", () => {
      beforeEach(async () => {
        isInitialized = true;
      });

      cacheBeforeEach(initializeContracts);
      beforeEach(initializeSubjectVariables);

      it("should create a deposit", async () => {
        const {
          collateralBalance: initialCollateralBalance
        } = await perpLeverageModule.getAccountInfo(subjectSetToken.address);

        await subject();

        const {
          collateralBalance: finalCollateralBalance
        } = await perpLeverageModule.getAccountInfo(subjectSetToken.address);

        const totalSupply = await subjectSetToken.totalSupply();
        const expectedCollateralBalance = toUSDCDecimals(initialCollateralBalance)
          .add(preciseMul(subjectDepositQuantity, totalSupply));
        expect(toUSDCDecimals(finalCollateralBalance)).to.eq(expectedCollateralBalance);
      });

      it("should add Perp as an external position module", async () => {
        const initialExternalModules = await subjectSetToken.getExternalPositionModules(usdc.address);

        await subject();

        const finalExternalPositionModules = await subjectSetToken.getExternalPositionModules(usdc.address);

        const expectedExternalPositionModule = perpLeverageModule.address;

        expect(initialExternalModules.length).eq(0);
        expect(finalExternalPositionModules.length).eq(1);
        expect(finalExternalPositionModules[0]).eq(expectedExternalPositionModule);

      });

      it("should update the USDC defaultPositionUnit", async () => {
        const initialDefaultPosition = await subjectSetToken.getDefaultPositionRealUnit(usdc.address);
        await subject();
        const finalDefaultPosition = await subjectSetToken.getDefaultPositionRealUnit(usdc.address);;

        const expectedDefaultPosition = initialDefaultPosition.sub(usdcUnits(subjectDepositAmount));
        expect(finalDefaultPosition).to.eq(expectedDefaultPosition);
      });

      it("should update the USDC externalPositionUnit", async () => {
        const initialExternalPositionUnit = await subjectSetToken.getExternalPositionRealUnit(usdc.address, perpLeverageModule.address);
        await subject();
        const finalExternalPositionUnit = await subjectSetToken.getExternalPositionRealUnit(usdc.address, perpLeverageModule.address);

        const expectedDefaultPosition = initialExternalPositionUnit.add(subjectDepositQuantity);
        expect(finalExternalPositionUnit).to.eq(expectedDefaultPosition);
      });

      it("should emit the correct CollateralDeposited event", async () => {
        const totalSupply = await subjectSetToken.totalSupply();

        await expect(subject()).to.emit(perpLeverageModule, "CollateralDeposited").withArgs(
          subjectSetToken.address,
          perpSetup.usdc.address,
          preciseMul(subjectDepositQuantity, totalSupply)
        );
      });

      describe("when depositing and a position exists", () => {
        let baseToken: Address;

        describe("when the position is long", async () => {
          beforeEach(async () => {
            await subject();    // should avoid calling subject here
            baseToken = vETH.address;
            await leverUp(
              subjectSetToken,
              perpLeverageModule,
              perpSetup,
              owner,
              baseToken,
              2,
              ether(.02),
              true
            );
          });

          it("should create a deposit", async () => {
            const {
              collateralBalance: initialCollateralBalance
            } = await perpLeverageModule.getAccountInfo(subjectSetToken.address);

            await subject();

            const {
              collateralBalance: finalCollateralBalance
            } = await perpLeverageModule.getAccountInfo(subjectSetToken.address);

            const totalSupply = await subjectSetToken.totalSupply();
            const expectedCollateralBalance = toUSDCDecimals(initialCollateralBalance)
              .add(preciseMul(subjectDepositQuantity, totalSupply));
            expect(toUSDCDecimals(finalCollateralBalance)).to.eq(expectedCollateralBalance);
          });


          it("should set the expected position unit", async () => {
            await subject();
            const externalPositionUnit = await subjectSetToken.getExternalPositionRealUnit(usdc.address, perpLeverageModule.address);
            const expectedExternalPositionUnit = await calculateExternalPositionUnit(
              subjectSetToken,
              perpLeverageModule,
              perpSetup
            );

            // Deposit notional amount = specified position unit * totalSupply = 1 * 2 = $2
            // We've put on a position that hasn't had any real pnl, so we expect set ~= $2 net fees & slippage
            // externalPositionUnit = 1_979_877
            expect(externalPositionUnit).eq(expectedExternalPositionUnit);
          });

          it("should decrease the leverage ratio", async () => {
            const positionInfo = (await perpLeverageModule.getPositionNotionalInfo(subjectSetToken.address))[0];
            const totalSupply = await subjectSetToken.totalSupply();

            const {
              collateralBalance: initialCollateralBalance
            } = await perpLeverageModule.getAccountInfo(subjectSetToken.address);

            const initialLeverageRatio = await perpSetup.getCurrentLeverage(
              subjectSetToken.address,
              positionInfo,
              initialCollateralBalance
            );

            await subject();

            const {
              collateralBalance: finalCollateralBalance
            } = await perpLeverageModule.getAccountInfo(subjectSetToken.address);

            const finalLeverageRatio = await perpSetup.getCurrentLeverage(
              subjectSetToken.address,
              positionInfo,
              finalCollateralBalance
            );

            const expectedCollateralBalance = toUSDCDecimals(initialCollateralBalance)
              .add(preciseMul(subjectDepositQuantity, totalSupply));

            // initialLeverageRatio  = 2_040_484_848_517_694_106
            // finalLeverageRatio    = 1_009_978_994_844_697_153
            expect(toUSDCDecimals(finalCollateralBalance)).to.eq(expectedCollateralBalance);
            expect(finalLeverageRatio).lt(initialLeverageRatio);
          });
        });

        describe("when the position is short", async () => {
          beforeEach(async () => {
            await subject();
            baseToken = vETH.address;
            await leverUp(
              subjectSetToken,
              perpLeverageModule,
              perpSetup,
              owner,
              baseToken,
              2,
              ether(.02),
              false
            );
          });

          it("should create a deposit", async () => {
            const {
              collateralBalance: initialCollateralBalance
            } = await perpLeverageModule.getAccountInfo(subjectSetToken.address);

            await subject();

            const {
              collateralBalance: finalCollateralBalance
            } = await perpLeverageModule.getAccountInfo(subjectSetToken.address);

            const totalSupply = await subjectSetToken.totalSupply();
            const expectedCollateralBalance = toUSDCDecimals(initialCollateralBalance)
              .add(preciseMul(subjectDepositQuantity, totalSupply));
            expect(toUSDCDecimals(finalCollateralBalance)).to.eq(expectedCollateralBalance);
          });

          it("should set the expected position unit", async () => {
            await subject();
            const externalPositionUnit = await subjectSetToken.getExternalPositionRealUnit(usdc.address, perpLeverageModule.address);
            const expectedExternalPositionUnit = await calculateExternalPositionUnit(
              subjectSetToken,
              perpLeverageModule,
              perpSetup
            );

            // Deposit amount = $1 * 2 (two deposits)
            // We've put on a position that hasn't had any real pnl, so we expect set ~= $2 net fees & slippage
            // externalPositionUnit = 1_980_080
            expect(externalPositionUnit).eq(expectedExternalPositionUnit);
          });

          it("should decrease the leverage ratio", async () => {
            const positionInfo = (await perpLeverageModule.getPositionNotionalInfo(subjectSetToken.address))[0];
            const totalSupply = await subjectSetToken.totalSupply();

            const {
              collateralBalance: initialCollateralBalance
            } = await perpLeverageModule.getAccountInfo(subjectSetToken.address);

            const initialLeverageRatio = await perpSetup.getCurrentLeverage(
              subjectSetToken.address,
              positionInfo,
              initialCollateralBalance
            );

            await subject();

            const {
              collateralBalance: finalCollateralBalance
            } = await perpLeverageModule.getAccountInfo(subjectSetToken.address);

            const finalLeverageRatio = await perpSetup.getCurrentLeverage(
              subjectSetToken.address,
              positionInfo,
              finalCollateralBalance
            );

            const expectedCollateralBalance = toUSDCDecimals(initialCollateralBalance)
              .add(preciseMul(subjectDepositQuantity, totalSupply));

            // initialLeverageRatio = 2_041_235_426_575_610_129
            // finalLeverageRation  = 1_010_244_489_779_359_264
            expect(toUSDCDecimals(finalCollateralBalance)).to.eq(expectedCollateralBalance);
            expect(finalLeverageRatio).lt(initialLeverageRatio);
          });
        });

        describe("when the position is mixed long and short", async () => {
          beforeEach(async () => {
            await subject();
            baseToken = vETH.address;
            await leverUp(
              subjectSetToken,
              perpLeverageModule,
              perpSetup,
              owner,
              vETH.address,
              2,
              ether(.02),
              true // long
            );

            await leverUp(
              subjectSetToken,
              perpLeverageModule,
              perpSetup,
              owner,
              vBTC.address,
              2,
              ether(.02),
              false // short
            );
          });

          it("should create a deposit", async () => {
            const {
              collateralBalance: initialCollateralBalance
            } = await perpLeverageModule.getAccountInfo(subjectSetToken.address);

            await subject();

            const {
              collateralBalance: finalCollateralBalance
            } = await perpLeverageModule.getAccountInfo(subjectSetToken.address);

            const totalSupply = await subjectSetToken.totalSupply();
            const expectedCollateralBalance = toUSDCDecimals(initialCollateralBalance)
              .add(preciseMul(subjectDepositQuantity, totalSupply));
            expect(toUSDCDecimals(finalCollateralBalance)).to.eq(expectedCollateralBalance);
          });

          it("should set the expected position unit", async () => {
            await subject();
            const externalPositionUnit = await subjectSetToken.getExternalPositionRealUnit(usdc.address, perpLeverageModule.address);
            const expectedExternalPositionUnit = await calculateExternalPositionUnit(
              subjectSetToken,
              perpLeverageModule,
              perpSetup
            );

            // Deposit amount = $1 * 2 (two deposits)
            // We've put on a position that hasn't had any real pnl, so we expect set ~= $2 net fees & slippage
            // EPU is slightly lower here than previous cases since we've traded twice
            //
            // externalPositionUnit = 1_959_917
            expect(externalPositionUnit).eq(expectedExternalPositionUnit);
          });
        });
      });

      describe("when deposit amount is 0", async () => {
        beforeEach(() => {
          subjectDepositQuantity = usdcUnits(0);
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("Deposit amount is 0");
        });
      });

      describe("when not called by manager", async () => {
        beforeEach(async () => {
          subjectCaller = await getRandomAccount();
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("Must be the SetToken manager");
        });
      });
    });

    describe("when module is not initialized", async () => {
      beforeEach(async () => {
        isInitialized = false;
        await initializeContracts();
        initializeSubjectVariables();
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Must be a valid and initialized SetToken");
      });
    });
  });

  describe("#withdraw", () => {
    let depositQuantity: BigNumber;
    let subjectSetToken: SetToken;
    let subjectWithdrawQuantity: BigNumber;
    let subjectCaller: Account;
    let isInitialized: boolean;

    const initializeContracts = async () => {
      subjectSetToken = await setup.createSetToken(
        [usdc.address],
        [usdcUnits(100)],
        [perpLeverageModule.address, debtIssuanceMock.address, setup.issuanceModule.address]
      );

      await debtIssuanceMock.initialize(subjectSetToken.address);
      await perpLeverageModule.updateAllowedSetToken(subjectSetToken.address, true);

      if (isInitialized) {
        await perpLeverageModule.initialize(subjectSetToken.address);

        const issueQuantity = ether(2);
        await usdc.approve(setup.issuanceModule.address, usdcUnits(1000));
        await setup.issuanceModule.initialize(subjectSetToken.address, ADDRESS_ZERO);
        await setup.issuanceModule.issue(subjectSetToken.address, issueQuantity, owner.address);

        // Deposit 10 USDC
        depositQuantity = usdcUnits(10);
        await perpLeverageModule
          .connect(owner.wallet)
          .deposit(subjectSetToken.address, depositQuantity);
      }
    };

    const initializeSubjectVariables = () => {
      subjectCaller = owner;
      subjectWithdrawQuantity = usdcUnits(5);
    };

    async function subject(): Promise<any> {
      return await perpLeverageModule
        .connect(subjectCaller.wallet)
        .withdraw(subjectSetToken.address, subjectWithdrawQuantity);
    }

    describe("when module is initialized", () => {
      beforeEach(async () => {
        isInitialized = true;
      });

      cacheBeforeEach(initializeContracts);
      beforeEach(() => initializeSubjectVariables());

      it("should withdraw an amount", async () => {
        const initialCollateralBalance = (await perpLeverageModule.getAccountInfo(subjectSetToken.address)).collateralBalance;

        await subject();

        const finalCollateralBalance = (await perpLeverageModule.getAccountInfo(subjectSetToken.address)).collateralBalance;

        const totalSupply = await subjectSetToken.totalSupply();
        const expectedCollateralBalance = toUSDCDecimals(initialCollateralBalance)
          .sub(preciseMul(subjectWithdrawQuantity, totalSupply));
        expect(toUSDCDecimals(finalCollateralBalance)).to.eq(expectedCollateralBalance);
      });

      it("should update the USDC defaultPositionUnit", async () => {
        const initialDefaultPosition = await subjectSetToken.getDefaultPositionRealUnit(usdc.address);
        await subject();
        const finalDefaultPosition = await subjectSetToken.getDefaultPositionRealUnit(usdc.address);;

        const expectedDefaultPosition = initialDefaultPosition.add(subjectWithdrawQuantity);
        expect(finalDefaultPosition).to.eq(expectedDefaultPosition);
      });

      it("should update the USDC externalPositionUnit", async () => {
        const initialExternalPositionUnit = await subjectSetToken.getExternalPositionRealUnit(usdc.address, perpLeverageModule.address);
        await subject();
        const finalExternalPositionUnit = await subjectSetToken.getExternalPositionRealUnit(usdc.address, perpLeverageModule.address);

        const expectedExternalPositionUnit = initialExternalPositionUnit.sub(subjectWithdrawQuantity);
        expect(finalExternalPositionUnit).to.eq(expectedExternalPositionUnit);
      });

      it("should emit the correct CollateralWithdrawn event", async () => {
        const totalSupply = await subjectSetToken.totalSupply();

        await expect(subject()).to.emit(perpLeverageModule, "CollateralWithdrawn").withArgs(
          subjectSetToken.address,
          perpSetup.usdc.address,
          preciseMul(subjectWithdrawQuantity, totalSupply)
        );
      });

      describe("when withdraw amount is 0", async () => {
        beforeEach(() => {
          subjectWithdrawQuantity = usdcUnits(0);
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("Withdraw amount is 0");
        });
      });

      describe("when the entire amount is withdrawn", async () => {
        beforeEach(() => {
          subjectWithdrawQuantity = depositQuantity;
        });

        it("should remove Perp as an external position module", async () => {
          const initialExternalModules = await subjectSetToken.getExternalPositionModules(usdc.address);
          await subject();
          const finalExternalPositionModules = await subjectSetToken.getExternalPositionModules(usdc.address);

          expect(initialExternalModules.length).eq(1);
          expect(finalExternalPositionModules.length).eq(0);
        });
      });

      describe("when withdrawing and a position exists", () => {
        let baseToken: Address;

        beforeEach(async () => {
          baseToken = vETH.address;
          await leverUp(
            subjectSetToken,
            perpLeverageModule,
            perpSetup,
            owner,
            baseToken,
            2,
            ether(.02),
            true
          );

          subjectWithdrawQuantity = usdcUnits(2.5);
        });

        it("should decrease the collateral balance", async () => {
          const initialCollateralBalance = (await perpLeverageModule.getAccountInfo(subjectSetToken.address)).collateralBalance;

          await subject();

          const finalCollateralBalance = (await perpLeverageModule.getAccountInfo(subjectSetToken.address)).collateralBalance;

          const totalSupply = await subjectSetToken.totalSupply();
          const expectedCollateralBalance = toUSDCDecimals(initialCollateralBalance)
            .sub(preciseMul(subjectWithdrawQuantity, totalSupply));

          expect(toUSDCDecimals(finalCollateralBalance)).to.eq(expectedCollateralBalance);
        });

        it("should increase the leverage ratio", async () => {
          const positionInfo = (await perpLeverageModule.getPositionNotionalInfo(subjectSetToken.address))[0];
          const totalSupply = await subjectSetToken.totalSupply();

          const {
            collateralBalance: initialCollateralBalance
          } = await perpLeverageModule.getAccountInfo(subjectSetToken.address);

          const initialLeverageRatio = await perpSetup.getCurrentLeverage(
            subjectSetToken.address,
            positionInfo,
            initialCollateralBalance
          );

          await subject();

          const {
            collateralBalance: finalCollateralBalance
          } = await perpLeverageModule.getAccountInfo(subjectSetToken.address);

          const finalLeverageRatio = await perpSetup.getCurrentLeverage(
            subjectSetToken.address,
            positionInfo,
            finalCollateralBalance
          );

          const expectedCollateralBalance = toUSDCDecimals(initialCollateralBalance)
            .sub(preciseMul(subjectWithdrawQuantity, totalSupply));

          // initialLeverageRatio = 2_041_219_945_269_276_819
          // finalLeverageRatio   = 2_739_702_831_474_076_071
          expect(toUSDCDecimals(finalCollateralBalance)).to.eq(expectedCollateralBalance);
          expect(finalLeverageRatio).gt(initialLeverageRatio);
        });
      });

      describe("when not called by manager", async () => {
        beforeEach(async () => {
          subjectCaller = await getRandomAccount();
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("Must be the SetToken manager");
        });
      });
    });

    describe("when module is not initialized", async () => {
      beforeEach(async () => {
        isInitialized = false;
        await initializeContracts();
        initializeSubjectVariables();
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Must be a valid and initialized SetToken");
      });
    });
  });

  describe("#moduleIssueHook", () => {
    let setToken: SetToken;
    let collateralQuantity: BigNumber;
    let subjectSetToken: Address;
    let subjectCaller: Account;
    let subjectSetQuantity: BigNumber;

    // Start with initial total supply (2)
    const initializeContracts = async () => {
      collateralQuantity = usdcUnits(10);
      setToken = await issueSetsAndDepositToPerp(collateralQuantity, true, ether(2));
    };

    const initializeSubjectVariables = () => {
      subjectSetToken = setToken.address;
      subjectCaller = mockModule;
      subjectSetQuantity = ether(1);
    };

    cacheBeforeEach(initializeContracts);
    beforeEach(initializeSubjectVariables);

    async function subject(): Promise<any> {
      return await perpLeverageModule
        .connect(subjectCaller.wallet)
        .moduleIssueHook(subjectSetToken, subjectSetQuantity);
    }

    describe("when long, single position", () => {
      let baseToken: Address;

      // Set up as 2X Long, allow 2% slippage
      cacheBeforeEach(async () => {
        baseToken = vETH.address;
        await leverUp(
          setToken,
          perpLeverageModule,
          perpSetup,
          owner,
          baseToken,
          2,
          ether(.02),
          true
        );
      });

      describe("when issuing a single set", async () => {
        let usdcTransferInQuantity: BigNumber;

        beforeEach(async () => {
          usdcTransferInQuantity = await calculateUSDCTransferIn(
            setToken,
            subjectSetQuantity,
            perpLeverageModule,
            perpSetup
          );
        });

        it("buys expected amount of vBase", async () => {
          const totalSupply = await setToken.totalSupply();

          const initialBaseBalance = (await perpLeverageModule.getPositionNotionalInfo(subjectSetToken))[0].baseBalance;

          await subject();

          const finalBaseBalance = (await perpLeverageModule.getPositionNotionalInfo(subjectSetToken))[0].baseBalance;

          const basePositionUnit = preciseDiv(initialBaseBalance, totalSupply);
          const baseTokenBoughtNotional = preciseMul(basePositionUnit, subjectSetQuantity);
          const expectedBaseBalance = initialBaseBalance.add(baseTokenBoughtNotional);

          expect(finalBaseBalance).eq(expectedBaseBalance);
        });

        // There are 2 ways to handle funding accrued between when we fetch the usdc amount to be
        // transferred in and when we determine usdc amount to be transferred in on chain.
        // 1. Force funding to zero by syncing the oracle price to spot price
        // 2. Calculate accrued funding and add it to our usdc amount to be transferred in
        describe("sync oracle in before each", async () => {
          beforeEach(async () => {
            await syncOracleToSpot(vETH);
          });

          it("should set the expected USDC externalPositionUnit", async () => {
            const expectedExternalPositionUnit = preciseDiv(usdcTransferInQuantity, subjectSetQuantity);

            await subject();

            const externalPositionUnit = await setToken.getExternalPositionRealUnit(
              usdc.address,
              perpLeverageModule.address
            );

            expect(externalPositionUnit).to.eq(expectedExternalPositionUnit);
          });
        });

        describe("do not sync oracle in before each", async () => {
          beforeEach(async () => {
            usdcTransferInQuantity = await calculateUSDCTransferInPreciseUnits(
              setToken,
              subjectSetQuantity,
              perpLeverageModule,
              perpSetup,
              false
            );
          });

          it("should set the expected USDC externalPositionUnit", async () => {
            const baseBalance = await perpSetup.accountBalance.getBase(setToken.address, baseToken);

            await subject();

            const usdcAmountDelta = await getUSDCDeltaDueToFundingGrowth(
              setToken,
              subjectSetQuantity,
              baseToken,
              baseBalance,
              perpSetup
            );
            const expectedExternalPositionUnit = toUSDCDecimals(
              preciseDiv(usdcTransferInQuantity.add(usdcAmountDelta), subjectSetQuantity)
            );

            const externalPositionUnit = await setToken.getExternalPositionRealUnit(
              usdc.address,
              perpLeverageModule.address
            );

            expect(externalPositionUnit).to.eq(expectedExternalPositionUnit);
          });
        });
      });

      describe("when there is positive owedRealizedPnl", async () => {
        beforeEach(async () => {
          // Move price up by maker buying 20k USDC of vETH
          // Post trade spot price rises from ~10 USDC to 14_356_833_358_751_766_356
          await perpSetup.clearingHouse.connect(maker.wallet).openPosition({
            baseToken: vETH.address,
            isBaseToQuote: false,     // long
            isExactInput: true,       // `amount` is USDC
            amount: ether(20000),
            oppositeAmountBound: ZERO,
            deadline: MAX_UINT_256,
            sqrtPriceLimitX96: ZERO,
            referralCode: ZERO_BYTES
          });

          // Sell a little, booking profit to owedRealizedPnl
          await perpLeverageModule.connect(owner.wallet).trade(
            subjectSetToken,
            vETH.address,
            ether(-.4),
            ether(4)
          );

          await syncOracleToSpot(vETH);
        });

        it("should set the expected USDC externalPositionUnit", async () => {
          const owedRealizedPnl = (await perpLeverageModule.getAccountInfo(subjectSetToken)).owedRealizedPnl;

          const usdcTransferInQuantity = await calculateUSDCTransferIn(
            setToken,
            subjectSetQuantity,
            perpLeverageModule,
            perpSetup
          );

          const expectedExternalPositionUnit = preciseDiv(
            usdcTransferInQuantity,
            subjectSetQuantity
          );

          await subject();

          const externalPositionUnit = await setToken.getExternalPositionRealUnit(
            usdc.address,
            perpLeverageModule.address
          );

          expect(owedRealizedPnl).gt(0);
          expect(externalPositionUnit).to.eq(expectedExternalPositionUnit);
        });
      });

      describe("when there is negative owedRealizedPnl", async () => {
        beforeEach(async () => {
          // Move price down by maker selling 20k USDC of vETH
          // Post trade spot price rises from ~10 USDC to 6_370_910_537_702_299_856
          await perpSetup.clearingHouse.connect(maker.wallet).openPosition({
            baseToken: vETH.address,
            isBaseToQuote: true,       // short
            isExactInput: false,       // `amount` is USDC
            amount: ether(20000),
            oppositeAmountBound: ZERO,
            deadline: MAX_UINT_256,
            sqrtPriceLimitX96: ZERO,
            referralCode: ZERO_BYTES
          });

          // Sell a little, booking loss to owedRealizedPnl
          await perpLeverageModule.connect(owner.wallet).trade(
            subjectSetToken,
            vETH.address,
            ether(-.4),
            ether(1)
          );

          await syncOracleToSpot(vETH);
        });

        it("should set the expected USDC externalPositionUnit", async () => {
          const owedRealizedPnl = (await perpLeverageModule.getAccountInfo(subjectSetToken)).owedRealizedPnl;

          const usdcTransferInQuantity = await calculateUSDCTransferIn(
            setToken,
            subjectSetQuantity,
            perpLeverageModule,
            perpSetup
          );

          const expectedExternalPositionUnit = preciseDiv(usdcTransferInQuantity, subjectSetQuantity);

          await subject();

          const externalPositionUnit = await setToken.getExternalPositionRealUnit(
            usdc.address,
            perpLeverageModule.address
          );

          expect(owedRealizedPnl).lt(ether(1).mul(-1));
          expect(externalPositionUnit).to.be.eq(expectedExternalPositionUnit);
        });
      });

      describe("when the Set owes funding", async () => {
        beforeEach(async() => {
          // set funding rate to non-zero value
          await perpSetup.clearingHouseConfig.setMaxFundingRate(BigNumber.from(0.1e6));       // 10% in decimal 6
        });

        it("should socialize the funding payment among existing set holders", async () => {
          // Move oracle price down and wait one day
          await perpSetup.setBaseTokenOraclePrice(vETH, usdcUnits(9.5));
          await increaseTimeAsync(ONE_DAY_IN_SECONDS);

          const baseBalance = await perpSetup.accountBalance.getBase(setToken.address, baseToken);
          const pendingFunding = (await perpLeverageModule.getAccountInfo(subjectSetToken)).pendingFundingPayments;
          const usdcTransferInQuantity = await calculateUSDCTransferInPreciseUnits(
            setToken,
            subjectSetQuantity,
            perpLeverageModule,
            perpSetup,
            false       // don't include funding
          );

          await subject();

          const usdcAmountDelta = await getUSDCDeltaDueToFundingGrowth(setToken, subjectSetQuantity, baseToken, baseBalance, perpSetup);
          const expectedExternalPositionUnit = toUSDCDecimals(
            preciseDiv(usdcTransferInQuantity.add(usdcAmountDelta), subjectSetQuantity)
          );

          const externalPositionUnit = await setToken.getExternalPositionRealUnit(
            usdc.address,
            perpLeverageModule.address
          );

          expect(pendingFunding).lt(0);
          expect(externalPositionUnit).to.be.eq(expectedExternalPositionUnit);
        });
      });

      describe("when the Set is owed funding", async () => {
        beforeEach(async() => {
          // set funding rate to non-zero value
          await perpSetup.clearingHouseConfig.setMaxFundingRate(BigNumber.from(0.1e6));       // 10% in decimal 6
        });

        it("should socialize the funding payment among existing set holders", async () => {
          // Move oracle price up and wait one day
          await perpSetup.setBaseTokenOraclePrice(vETH, usdcUnits(15));
          await increaseTimeAsync(ONE_DAY_IN_SECONDS);

          const baseBalance = await perpSetup.accountBalance.getBase(setToken.address, baseToken);
          const pendingFunding = (await perpLeverageModule.getAccountInfo(subjectSetToken)).pendingFundingPayments;
          const usdcTransferInQuantity = await calculateUSDCTransferInPreciseUnits(
            setToken,
            subjectSetQuantity,
            perpLeverageModule,
            perpSetup,
            false       // don't include funding
          );

          await subject();

          const usdcAmountDelta = await getUSDCDeltaDueToFundingGrowth(setToken, subjectSetQuantity, baseToken, baseBalance, perpSetup);
          const expectedExternalPositionUnit = toUSDCDecimals(
            preciseDiv(usdcTransferInQuantity.add(usdcAmountDelta), subjectSetQuantity)
          );

          const externalPositionUnit = await setToken.getExternalPositionRealUnit(
            usdc.address,
            perpLeverageModule.address
          );

          expect(pendingFunding).gt(ZERO);
          expect(externalPositionUnit).to.be.eq(expectedExternalPositionUnit);
        });
      });

      describe("when the market price moves up and leverage drops", async () => {
        it("test assumptions and preconditions should be correct", async () => {
          let positionInfo = (await perpLeverageModule.getPositionNotionalInfo(subjectSetToken))[0];
          let collateralBalance = (await perpLeverageModule.getAccountInfo(subjectSetToken)).collateralBalance;

          const initialLeverage = await perpSetup.getCurrentLeverage(subjectSetToken, positionInfo, collateralBalance);
          const initialSpotPrice = await perpSetup.getSpotPrice(vETH.address);
          const initialUSDCTransferInQuantity = await calculateUSDCTransferIn(
            setToken,
            subjectSetQuantity,
            perpLeverageModule,
            perpSetup
          );

          await perpSetup.clearingHouse.connect(maker.wallet).openPosition({
            baseToken: vETH.address,
            isBaseToQuote: false,     // long
            isExactInput: true,       // `amount` is USDC
            amount: ether(10000),     // move price up by buying 10k USDC of vETH
            oppositeAmountBound: ZERO,
            deadline: MAX_UINT_256,
            sqrtPriceLimitX96: ZERO,
            referralCode: ZERO_BYTES
          });

          positionInfo = (await perpLeverageModule.getPositionNotionalInfo(subjectSetToken))[0];
          collateralBalance = (await perpLeverageModule.getAccountInfo(subjectSetToken)).collateralBalance;

          const finalLeverage = await perpSetup.getCurrentLeverage(subjectSetToken, positionInfo, collateralBalance);
          const finalSpotPrice = await perpSetup.getSpotPrice(vETH.address);
          const finalUSDCTransferInQuantity = await calculateUSDCTransferIn(
            setToken,
            subjectSetQuantity,
            perpLeverageModule,
            perpSetup
          );

          expect(initialSpotPrice).lt(finalSpotPrice);
          expect(initialUSDCTransferInQuantity).lt(finalUSDCTransferInQuantity);
          expect(initialLeverage).gt(ZERO);
          expect(finalLeverage).gt(ZERO);
          expect(initialLeverage).gt(finalLeverage);
        });

        it("buys expected amount of vBase", async () => {
          await perpSetup.clearingHouse.connect(maker.wallet).openPosition({
            baseToken: vETH.address,
            isBaseToQuote: false,     // long
            isExactInput: true,       // `amount` is USDC
            amount: ether(10000),     // move price up by buying 10k USDC of vETH
            oppositeAmountBound: ZERO,
            deadline: MAX_UINT_256,
            sqrtPriceLimitX96: ZERO,
            referralCode: ZERO_BYTES
          });

          const initialBaseBalance = (await perpLeverageModule.getPositionNotionalInfo(subjectSetToken))[0].baseBalance;
          await subject();
          const finalBaseBalance = (await perpLeverageModule.getPositionNotionalInfo(subjectSetToken))[0].baseBalance;

          const basePositionUnit = preciseDiv(initialBaseBalance, await setToken.totalSupply());
          const baseTokenBoughtNotional = preciseMul(basePositionUnit, subjectSetQuantity);
          const expectedBaseBalance = initialBaseBalance.add(baseTokenBoughtNotional);

          expect(finalBaseBalance).eq(expectedBaseBalance);
        });

        it("should set the expected USDC externalPositionUnit", async () => {
          await perpSetup.clearingHouse.connect(maker.wallet).openPosition({
            baseToken: vETH.address,
            isBaseToQuote: false,     // long
            isExactInput: true,       // `amount` is USDC
            amount: ether(10000),     // move price up by buying 10k worth of vETH
            oppositeAmountBound: ZERO,
            deadline: MAX_UINT_256,
            sqrtPriceLimitX96: ZERO,
            referralCode: ZERO_BYTES
          });

          const usdcTransferInQuantity = await calculateUSDCTransferInPreciseUnits(
            setToken,
            subjectSetQuantity,
            perpLeverageModule,
            perpSetup
          );

          await subject();

          const expectedExternalPositionUnit = toUSDCDecimals(
            preciseDiv(usdcTransferInQuantity, subjectSetQuantity)
          );

          const externalPositionUnit = await setToken.getExternalPositionRealUnit(
            usdc.address,
            perpLeverageModule.address
          );

          expect(externalPositionUnit).to.be.eq(expectedExternalPositionUnit);
        });
      });

      describe("when issuing multiple sets", async () => {
        beforeEach(async () => {
          subjectSetQuantity = ether(2);
        });

        it("buys expected amount of vETH, vBTC", async () => {
          const totalSupply = await setToken.totalSupply();
          const initialPositionInfo = await perpLeverageModule.getPositionNotionalInfo(subjectSetToken);
          const initialBalance = initialPositionInfo[0].baseBalance;

          await subject();

          const finalPositionInfo = await perpLeverageModule.getPositionNotionalInfo(subjectSetToken);
          const finalBalance = finalPositionInfo[0].baseBalance;

          const basePositionUnit = preciseDiv(initialBalance, totalSupply);
          const baseBoughtNotional = preciseMul(basePositionUnit, subjectSetQuantity);

          const expectedBalance = initialBalance.add(baseBoughtNotional);

          expect(finalBalance).eq(expectedBalance);
        });

        it("should set the expected USDC externalPositionUnit", async () => {
          const usdcTransferInQuantity = await calculateUSDCTransferInPreciseUnits(
            setToken,
            subjectSetQuantity,
            perpLeverageModule,
            perpSetup
          );

          await subject();

          const expectedExternalPositionUnit = toUSDCDecimals(
            preciseDiv(usdcTransferInQuantity, subjectSetQuantity)
          );

          const externalPositionUnit = await setToken.getExternalPositionRealUnit(
            usdc.address,
            perpLeverageModule.address
          );

          expect(externalPositionUnit).to.be.eq(expectedExternalPositionUnit);
        });
      });
    });

    describe("when long, multiple positions", async () => {
      // Set up as 2X Long, allow 2% slippage
      cacheBeforeEach(async () => {
        await leverUp(
          setToken,
          perpLeverageModule,
          perpSetup,
          owner,
          vETH.address,
          2,
          ether(.02),
          true
        );

        await leverUp(
          setToken,
          perpLeverageModule,
          perpSetup,
          owner,
          vBTC.address,
          1,
          ether(.02),
          true
        );
      });

      describe("when issuing a single set", async () => {
        it("buys expected amount of vETH, vBTC", async () => {
          const totalSupply = await setToken.totalSupply();
          const initialPositionInfo = await perpLeverageModule.getPositionNotionalInfo(subjectSetToken);

          const initialVETHBalance = initialPositionInfo[0].baseBalance;
          const initialVBTCBalance = initialPositionInfo[1].baseBalance;

          await subject();

          const finalPositionInfo = await perpLeverageModule.getPositionNotionalInfo(subjectSetToken);
          const finalVETHBalance = finalPositionInfo[0].baseBalance;
          const finalVBTCBalance = finalPositionInfo[1].baseBalance;

          const vETHPositionUnit = preciseDiv(initialVETHBalance, totalSupply);
          const vBTCPositionUnit = preciseDiv(initialVBTCBalance, totalSupply);

          const vETHBoughtNotional = preciseMul(vETHPositionUnit, subjectSetQuantity);
          const vBTCBoughtNotional = preciseMul(vBTCPositionUnit, subjectSetQuantity);

          const expectedVETHBalance = initialVETHBalance.add(vETHBoughtNotional);
          const expectedVBTCBalance = initialVBTCBalance.add(vBTCBoughtNotional);

          expect(finalVETHBalance).eq(expectedVETHBalance);
          expect(finalVBTCBalance).eq(expectedVBTCBalance);
        });

        it("should set the expected USDC externalPositionUnit", async () => {
          const usdcTransferInQuantity = await calculateUSDCTransferInPreciseUnits(
            setToken,
            subjectSetQuantity,
            perpLeverageModule,
            perpSetup
          );

          await subject();

          const expectedExternalPositionUnit = toUSDCDecimals(
            preciseDiv(usdcTransferInQuantity, subjectSetQuantity)
          );

          const externalPositionUnit = await setToken.getExternalPositionRealUnit(
            usdc.address,
            perpLeverageModule.address
          );

          expect(externalPositionUnit).to.be.eq(expectedExternalPositionUnit);
        });
      });

      describe("when issuing multiple sets", async () => {
        beforeEach(async () => {
          subjectSetQuantity = ether(2);
        });

        it("buys expected amount of vETH, vBTC", async () => {
          const totalSupply = await setToken.totalSupply();
          const initialPositionInfo = await perpLeverageModule.getPositionNotionalInfo(subjectSetToken);

          const initialVETHBalance = initialPositionInfo[0].baseBalance;
          const initialVBTCBalance = initialPositionInfo[1].baseBalance;

          await subject();

          const finalPositionInfo = await perpLeverageModule.getPositionNotionalInfo(subjectSetToken);
          const finalVETHBalance = finalPositionInfo[0].baseBalance;
          const finalVBTCBalance = finalPositionInfo[1].baseBalance;

          const vETHPositionUnit = preciseDiv(initialVETHBalance, totalSupply);
          const vBTCPositionUnit = preciseDiv(initialVBTCBalance, totalSupply);

          const vETHBoughtNotional = preciseMul(vETHPositionUnit, subjectSetQuantity);
          const vBTCBoughtNotional = preciseMul(vBTCPositionUnit, subjectSetQuantity);

          const expectedVETHBalance = initialVETHBalance.add(vETHBoughtNotional);
          const expectedVBTCBalance = initialVBTCBalance.add(vBTCBoughtNotional);

          expect(finalVETHBalance).eq(expectedVETHBalance);
          expect(finalVBTCBalance).eq(expectedVBTCBalance);
        });

        it("should set the expected USDC externalPositionUnit", async () => {
          const usdcTransferInQuantity = await calculateUSDCTransferInPreciseUnits(
            setToken,
            subjectSetQuantity,
            perpLeverageModule,
            perpSetup
          );

          await subject();

          const expectedExternalPositionUnit = toUSDCDecimals(
            preciseDiv(usdcTransferInQuantity, subjectSetQuantity)
          );

          const externalPositionUnit = await setToken.getExternalPositionRealUnit(
            usdc.address,
            perpLeverageModule.address
          );

          expect(externalPositionUnit).to.be.eq(expectedExternalPositionUnit);
        });
      });

      describe("when the Set owes funding", async () => {
        beforeEach(async() => {
          // set funding rate to non-zero value
          await perpSetup.clearingHouseConfig.setMaxFundingRate(BigNumber.from(0.1e6));       // 10% in decimal 6
        });

        it("should socialize the funding payment among existing set holders", async () => {
          // Move oracle price down and wait one day
          await perpSetup.setBaseTokenOraclePrice(vETH, usdcUnits(9.8));
          await perpSetup.setBaseTokenOraclePrice(vBTC, usdcUnits(19.9));
          await increaseTimeAsync(ONE_DAY_IN_SECONDS);

          const vEthBalance = await perpSetup.accountBalance.getBase(setToken.address, vETH.address);
          const vBtcBalance = await perpSetup.accountBalance.getBase(setToken.address, vBTC.address);
          const pendingFunding = (await perpLeverageModule.getAccountInfo(subjectSetToken)).pendingFundingPayments;
          const usdcTransferInQuantity = await calculateUSDCTransferInPreciseUnits(
            setToken,
            subjectSetQuantity,
            perpLeverageModule,
            perpSetup,
            false       // don't include funding
          );

          await subject();

          const vEthUsdcAmountDelta = await getUSDCDeltaDueToFundingGrowth(setToken, subjectSetQuantity, vETH.address, vEthBalance, perpSetup);
          const vBtcUsdcAmountDelta = await getUSDCDeltaDueToFundingGrowth(setToken, subjectSetQuantity, vBTC.address, vBtcBalance, perpSetup);
          const expectedExternalPositionUnit = toUSDCDecimals(
            preciseDiv(usdcTransferInQuantity.add(vEthUsdcAmountDelta).add(vBtcUsdcAmountDelta), subjectSetQuantity)
          );

          const externalPositionUnit = await setToken.getExternalPositionRealUnit(
            usdc.address,
            perpLeverageModule.address
          );

          expect(pendingFunding).lt(0);
          expect(externalPositionUnit).to.be.eq(expectedExternalPositionUnit);
        });
      });

      describe("when the Set is owed funding", async () => {
        beforeEach(async() => {
          // set funding rate to non-zero value
          await perpSetup.clearingHouseConfig.setMaxFundingRate(BigNumber.from(0.1e6));       // 10% in decimal 6
        });

        it("should socialize the funding payment among existing set holders", async () => {
          // Move oracle price up and wait one day
          await perpSetup.setBaseTokenOraclePrice(vETH, usdcUnits(10.5));
          await perpSetup.setBaseTokenOraclePrice(vBTC, usdcUnits(20.1));

          await increaseTimeAsync(ONE_DAY_IN_SECONDS);

          const vEthBalance = await perpSetup.accountBalance.getBase(setToken.address, vETH.address);
          const vBtcBalance = await perpSetup.accountBalance.getBase(setToken.address, vBTC.address);
          const pendingFunding = (await perpLeverageModule.getAccountInfo(subjectSetToken)).pendingFundingPayments;
          const usdcTransferInQuantity = await calculateUSDCTransferInPreciseUnits(
            setToken,
            subjectSetQuantity,
            perpLeverageModule,
            perpSetup,
            false       // don't include funding
          );

          await subject();

          const vEthUsdcAmountDelta = await getUSDCDeltaDueToFundingGrowth(setToken, subjectSetQuantity, vETH.address, vEthBalance, perpSetup);
          const vBtcUsdcAmountDelta = await getUSDCDeltaDueToFundingGrowth(setToken, subjectSetQuantity, vBTC.address, vBtcBalance, perpSetup);
          const expectedExternalPositionUnit = toUSDCDecimals(
            preciseDiv(usdcTransferInQuantity.add(vEthUsdcAmountDelta).add(vBtcUsdcAmountDelta), subjectSetQuantity)
          );

          const externalPositionUnit = await setToken.getExternalPositionRealUnit(
            usdc.address,
            perpLeverageModule.address
          );

          expect(pendingFunding).gt(ZERO);
          expect(externalPositionUnit).to.be.eq(expectedExternalPositionUnit);
        });
      });

      describe("when there is positive owedRealizedPnl", async () => {
        beforeEach(async () => {
          // Move price up by maker buying 20k USDC of vETH
          await perpSetup.clearingHouse.connect(maker.wallet).openPosition({
            baseToken: vETH.address,
            isBaseToQuote: false,     // long
            isExactInput: true,       // `amount` is USDC
            amount: ether(20000),
            oppositeAmountBound: ZERO,
            deadline: MAX_UINT_256,
            sqrtPriceLimitX96: ZERO,
            referralCode: ZERO_BYTES
          });

          await perpSetup.clearingHouse.connect(maker.wallet).openPosition({
            baseToken: vBTC.address,
            isBaseToQuote: false,     // long
            isExactInput: true,       // `amount` is USDC
            amount: ether(20000),
            oppositeAmountBound: ZERO,
            deadline: MAX_UINT_256,
            sqrtPriceLimitX96: ZERO,
            referralCode: ZERO_BYTES
          });

          // Delever a little, booking profit to owedRealizedPnl
          await perpLeverageModule.connect(owner.wallet).trade(
            subjectSetToken,
            vETH.address,
            ether(-.4),
            ether(4)
          );

          await perpLeverageModule.connect(owner.wallet).trade(
            subjectSetToken,
            vBTC.address,
            ether(-.2),
            ether(2)
          );
        });

        it("should set the expected USDC externalPositionUnit", async () => {
          const owedRealizedPnl = (await perpLeverageModule.getAccountInfo(subjectSetToken)).owedRealizedPnl;

          const usdcTransferInQuantity = await calculateUSDCTransferIn(
            setToken,
            subjectSetQuantity,
            perpLeverageModule,
            perpSetup
          );

          const expectedExternalPositionUnit = preciseDiv(usdcTransferInQuantity, subjectSetQuantity);

          await subject();

          const externalPositionUnit = await setToken.getExternalPositionRealUnit(
            usdc.address,
            perpLeverageModule.address
          );

          expect(owedRealizedPnl).gt(0);
          expect(externalPositionUnit).to.be.eq(expectedExternalPositionUnit);
        });
      });
    });

    describe("when short", async () => {
      let baseToken: Address;

      // Set up as 2X Short, allow 2% slippage
      cacheBeforeEach(async () => {
        baseToken = vETH.address;
        await leverUp(
          setToken,
          perpLeverageModule,
          perpSetup,
          owner,
          baseToken,
          2,
          ether(.02),
          false
        );
      });

      async function subject(): Promise<any> {
        await perpLeverageModule
          .connect(subjectCaller.wallet)
          .moduleIssueHook(subjectSetToken, subjectSetQuantity);
      }

      describe("when issuing a single set", async () => {
        it("shorts expected amount of vBase", async () => {
          const totalSupply = await setToken.totalSupply();

          const initialBaseBalance = (await perpLeverageModule.getPositionNotionalInfo(subjectSetToken))[0].baseBalance;
          await subject();
          const finalBaseBalance = (await perpLeverageModule.getPositionNotionalInfo(subjectSetToken))[0].baseBalance;

          const basePositionUnit = preciseDiv(initialBaseBalance, totalSupply);
          const baseTokenSoldNotional = preciseMul(basePositionUnit, subjectSetQuantity);
          const expectedBaseBalance = initialBaseBalance.add(baseTokenSoldNotional);

          expect(finalBaseBalance).eq(expectedBaseBalance);
        });

        it("should set the expected USDC externalPositionUnit", async () => {
          const usdcTransferInQuantity = await calculateUSDCTransferInPreciseUnits(
            setToken,
            subjectSetQuantity,
            perpLeverageModule,
            perpSetup
          );

          await subject();

          const expectedExternalPositionUnit = toUSDCDecimals(
            preciseDiv(usdcTransferInQuantity, subjectSetQuantity)
          );

          const externalPositionUnit = await setToken.getExternalPositionRealUnit(
            usdc.address,
            perpLeverageModule.address
          );

          expect(externalPositionUnit).to.be.eq(expectedExternalPositionUnit);
        });
      });

      describe("when there is positive owedRealizedPnl", async () => {
        beforeEach(async () => {
          // Move price down by maker selling 10k USDC of vETH
          await perpSetup.clearingHouse.connect(maker.wallet).openPosition({
            baseToken: vETH.address,
            isBaseToQuote: true,     // short
            isExactInput: false,     // `amount` is USDC
            amount: ether(1000),
            oppositeAmountBound: ZERO,
            deadline: MAX_UINT_256,
            sqrtPriceLimitX96: ZERO,
            referralCode: ZERO_BYTES
          });

          // Buy a little, booking profit to owedRealizedPnl
          await perpLeverageModule.connect(owner.wallet).trade(
            subjectSetToken,
            vETH.address,
            ether(.1),
            ether(2)
          );
        });

        it("should set the expected USDC externalPositionUnit", async () => {
          const owedRealizedPnl = (await perpLeverageModule.getAccountInfo(subjectSetToken)).owedRealizedPnl;

          const usdcTransferInQuantity = await calculateUSDCTransferIn(
            setToken,
            subjectSetQuantity,
            perpLeverageModule,
            perpSetup
          );

          const expectedExternalPositionUnit = preciseDiv(
            usdcTransferInQuantity,
            subjectSetQuantity
          );

          await subject();

          const externalPositionUnit = await setToken.getExternalPositionRealUnit(
            usdc.address,
            perpLeverageModule.address
          );

          expect(owedRealizedPnl).gt(0);
          expect(externalPositionUnit).to.be.eq(expectedExternalPositionUnit);
        });
      });

      describe("when there is negative owedRealizedPnl", async () => {
        beforeEach(async () => {
          // Move price up by maker buying 20k USDC of vETH
          await perpSetup.clearingHouse.connect(maker.wallet).openPosition({
            baseToken: vETH.address,
            isBaseToQuote: false,       // long
            isExactInput: true,         // `amount` is USDC
            amount: ether(1000),
            oppositeAmountBound: ZERO,
            deadline: MAX_UINT_256,
            sqrtPriceLimitX96: ZERO,
            referralCode: ZERO_BYTES
          });

          // Buy a little, booking loss to owedRealizedPnl
          await perpLeverageModule.connect(owner.wallet).trade(
            subjectSetToken,
            vETH.address,
            ether(.1),
            ether(2)
          );
        });

        it("should set the expected USDC externalPositionUnit", async () => {
          const owedRealizedPnl = (await perpLeverageModule.getAccountInfo(subjectSetToken)).owedRealizedPnl;


          const usdcTransferInQuantity = await calculateUSDCTransferIn(
            setToken,
            subjectSetQuantity,
            perpLeverageModule,
            perpSetup
          );

          const expectedExternalPositionUnit = preciseDiv(
            usdcTransferInQuantity,
            subjectSetQuantity
          );

          await subject();

          const externalPositionUnit = await setToken.getExternalPositionRealUnit(
            usdc.address,
            perpLeverageModule.address
          );

          expect(owedRealizedPnl).lt(0);
          expect(externalPositionUnit).to.be.eq(expectedExternalPositionUnit);
        });
      });

      describe("when the Set owes funding", async () => {
        beforeEach(async() => {
          // set funding rate to non-zero value
          await perpSetup.clearingHouseConfig.setMaxFundingRate(BigNumber.from(0.1e6));       // 10% in decimal 6
        });

        it("should socialize the funding payment among existing set holders", async () => {
          // Move oracle price up and wait one day
          await perpSetup.setBaseTokenOraclePrice(vETH, usdcUnits(10.5));
          await increaseTimeAsync(ONE_DAY_IN_SECONDS);

          const baseBalance = await perpSetup.accountBalance.getBase(setToken.address, baseToken);
          const pendingFunding = (await perpLeverageModule.getAccountInfo(subjectSetToken)).pendingFundingPayments;

          const usdcTransferInQuantity = await calculateUSDCTransferInPreciseUnits(
            setToken,
            subjectSetQuantity,
            perpLeverageModule,
            perpSetup,
            false       // don't include funding
          );

          await subject();

          const usdcAmountDelta = await getUSDCDeltaDueToFundingGrowth(setToken, subjectSetQuantity, baseToken, baseBalance, perpSetup);
          const expectedExternalPositionUnit = toUSDCDecimals(
            preciseDiv(usdcTransferInQuantity.add(usdcAmountDelta), subjectSetQuantity)
          );

          const externalPositionUnit = await setToken.getExternalPositionRealUnit(
            usdc.address,
            perpLeverageModule.address
          );

          expect(pendingFunding).lt(0);
          expect(externalPositionUnit).to.be.eq(expectedExternalPositionUnit);
        });
      });

      describe("when the Set is owed funding", async () => {
        beforeEach(async() => {
          // set funding rate to non-zero value
          await perpSetup.clearingHouseConfig.setMaxFundingRate(BigNumber.from(0.1e6));       // 10% in decimal 6
        });

        it("should socialize the funding payment among existing set holders", async () => {
          // Move oracle price down and wait one day
          await perpSetup.setBaseTokenOraclePrice(vETH, usdcUnits(5));
          await increaseTimeAsync(ONE_DAY_IN_SECONDS);

          const baseBalance = await perpSetup.accountBalance.getBase(setToken.address, baseToken);
          const pendingFunding = (await perpLeverageModule.getAccountInfo(subjectSetToken)).pendingFundingPayments;
          const usdcTransferInQuantity = await calculateUSDCTransferInPreciseUnits(
            setToken,
            subjectSetQuantity,
            perpLeverageModule,
            perpSetup,
            false       // don't include funding
          );

          await subject();

          const usdcAmountDelta = await getUSDCDeltaDueToFundingGrowth(setToken, subjectSetQuantity, baseToken, baseBalance, perpSetup);
          const expectedExternalPositionUnit = toUSDCDecimals(
            preciseDiv(usdcTransferInQuantity.add(usdcAmountDelta), subjectSetQuantity)
          );

          const externalPositionUnit = await setToken.getExternalPositionRealUnit(
            usdc.address,
            perpLeverageModule.address
          );

          expect(pendingFunding).gt(ZERO);
          expect(externalPositionUnit).to.be.eq(expectedExternalPositionUnit);
        });
      });

      describe("when the market price moves down and leverage drops", async () => {
        it("test assumptions and preconditions should be correct", async () => {
          let positionInfo = (await perpLeverageModule.getPositionNotionalInfo(subjectSetToken))[0];
          let collateralBalance = (await perpLeverageModule.getAccountInfo(subjectSetToken)).collateralBalance;

          const initialLeverage = await perpSetup.getCurrentLeverage(subjectSetToken, positionInfo, collateralBalance);
          const initialSpotPrice = await perpSetup.getSpotPrice(vETH.address);
          const initialUSDCTransferInQuantity = await calculateUSDCTransferIn(
            setToken,
            subjectSetQuantity,
            perpLeverageModule,
            perpSetup
          );

          await perpSetup.clearingHouse.connect(maker.wallet).openPosition({
            baseToken: vETH.address,
            isBaseToQuote: true,       // short
            isExactInput: false,       // `amount` is USDC
            amount: ether(10000),      // move price down by selling 10k USDC of vETH
            oppositeAmountBound: ZERO,
            deadline: MAX_UINT_256,
            sqrtPriceLimitX96: ZERO,
            referralCode: ZERO_BYTES
          });

          positionInfo = (await perpLeverageModule.getPositionNotionalInfo(subjectSetToken))[0];
          collateralBalance = (await perpLeverageModule.getAccountInfo(subjectSetToken)).collateralBalance;

          const finalLeverage = await perpSetup.getCurrentLeverage(subjectSetToken, positionInfo, collateralBalance);
          const finalSpotPrice = await perpSetup.getSpotPrice(vETH.address);
          const finalUSDCTransferInQuantity = await calculateUSDCTransferIn(
            setToken,
            subjectSetQuantity,
            perpLeverageModule,
            perpSetup
          );

          expect(initialSpotPrice).gt(finalSpotPrice);
          expect(initialUSDCTransferInQuantity).lt(finalUSDCTransferInQuantity);
          expect(initialLeverage).gt(ZERO);
          expect(finalLeverage).gt(ZERO);
          expect(initialLeverage).gt(finalLeverage);
        });

        it("sells expected amount of vBase", async () => {
          await perpSetup.clearingHouse.connect(maker.wallet).openPosition({
            baseToken: vETH.address,
            isBaseToQuote: true,       // short
            isExactInput: false,       // `amount` is USDC
            amount: ether(10000),      // move price down by selling 10k USDC of vETH
            oppositeAmountBound: ZERO,
            deadline: MAX_UINT_256,
            sqrtPriceLimitX96: ZERO,
            referralCode: ZERO_BYTES
          });

          const initialBaseBalance = (await perpLeverageModule.getPositionNotionalInfo(subjectSetToken))[0].baseBalance;
          await subject();
          const finalBaseBalance = (await perpLeverageModule.getPositionNotionalInfo(subjectSetToken))[0].baseBalance;

          const basePositionUnit = preciseDiv(initialBaseBalance, await setToken.totalSupply());
          const baseTokenBoughtNotional = preciseMul(basePositionUnit, subjectSetQuantity);
          const expectedBaseBalance = initialBaseBalance.add(baseTokenBoughtNotional);

          expect(finalBaseBalance).eq(expectedBaseBalance);
        });

        it("should set the expected USDC externalPositionUnit", async () => {
          await perpSetup.clearingHouse.connect(maker.wallet).openPosition({
            baseToken: vETH.address,
            isBaseToQuote: true,       // short
            isExactInput: false,       // `amount` is USDC
            amount: ether(10000),      // move price down by selling 10k USDC of vETH
            oppositeAmountBound: ZERO,
            deadline: MAX_UINT_256,
            sqrtPriceLimitX96: ZERO,
            referralCode: ZERO_BYTES
          });

          const usdcTransferInQuantity = await calculateUSDCTransferInPreciseUnits(
            setToken,
            subjectSetQuantity,
            perpLeverageModule,
            perpSetup
          );

          await subject();

          const expectedExternalPositionUnit = toUSDCDecimals(
            preciseDiv(usdcTransferInQuantity, subjectSetQuantity)
          );

          const externalPositionUnit = await setToken.getExternalPositionRealUnit(
            usdc.address,
            perpLeverageModule.address
          );

          expect(externalPositionUnit).to.be.eq(expectedExternalPositionUnit);
        });
      });
    });

    describe("when long one asset and short another", async () => {
      // Long 2 ETH @ 10 USDC, Short 1 BTC @ 20 USDC
      cacheBeforeEach(async () => {
        await leverUp(setToken, perpLeverageModule, perpSetup, owner, vETH.address, 2, ether(.02), true);
        await leverUp(setToken, perpLeverageModule, perpSetup, owner, vBTC.address, 2, ether(.02), false);
      });

      describe("when issuing a single set", async () => {
        beforeEach(async () => {
          const vETHSpotPrice = await perpSetup.getSpotPrice(vETH.address);
          await perpSetup.setBaseTokenOraclePrice(vETH, vETHSpotPrice.div(10 ** 12));
        });

        it("buys expected amount of vETH, vBTC", async () => {
          const totalSupply = await setToken.totalSupply();
          const initialPositionInfo = await perpLeverageModule.getPositionNotionalInfo(subjectSetToken);

          const initialVETHBalance = initialPositionInfo[0].baseBalance;
          const initialVBTCBalance = initialPositionInfo[1].baseBalance;

          await subject();

          const finalPositionInfo = await perpLeverageModule.getPositionNotionalInfo(subjectSetToken);
          const finalVETHBalance = finalPositionInfo[0].baseBalance;
          const finalVBTCBalance = finalPositionInfo[1].baseBalance;

          const vETHPositionUnit = preciseDiv(initialVETHBalance, totalSupply);
          const vBTCPositionUnit = preciseDiv(initialVBTCBalance, totalSupply);

          const vETHBoughtNotional = preciseMul(vETHPositionUnit, subjectSetQuantity);
          const vBTCBoughtNotional = preciseMul(vBTCPositionUnit, subjectSetQuantity);

          const expectedVETHBalance = initialVETHBalance.add(vETHBoughtNotional);
          const expectedVBTCBalance = initialVBTCBalance.add(vBTCBoughtNotional);

          expect(finalVETHBalance).eq(expectedVETHBalance);
          expect(finalVBTCBalance).eq(expectedVBTCBalance);
        });

        it("should set the expected USDC externalPositionUnit", async () => {
          const usdcTransferInQuantity = await calculateUSDCTransferInPreciseUnits(
            setToken,
            subjectSetQuantity,
            perpLeverageModule,
            perpSetup
          );

          await subject();

          const expectedExternalPositionUnit = toUSDCDecimals(
            preciseDiv(usdcTransferInQuantity, subjectSetQuantity)
          );

          const externalPositionUnit = await setToken.getExternalPositionRealUnit(
            usdc.address,
            perpLeverageModule.address
          );
          expect(externalPositionUnit).to.be.eq(expectedExternalPositionUnit);
        });

        // Long profit case
        describe("when the long asset market price moves up and leverage drops", async () => {
          it("test assumptions and preconditions should be correct", async () => {
            let positionInfo = (await perpLeverageModule.getPositionNotionalInfo(subjectSetToken))[0];
            let collateralBalance = (await perpLeverageModule.getAccountInfo(subjectSetToken)).collateralBalance;

            const initialLeverage = await perpSetup.getCurrentLeverage(subjectSetToken, positionInfo, collateralBalance);
            const initialSpotPrice = await perpSetup.getSpotPrice(vETH.address);
            const initialUSDCTransferInQuantity = await calculateUSDCTransferIn(
              setToken,
              subjectSetQuantity,
              perpLeverageModule,
              perpSetup
            );

            // Price increases from ~10 USDC to 12_086_807_119_488_051_322 (~20%)
            await perpSetup.clearingHouse.connect(maker.wallet).openPosition({
              baseToken: vETH.address,
              isBaseToQuote: false,      // long
              isExactInput: true,        // `amount` is USDC
              amount: ether(10000),      // move price up by buying 10k USDC of vETH
              oppositeAmountBound: ZERO,
              deadline: MAX_UINT_256,
              sqrtPriceLimitX96: ZERO,
              referralCode: ZERO_BYTES
            });

            positionInfo = (await perpLeverageModule.getPositionNotionalInfo(subjectSetToken))[0];
            collateralBalance = (await perpLeverageModule.getAccountInfo(subjectSetToken)).collateralBalance;

            const finalLeverage = await perpSetup.getCurrentLeverage(subjectSetToken, positionInfo, collateralBalance);
            const finalSpotPrice = await perpSetup.getSpotPrice(vETH.address);
            const finalUSDCTransferInQuantity = await calculateUSDCTransferIn(
              setToken,
              subjectSetQuantity,
              perpLeverageModule,
              perpSetup
            );


            // Leverage should drop as asset value rises
            // initialLeverage = 2041219945269276819
            // finalLeverage   = 1731198978421953524

            // Set should be worth 2X more as price increases in short asset
            // Price rose ~20%, so set worth ~40% more
            // initialUSDCTransferInQuantity  = 10018070
            // finalUSDCTransferInQuantity    = 14218995
            expect(initialSpotPrice).lt(finalSpotPrice);
            expect(initialUSDCTransferInQuantity).lt(finalUSDCTransferInQuantity);
            expect(initialLeverage).gt(ZERO);
            expect(finalLeverage).gt(ZERO);
            expect(initialLeverage).gt(finalLeverage);
          });

          it("sells expected amount of vBase", async () => {
            await perpSetup.clearingHouse.connect(maker.wallet).openPosition({
              baseToken: vETH.address,
              isBaseToQuote: true,       // long
              isExactInput: false,       // `amount` is USDC
              amount: ether(10000),      // move price up by buying 10k USDC of vETH
              oppositeAmountBound: ZERO,
              deadline: MAX_UINT_256,
              sqrtPriceLimitX96: ZERO,
              referralCode: ZERO_BYTES
            });

            const initialBaseBalance = (await perpLeverageModule.getPositionNotionalInfo(subjectSetToken))[0].baseBalance;
            await subject();
            const finalBaseBalance = (await perpLeverageModule.getPositionNotionalInfo(subjectSetToken))[0].baseBalance;

            const basePositionUnit = preciseDiv(initialBaseBalance, await setToken.totalSupply());
            const baseTokenBoughtNotional = preciseMul(basePositionUnit, subjectSetQuantity);
            const expectedBaseBalance = initialBaseBalance.add(baseTokenBoughtNotional);

            expect(finalBaseBalance).eq(expectedBaseBalance);
          });

          it("should set the expected USDC externalPositionUnit", async () => {
            await perpSetup.clearingHouse.connect(maker.wallet).openPosition({
              baseToken: vETH.address,
              isBaseToQuote: true,       // long
              isExactInput: false,       // `amount` is USDC
              amount: ether(1000),      // move price up by buying 1k USDC of vETH
              oppositeAmountBound: ZERO,
              deadline: MAX_UINT_256,
              sqrtPriceLimitX96: ZERO,
              referralCode: ZERO_BYTES
            });

            const usdcTransferInQuantity = await calculateUSDCTransferInPreciseUnits(
              setToken,
              subjectSetQuantity,
              perpLeverageModule,
              perpSetup
            );

            await subject();

            const expectedExternalPositionUnit = toUSDCDecimals(
              preciseDiv(usdcTransferInQuantity, subjectSetQuantity)
            );

            const externalPositionUnit = await setToken.getExternalPositionRealUnit(
              usdc.address,
              perpLeverageModule.address
            );

            expect(externalPositionUnit).to.be.eq(expectedExternalPositionUnit);
          });
        });

        // Short profit case
        describe("when the short asset market price moves down and leverage drops", async () => {
          it("test assumptions and preconditions should be correct", async () => {
            let positionInfo = (await perpLeverageModule.getPositionNotionalInfo(subjectSetToken))[1];
            let collateralBalance = (await perpLeverageModule.getAccountInfo(subjectSetToken)).collateralBalance;

            const initialLeverage = await perpSetup.getCurrentLeverage(subjectSetToken, positionInfo, collateralBalance);
            const initialSpotPrice = await perpSetup.getSpotPrice(vBTC.address);
            const initialUSDCTransferInQuantity = await calculateUSDCTransferIn(
              setToken,
              subjectSetQuantity,
              perpLeverageModule,
              perpSetup
            );

            // Price decreases from ~20 USDC to  16_156_467_088_301_771_700 (~20%)
            await perpSetup.clearingHouse.connect(maker.wallet).openPosition({
              baseToken: vBTC.address,
              isBaseToQuote: true,        // short
              isExactInput: false,        // `amount` is USDC
              amount: ether(20000),       // move price down by selling 20k USDC of vBTC
              oppositeAmountBound: ZERO,
              deadline: MAX_UINT_256,
              sqrtPriceLimitX96: ZERO,
              referralCode: ZERO_BYTES
            });


            positionInfo = (await perpLeverageModule.getPositionNotionalInfo(subjectSetToken))[1];
            collateralBalance = (await perpLeverageModule.getAccountInfo(subjectSetToken)).collateralBalance;

            const finalLeverage = await perpSetup.getCurrentLeverage(subjectSetToken, positionInfo, collateralBalance);
            const finalSpotPrice = await perpSetup.getSpotPrice(vBTC.address);
            const finalUSDCTransferInQuantity = await calculateUSDCTransferIn(
              setToken,
              subjectSetQuantity,
              perpLeverageModule,
              perpSetup
            );

            // Leverage should drop as asset value rises
            // initialLeverage  = 2039159946037302515
            // finalLeverage    = 1184528742574169001

            // Set should be worth 2X more as price decreases in short asset
            // Price dropped ~20%, so set worth ~40% more
            // initialUSDCTransferInQuantity = 10_018_070
            // finalUSDCTransferInQuantity   = 13_814_709
            expect(initialSpotPrice).gt(finalSpotPrice);
            expect(initialUSDCTransferInQuantity).lt(finalUSDCTransferInQuantity);
            expect(initialLeverage).gt(ZERO);
            expect(finalLeverage).gt(ZERO);
            expect(initialLeverage).gt(finalLeverage);
          });

          it("sells expected amount of vBase", async () => {
            await perpSetup.clearingHouse.connect(maker.wallet).openPosition({
              baseToken: vBTC.address,
              isBaseToQuote: true,        // short
              isExactInput: false,        // `amount` is USDC
              amount: ether(20000),       // move price down by selling 20k USDC of vBTC
              oppositeAmountBound: ZERO,
              deadline: MAX_UINT_256,
              sqrtPriceLimitX96: ZERO,
              referralCode: ZERO_BYTES
            });

            const initialBaseBalance = (await perpLeverageModule.getPositionNotionalInfo(subjectSetToken))[0].baseBalance;
            await subject();
            const finalBaseBalance = (await perpLeverageModule.getPositionNotionalInfo(subjectSetToken))[0].baseBalance;

            const basePositionUnit = preciseDiv(initialBaseBalance, await setToken.totalSupply());
            const baseTokenBoughtNotional = preciseMul(basePositionUnit, subjectSetQuantity);
            const expectedBaseBalance = initialBaseBalance.add(baseTokenBoughtNotional);

            expect(finalBaseBalance).eq(expectedBaseBalance);
          });

          it("should set the expected USDC externalPositionUnit", async () => {
            await perpSetup.clearingHouse.connect(maker.wallet).openPosition({
              baseToken: vBTC.address,
              isBaseToQuote: true,        // short
              isExactInput: false,        // `amount` is USDC
              amount: ether(2000),       // move price down by selling 2k USDC of vBTC
              oppositeAmountBound: ZERO,
              deadline: MAX_UINT_256,
              sqrtPriceLimitX96: ZERO,
              referralCode: ZERO_BYTES
            });

            const usdcTransferInQuantity = await calculateUSDCTransferInPreciseUnits(
              setToken,
              subjectSetQuantity,
              perpLeverageModule,
              perpSetup
            );

            await subject();

            const expectedExternalPositionUnit = toUSDCDecimals(
              preciseDiv(usdcTransferInQuantity, subjectSetQuantity)
            );

            const externalPositionUnit = await setToken.getExternalPositionRealUnit(
              usdc.address,
              perpLeverageModule.address
            );

            expect(externalPositionUnit).to.be.eq(expectedExternalPositionUnit);
          });
        });
      });

      describe("when there is positive owedRealizedPnl", async () => {
        beforeEach(async () => {
          // Move price up by maker selling buying USDC of vETH
          await perpSetup.clearingHouse.connect(maker.wallet).openPosition({
            baseToken: vETH.address,
            isBaseToQuote: false,     // long
            isExactInput: true,     // `amount` is USDC
            amount: ether(2000),
            oppositeAmountBound: ZERO,
            deadline: MAX_UINT_256,
            sqrtPriceLimitX96: ZERO,
            referralCode: ZERO_BYTES
          });

          // Sell a little, booking profit to owedRealizedPnl
          await perpLeverageModule.connect(owner.wallet).trade(
            subjectSetToken,
            vETH.address,
            ether(.1).mul(-1),
            ZERO
          );

          const vETHSpotPrice = await perpSetup.getSpotPrice(vETH.address);
          await perpSetup.setBaseTokenOraclePrice(vETH, vETHSpotPrice.div(10 ** 12));
        });

        it("should set the expected USDC externalPositionUnit", async () => {
          const owedRealizedPnl = (await perpLeverageModule.getAccountInfo(subjectSetToken)).owedRealizedPnl;

          const usdcTransferInQuantity = await calculateUSDCTransferIn(
            setToken,
            subjectSetQuantity,
            perpLeverageModule,
            perpSetup
          );

          const expectedExternalPositionUnit = preciseDiv(
            usdcTransferInQuantity,
            subjectSetQuantity
          );

          await subject();

          const externalPositionUnit = await setToken.getExternalPositionRealUnit(
            usdc.address,
            perpLeverageModule.address
          );

          expect(externalPositionUnit).to.be.eq(expectedExternalPositionUnit);
          expect(owedRealizedPnl).gt(0);
        });
      });

      describe("when there is negative owedRealizedPnl", async () => {
        beforeEach(async () => {
          // Move price down by maker selling 1k USDC of vETH
          await perpSetup.clearingHouse.connect(maker.wallet).openPosition({
            baseToken: vETH.address,
            isBaseToQuote: true,     // short
            isExactInput: false,     // `amount` is USDC
            amount: ether(1000),
            oppositeAmountBound: ZERO,
            deadline: MAX_UINT_256,
            sqrtPriceLimitX96: ZERO,
            referralCode: ZERO_BYTES
          });

          // Sell a little, booking profit to owedRealizedPnl
          await perpLeverageModule.connect(owner.wallet).trade(
            subjectSetToken,
            vETH.address,
            ether(.1).mul(-1),
            ZERO
          );

          const vETHSpotPrice = await perpSetup.getSpotPrice(vETH.address);
          await perpSetup.setBaseTokenOraclePrice(vETH, vETHSpotPrice.div(10 ** 12));
        });

        it("should set the expected USDC externalPositionUnit", async () => {
          const owedRealizedPnl = (await perpLeverageModule.getAccountInfo(subjectSetToken)).owedRealizedPnl;

          const usdcTransferInQuantity = await calculateUSDCTransferIn(
            setToken,
            subjectSetQuantity,
            perpLeverageModule,
            perpSetup
          );

          const expectedExternalPositionUnit = preciseDiv(
            usdcTransferInQuantity,
            subjectSetQuantity
          );

          await subject();

          const externalPositionUnit = await setToken.getExternalPositionRealUnit(
            usdc.address,
            perpLeverageModule.address
          );

          expect(externalPositionUnit).to.be.eq(expectedExternalPositionUnit);
          expect(owedRealizedPnl).lt(0);
        });
      });

      describe("when the Set owes funding", async () => {
        beforeEach(async() => {
          // set funding rate to non-zero value
          await perpSetup.clearingHouseConfig.setMaxFundingRate(BigNumber.from(0.1e6));       // 10% in decimal 6
        });

        it("should socialize the funding payment among existing set holders", async () => {
          // Move oracle price up and wait one day
          await perpSetup.setBaseTokenOraclePrice(vETH, usdcUnits(9.5));
          await increaseTimeAsync(ONE_DAY_IN_SECONDS);

          const vEthBalance = await perpSetup.accountBalance.getBase(setToken.address, vETH.address);
          const vBtcBalance = await perpSetup.accountBalance.getBase(setToken.address, vBTC.address);
          const pendingFunding = (await perpLeverageModule.getAccountInfo(subjectSetToken)).pendingFundingPayments;
          const usdcTransferInQuantity = await calculateUSDCTransferInPreciseUnits(
            setToken,
            subjectSetQuantity,
            perpLeverageModule,
            perpSetup,
            false       // don't include funding
          );

          await subject();

          const vEthUsdcAmountDelta = await getUSDCDeltaDueToFundingGrowth(setToken, subjectSetQuantity, vETH.address, vEthBalance, perpSetup);
          const vBtcUsdcAmountDelta = await getUSDCDeltaDueToFundingGrowth(setToken, subjectSetQuantity, vBTC.address, vBtcBalance, perpSetup);
          const expectedExternalPositionUnit = toUSDCDecimals(
            preciseDiv(usdcTransferInQuantity.add(vEthUsdcAmountDelta).add(vBtcUsdcAmountDelta), subjectSetQuantity)
          );

          const externalPositionUnit = await setToken.getExternalPositionRealUnit(
            usdc.address,
            perpLeverageModule.address
          );

          expect(pendingFunding).lt(0);
          expect(externalPositionUnit).to.be.eq(expectedExternalPositionUnit);
        });
      });

      describe("when the Set is owed funding", async () => {
        beforeEach(async() => {
          // set funding rate to non-zero value
          await perpSetup.clearingHouseConfig.setMaxFundingRate(BigNumber.from(0.1e6));       // 10% in decimal 6
        });

        it("should socialize the funding payment among existing set holders", async () => {
          // Move oracle price down and wait one day
          await perpSetup.setBaseTokenOraclePrice(vETH, usdcUnits(11));
          await increaseTimeAsync(ONE_DAY_IN_SECONDS);

          const vEthBalance = await perpSetup.accountBalance.getBase(setToken.address, vETH.address);
          const vBtcBalance = await perpSetup.accountBalance.getBase(setToken.address, vBTC.address);
          const pendingFunding = (await perpLeverageModule.getAccountInfo(subjectSetToken)).pendingFundingPayments;
          const usdcTransferInQuantity = await calculateUSDCTransferInPreciseUnits(
            setToken,
            subjectSetQuantity,
            perpLeverageModule,
            perpSetup,
            false       // don't include funding
          );

          await subject();

          const vEthUsdcAmountDelta = await getUSDCDeltaDueToFundingGrowth(setToken, subjectSetQuantity, vETH.address, vEthBalance, perpSetup);
          const vBtcUsdcAmountDelta = await getUSDCDeltaDueToFundingGrowth(setToken, subjectSetQuantity, vBTC.address, vBtcBalance, perpSetup);
          const expectedExternalPositionUnit = toUSDCDecimals(
            preciseDiv(usdcTransferInQuantity.add(vEthUsdcAmountDelta).add(vBtcUsdcAmountDelta), subjectSetQuantity)
          );

          const externalPositionUnit = await setToken.getExternalPositionRealUnit(
            usdc.address,
            perpLeverageModule.address
          );

          expect(pendingFunding).gt(ZERO);
          expect(externalPositionUnit).to.be.eq(expectedExternalPositionUnit);
        });
      });

      describe("when market prices move up and leverage drops", async () => {
        it("test assumptions and preconditions should be correct", async () => {
          let positionInfo = (await perpLeverageModule.getPositionNotionalInfo(subjectSetToken))[0];
          let collateralBalance = (await perpLeverageModule.getAccountInfo(subjectSetToken)).collateralBalance;

          const initialLeverage = await perpSetup.getCurrentLeverage(subjectSetToken, positionInfo, collateralBalance);
          const initialSpotPrice = await perpSetup.getSpotPrice(vETH.address);
          const initialUSDCTransferInQuantity = await calculateUSDCTransferIn(
            setToken,
            subjectSetQuantity,
            perpLeverageModule,
            perpSetup
          );

          await perpSetup.clearingHouse.connect(maker.wallet).openPosition({
            baseToken: vETH.address,
            isBaseToQuote: false,       // long
            isExactInput: true,       // `amount` is USDC
            amount: ether(2000),      // move price up by buying 10k USDC of vETH
            oppositeAmountBound: ZERO,
            deadline: MAX_UINT_256,
            sqrtPriceLimitX96: ZERO,
            referralCode: ZERO_BYTES
          });

          await perpSetup.clearingHouse.connect(maker.wallet).openPosition({
            baseToken: vBTC.address,
            isBaseToQuote: false,       // long
            isExactInput: true,       // `amount` is USDC
            amount: ether(4000),      // move price up by buying 10k USDC of vBTC
            oppositeAmountBound: ZERO,
            deadline: MAX_UINT_256,
            sqrtPriceLimitX96: ZERO,
            referralCode: ZERO_BYTES
          });

          positionInfo = (await perpLeverageModule.getPositionNotionalInfo(subjectSetToken))[0];
          collateralBalance = (await perpLeverageModule.getAccountInfo(subjectSetToken)).collateralBalance;

          const finalLeverage = await perpSetup.getCurrentLeverage(subjectSetToken, positionInfo, collateralBalance);
          const finalSpotPrice = await perpSetup.getSpotPrice(vETH.address);
          const finalUSDCTransferInQuantity = await calculateUSDCTransferIn(
            setToken,
            subjectSetQuantity,
            perpLeverageModule,
            perpSetup
          );

          expect(initialSpotPrice).lt(finalSpotPrice);
          expect(initialUSDCTransferInQuantity).lt(finalUSDCTransferInQuantity);
          expect(initialLeverage).gt(ZERO);
          expect(finalLeverage).gt(ZERO);
          expect(initialLeverage).gt(finalLeverage);
        });

        it("sells expected amount of vBase", async () => {
          await perpSetup.clearingHouse.connect(maker.wallet).openPosition({
            baseToken: vETH.address,
            isBaseToQuote: true,       // short
            isExactInput: false,       // `amount` is USDC
            amount: ether(10000),      // move price down by selling 10k USDC of vETH
            oppositeAmountBound: ZERO,
            deadline: MAX_UINT_256,
            sqrtPriceLimitX96: ZERO,
            referralCode: ZERO_BYTES
          });

          const initialBaseBalance = (await perpLeverageModule.getPositionNotionalInfo(subjectSetToken))[0].baseBalance;
          await subject();
          const finalBaseBalance = (await perpLeverageModule.getPositionNotionalInfo(subjectSetToken))[0].baseBalance;

          const basePositionUnit = preciseDiv(initialBaseBalance, await setToken.totalSupply());
          const baseTokenBoughtNotional = preciseMul(basePositionUnit, subjectSetQuantity);
          const expectedBaseBalance = initialBaseBalance.add(baseTokenBoughtNotional);

          expect(finalBaseBalance).eq(expectedBaseBalance);
        });

        it("should set the expected USDC externalPositionUnit", async () => {
          await perpSetup.clearingHouse.connect(maker.wallet).openPosition({
            baseToken: vETH.address,
            isBaseToQuote: true,       // short
            isExactInput: false,       // `amount` is USDC
            amount: ether(10000),      // move price down by selling 10k USDC of vETH
            oppositeAmountBound: ZERO,
            deadline: MAX_UINT_256,
            sqrtPriceLimitX96: ZERO,
            referralCode: ZERO_BYTES
          });

          const usdcTransferInQuantity = await calculateUSDCTransferIn(
            setToken,
            subjectSetQuantity,
            perpLeverageModule,
            perpSetup
          );
          const expectedExternalPositionUnit = preciseDiv(usdcTransferInQuantity, subjectSetQuantity);

          await subject();

          const externalPositionUnit = await setToken.getExternalPositionRealUnit(
            usdc.address,
            perpLeverageModule.address
          );

          expect(externalPositionUnit).to.be.eq(expectedExternalPositionUnit);
        });
      });
    });

    describe("when collateral is deposited but no position is open", async () => {
      async function subject(): Promise<any> {
        await perpLeverageModule
          .connect(subjectCaller.wallet)
          .moduleIssueHook(subjectSetToken, subjectSetQuantity);
      }

      it("deposits the correct amount of collateral", async () => {
        const currentPositionUnit = await setToken.getExternalPositionRealUnit(perpSetup.usdc.address, perpLeverageModule.address);

        await subject();

        const newPositionUnit = await setToken.getExternalPositionRealUnit(perpSetup.usdc.address, perpLeverageModule.address);

        expect(currentPositionUnit).eq(newPositionUnit);
      });
    });

    describe("when total supply is 0", async () => {
      let otherSetToken: SetToken;

      beforeEach(async () => {
        otherSetToken = await setup.createSetToken(
          [usdc.address],
          [usdcUnits(10)],
          [perpLeverageModule.address, debtIssuanceMock.address]
        );
        await debtIssuanceMock.initialize(otherSetToken.address);
        await perpLeverageModule.updateAllowedSetToken(otherSetToken.address, true);
        await perpLeverageModule.connect(owner.wallet).initialize(otherSetToken.address);

        // Initialize mock module
        await otherSetToken.addModule(mockModule.address);
        await otherSetToken.connect(mockModule.wallet).initializeModule();

        subjectSetToken = otherSetToken.address;
      });

      it("should not update the USDC externalPositionUnit", async () => {
        const initialExternalPositionUnit = await otherSetToken.getExternalPositionRealUnit(usdc.address, perpLeverageModule.address);
        await subject();
        const finalExternalPositionUnit = await otherSetToken.getExternalPositionRealUnit(usdc.address, perpLeverageModule.address);

        const expectedExternalPositionUnit = ZERO;
        expect(initialExternalPositionUnit).to.eq(finalExternalPositionUnit);
        expect(finalExternalPositionUnit).to.eq(expectedExternalPositionUnit);
      });
    });

    describe("when there is no external USDC position", () => {
      let otherSetToken: SetToken;

      beforeEach(async () => {
        otherSetToken = await setup.createSetToken(
          [usdc.address],
          [usdcUnits(10)],
          [perpLeverageModule.address, debtIssuanceMock.address, setup.issuanceModule.address]
        );

        await debtIssuanceMock.initialize(otherSetToken.address);
        await perpLeverageModule.updateAllowedSetToken(otherSetToken.address, true);

        await perpLeverageModule.connect(owner.wallet).initialize(otherSetToken.address);

        await otherSetToken.addModule(mockModule.address);
        await otherSetToken.connect(mockModule.wallet).initializeModule();

        // Issue to create some supply
        await usdc.approve(setup.issuanceModule.address, usdcUnits(1000));
        await setup.issuanceModule.initialize(otherSetToken.address, ADDRESS_ZERO);
        await setup.issuanceModule.issue(otherSetToken.address, ether(1), owner.address);

        subjectSetToken = otherSetToken.address;
      });

      it("should not update the externalPositionUnit", async () => {
        const initialExternalPositionUnit = await otherSetToken.getExternalPositionRealUnit(
          usdc.address,
          perpLeverageModule.address
        );

        await subject();

        const finalExternalPositionUnit = await otherSetToken.getExternalPositionRealUnit(
          usdc.address,
          perpLeverageModule.address
        );

        expect(initialExternalPositionUnit).eq(ZERO);
        expect(initialExternalPositionUnit).eq(finalExternalPositionUnit);
      });
    });

    describe("when caller is not module", async () => {
      beforeEach(async () => {
        subjectCaller = owner;
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Only the module can call");
      });
    });

    describe("if disabled module is caller", async () => {
      beforeEach(async () => {
        await setup.controller.removeModule(mockModule.address);
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Module must be enabled on controller");
      });
    });
  });

  describe("#moduleRedeemHook", () => {
    let setToken: SetToken;
    let collateralQuantity: BigNumber;
    let subjectSetToken: Address;
    let subjectSetQuantity: BigNumber;
    let subjectCaller: Account;

    // Start with initial total supply (2)
    const initializeContracts = async () => {
      collateralQuantity = usdcUnits(10);
      setToken = await issueSetsAndDepositToPerp(collateralQuantity, true, ether(2));
    };

    const initializeSubjectVariables = () => {
      subjectSetToken = setToken.address;
      subjectCaller = mockModule;
      subjectSetQuantity = ether(1);
    };

    cacheBeforeEach(initializeContracts);
    beforeEach(initializeSubjectVariables);

    async function subject(): Promise<any> {
      return await perpLeverageModule
        .connect(subjectCaller.wallet)
        .moduleRedeemHook(subjectSetToken, subjectSetQuantity);
    }

    describe("when long", async () => {
      let baseToken: Address;

      // Set up as 2X Long, allow 2% slippage
      cacheBeforeEach(async () => {
        baseToken = vETH.address;
        await leverUp(
          setToken,
          perpLeverageModule,
          perpSetup,
          owner,
          baseToken,
          2,
          ether(.02),
          true
        );
      });

      describe("when redeeming a single set", async () => {
        it("sells expected amount of vBase", async () => {
          const totalSupply = await setToken.totalSupply();
          const initialBaseBalance = (await perpLeverageModule.getPositionNotionalInfo(subjectSetToken))[0].baseBalance;
          const basePositionUnit = preciseDiv(initialBaseBalance, totalSupply);

          await subject();

          const finalBaseBalance = (await perpLeverageModule.getPositionNotionalInfo(subjectSetToken))[0].baseBalance;
          const baseTokenSoldNotional = initialBaseBalance.sub(finalBaseBalance);

          const expectedBaseTokenSoldNotional = preciseMul(basePositionUnit, subjectSetQuantity);

          expect(baseTokenSoldNotional).eq(expectedBaseTokenSoldNotional);
        });

        it("should set the expected USDC externalPositionUnit", async () => {
          const usdcTransferOutQuantity = await calculateUSDCTransferOutPreciseUnits(
            setToken,
            subjectSetQuantity,
            perpLeverageModule,
            perpSetup
          );

          await subject();

          const expectedExternalPositionUnit = toUSDCDecimals(
            preciseDiv(usdcTransferOutQuantity, subjectSetQuantity)
          );

          const externalPositionUnit = await setToken.getExternalPositionRealUnit(
            usdc.address,
            perpLeverageModule.address
          );

          expect(externalPositionUnit).to.eq(expectedExternalPositionUnit);
        });
      });

      describe("when there is positive owedRealizedPnl", async () => {
        beforeEach(async () => {
          // Move price up by maker buying 1k USDC of vETH
          await perpSetup.clearingHouse.connect(maker.wallet).openPosition({
            baseToken: vETH.address,
            isBaseToQuote: false,     // long
            isExactInput: true,       // `amount` is USDC
            amount: ether(20000),
            oppositeAmountBound: ZERO,
            deadline: MAX_UINT_256,
            sqrtPriceLimitX96: ZERO,
            referralCode: ZERO_BYTES
          });

          // Sell a little, booking profit to owedRealizedPnl
          await perpLeverageModule.connect(owner.wallet).trade(
            subjectSetToken,
            vETH.address,
            ether(-.4),
            ether(4)
          );
        });

        it("should set the expected USDC externalPositionUnit", async () => {
          const owedRealizedPnl = (await perpLeverageModule.getAccountInfo(subjectSetToken)).owedRealizedPnl;

          const usdcTransferOutQuantity = await calculateUSDCTransferOut(
            setToken,
            subjectSetQuantity,
            perpLeverageModule,
            perpSetup
          );

          const expectedExternalPositionUnit = preciseDiv(
            usdcTransferOutQuantity,
            subjectSetQuantity
          );

          await subject();

          const externalPositionUnit = await setToken.getExternalPositionRealUnit(
            usdc.address,
            perpLeverageModule.address
          );

          expect(owedRealizedPnl).gt(0);
          expect(externalPositionUnit).to.be.eq(expectedExternalPositionUnit);
        });
      });

      describe("when there is negative owedRealizedPnl", async () => {
        beforeEach(async () => {
          // Move price down by maker selling 1k USDC of vETH
          await perpSetup.clearingHouse.connect(maker.wallet).openPosition({
            baseToken: vETH.address,
            isBaseToQuote: true,       // short
            isExactInput: false,       // `amount` is USDC
            amount: ether(10000),
            oppositeAmountBound: ZERO,
            deadline: MAX_UINT_256,
            sqrtPriceLimitX96: ZERO,
            referralCode: ZERO_BYTES
          });

          // Sell a little, booking loss to owedRealizedPnl
          await perpLeverageModule.connect(owner.wallet).trade(
            subjectSetToken,
            vETH.address,
            ether(-.2),
            ether(1)
          );
        });

        it("should set the expected USDC externalPositionUnit", async () => {
          const owedRealizedPnl = (await perpLeverageModule.getAccountInfo(subjectSetToken)).owedRealizedPnl;

          const usdcTransferOutQuantity = await calculateUSDCTransferOut(
            setToken,
            subjectSetQuantity,
            perpLeverageModule,
            perpSetup
          );

          const expectedExternalPositionUnit = preciseDiv(
            usdcTransferOutQuantity,
            subjectSetQuantity
          );

          await subject();

          const externalPositionUnit = await setToken.getExternalPositionRealUnit(
            usdc.address,
            perpLeverageModule.address
          );

          expect(owedRealizedPnl).lt(0);
          expect(externalPositionUnit).to.be.eq(expectedExternalPositionUnit);
        });
      });

      describe("when the Set owes funding", async () => {
        beforeEach(async() => {
          // set funding rate to non-zero value
          await perpSetup.clearingHouseConfig.setMaxFundingRate(BigNumber.from(0.1e6));       // 10% in decimal 6
        });

        it("should socialize the funding payment among existing set holders", async () => {
          // Move oracle price down and wait one day
          await perpSetup.setBaseTokenOraclePrice(vETH, usdcUnits(9.5));
          await increaseTimeAsync(ONE_DAY_IN_SECONDS);

          const vEthBalance = await perpSetup.accountBalance.getBase(setToken.address, vETH.address);
          const pendingFunding = (await perpLeverageModule.getAccountInfo(subjectSetToken)).pendingFundingPayments;
          const usdcTransferOutQuantity = await calculateUSDCTransferOutPreciseUnits(
            setToken,
            subjectSetQuantity,
            perpLeverageModule,
            perpSetup,
            false         // don't include funding
          );

          await subject();

          const vEthUsdcAmountDelta = await getUSDCDeltaDueToFundingGrowth(setToken, subjectSetQuantity, vETH.address, vEthBalance, perpSetup);
          const expectedExternalPositionUnit = toUSDCDecimals(
            preciseDiv(usdcTransferOutQuantity.add(vEthUsdcAmountDelta), subjectSetQuantity)
          );

          const externalPositionUnit = await setToken.getExternalPositionRealUnit(
            usdc.address,
            perpLeverageModule.address
          );

          expect(pendingFunding).lt(0);
          expect(externalPositionUnit).to.be.eq(expectedExternalPositionUnit);
        });
      });

      describe("when the Set is owed funding", async () => {
        beforeEach(async() => {
          // set funding rate to non-zero value
          await perpSetup.clearingHouseConfig.setMaxFundingRate(BigNumber.from(0.1e6));       // 10% in decimal 6
        });

        it("should socialize the funding payment among existing set holders", async () => {
          // Move oracle price up and wait one day
          await perpSetup.setBaseTokenOraclePrice(vETH, usdcUnits(15));
          await increaseTimeAsync(ONE_DAY_IN_SECONDS);

          const vEthBalance = await perpSetup.accountBalance.getBase(setToken.address, vETH.address);
          const pendingFunding = (await perpLeverageModule.getAccountInfo(subjectSetToken)).pendingFundingPayments;
          const usdcTransferOutQuantity = await calculateUSDCTransferOutPreciseUnits(
            setToken,
            subjectSetQuantity,
            perpLeverageModule,
            perpSetup,
            false         // don't include funding
          );

          await subject();

          const vEthUsdcAmountDelta = await getUSDCDeltaDueToFundingGrowth(setToken, subjectSetQuantity, vETH.address, vEthBalance, perpSetup);
          const expectedExternalPositionUnit = toUSDCDecimals(
            preciseDiv(usdcTransferOutQuantity.add(vEthUsdcAmountDelta), subjectSetQuantity)
          );

          const externalPositionUnit = await setToken.getExternalPositionRealUnit(
            usdc.address,
            perpLeverageModule.address
          );

          expect(pendingFunding).gt(ether(1));
          expect(externalPositionUnit).to.be.eq(expectedExternalPositionUnit);
        });
      });

      describe("when the market price moves up and leverage drops", async () => {
        it("test assumptions and preconditions should be correct", async () => {
          let positionInfo = (await perpLeverageModule.getPositionNotionalInfo(subjectSetToken))[0];
          let collateralBalance = (await perpLeverageModule.getAccountInfo(subjectSetToken)).collateralBalance;

          const initialLeverage = await perpSetup.getCurrentLeverage(subjectSetToken, positionInfo, collateralBalance);
          const initialSpotPrice = await perpSetup.getSpotPrice(vETH.address);
          const initialUSDCTransferOutQuantity = await calculateUSDCTransferOut(
            setToken,
            subjectSetQuantity,
            perpLeverageModule,
            perpSetup
          );

          await perpSetup.clearingHouse.connect(maker.wallet).openPosition({
            baseToken: vETH.address,
            isBaseToQuote: false,     // long
            isExactInput: true,       // `amount` is USDC
            amount: ether(10000),     // move price up by buying 10k USDC of vETH
            oppositeAmountBound: ZERO,
            deadline: MAX_UINT_256,
            sqrtPriceLimitX96: ZERO,
            referralCode: ZERO_BYTES
          });

          positionInfo = (await perpLeverageModule.getPositionNotionalInfo(subjectSetToken))[0];
          collateralBalance = (await perpLeverageModule.getAccountInfo(subjectSetToken)).collateralBalance;

          const finalLeverage = await perpSetup.getCurrentLeverage(subjectSetToken, positionInfo, collateralBalance);
          const finalSpotPrice = await perpSetup.getSpotPrice(vETH.address);
          const finalUSDCTransferOutQuantity = await calculateUSDCTransferOut(
            setToken,
            subjectSetQuantity,
            perpLeverageModule,
            perpSetup
          );

          expect(initialSpotPrice).lt(finalSpotPrice);
          expect(initialUSDCTransferOutQuantity).lt(finalUSDCTransferOutQuantity);
          expect(initialLeverage).gt(ZERO);
          expect(finalLeverage).gt(ZERO);
          expect(initialLeverage).gt(finalLeverage);
        });

        it("buys expected amount of vBase", async () => {
          await perpSetup.clearingHouse.connect(maker.wallet).openPosition({
            baseToken: vETH.address,
            isBaseToQuote: false,     // long
            isExactInput: true,       // `amount` is USDC
            amount: ether(10000),     // move price up by buying 10k USDC of vETH
            oppositeAmountBound: ZERO,
            deadline: MAX_UINT_256,
            sqrtPriceLimitX96: ZERO,
            referralCode: ZERO_BYTES
          });

          const initialBaseBalance = (await perpLeverageModule.getPositionNotionalInfo(subjectSetToken))[0].baseBalance;
          await subject();
          const finalBaseBalance = (await perpLeverageModule.getPositionNotionalInfo(subjectSetToken))[0].baseBalance;

          const basePositionUnit = preciseDiv(initialBaseBalance, await setToken.totalSupply());
          const baseTokenBoughtNotional = preciseMul(basePositionUnit, subjectSetQuantity);
          const expectedBaseBalance = initialBaseBalance.sub(baseTokenBoughtNotional);

          expect(finalBaseBalance).eq(expectedBaseBalance);
        });

        it("should set the expected USDC externalPositionUnit", async () => {
          await perpSetup.clearingHouse.connect(maker.wallet).openPosition({
            baseToken: vETH.address,
            isBaseToQuote: false,     // long
            isExactInput: true,       // `amount` is USDC
            amount: ether(10000),     // move price up by buying 10k USDC of vETH
            oppositeAmountBound: ZERO,
            deadline: MAX_UINT_256,
            sqrtPriceLimitX96: ZERO,
            referralCode: ZERO_BYTES
          });

          const usdcTransferOutQuantity = await calculateUSDCTransferOut(
            setToken,
            subjectSetQuantity,
            perpLeverageModule,
            perpSetup
          );
          const expectedExternalPositionUnit = preciseDiv(usdcTransferOutQuantity, subjectSetQuantity);

          await subject();

          const actualExternalPositionUnit = await setToken.getExternalPositionRealUnit(
            usdc.address,
            perpLeverageModule.address
          );

          expect(actualExternalPositionUnit).to.be.eq(expectedExternalPositionUnit);
        });
      });

      describe("when redeeming multiple sets", async () => {
        beforeEach(async () => {
          subjectSetQuantity = ether(2);
        });

        it("sells expected amount of vBase", async () => {
          const totalSupply = await setToken.totalSupply();
          const initialBaseBalance = (await perpLeverageModule.getPositionNotionalInfo(subjectSetToken))[0].baseBalance;
          const basePositionUnit = preciseDiv(initialBaseBalance, totalSupply);

          await subject();

          const finalBaseBalance = (await perpLeverageModule.getPositionNotionalInfo(subjectSetToken))[0].baseBalance;
          const baseTokenSoldNotional = initialBaseBalance.sub(finalBaseBalance);

          const expectedBaseTokenSoldNotional = preciseMul(basePositionUnit, subjectSetQuantity);

          expect(baseTokenSoldNotional).eq(expectedBaseTokenSoldNotional);
        });

        it("should set the expected USDC externalPositionUnit", async () => {
          const usdcTransferOutQuantity = await calculateUSDCTransferOutPreciseUnits(
            setToken,
            subjectSetQuantity,
            perpLeverageModule,
            perpSetup
          );

          await subject();

          const expectedExternalPositionUnit = toUSDCDecimals(
            preciseDiv(usdcTransferOutQuantity, subjectSetQuantity)
          );

          const externalPositionUnit = await setToken.getExternalPositionRealUnit(
            usdc.address,
            perpLeverageModule.address
          );

          expect(externalPositionUnit).to.eq(expectedExternalPositionUnit);
        });
      });
    });

    describe("when long, multiple positions", async () => {
      // Set up as 2X Long, allow 2% slippage
      cacheBeforeEach(async () => {
        await leverUp(
          setToken,
          perpLeverageModule,
          perpSetup,
          owner,
          vETH.address,
          2,
          ether(.02),
          true
        );

        await leverUp(
          setToken,
          perpLeverageModule,
          perpSetup,
          owner,
          vBTC.address,
          1,
          ether(.02),
          true
        );
      });

      describe("when redeeming a single set", async () => {
        it("sells expected amount of vETH, vBTC", async () => {
          const totalSupply = await setToken.totalSupply();
          const initialPositionInfo = await perpLeverageModule.getPositionNotionalInfo(subjectSetToken);

          const initialVETHBalance = initialPositionInfo[0].baseBalance;
          const initialVBTCBalance = initialPositionInfo[1].baseBalance;

          await subject();

          const finalPositionInfo = await perpLeverageModule.getPositionNotionalInfo(subjectSetToken);
          const finalVETHBalance = finalPositionInfo[0].baseBalance;
          const finalVBTCBalance = finalPositionInfo[1].baseBalance;

          const vETHPositionUnit = preciseDiv(initialVETHBalance, totalSupply);
          const vBTCPositionUnit = preciseDiv(initialVBTCBalance, totalSupply);

          const vETHSoldNotional = preciseMul(vETHPositionUnit, subjectSetQuantity);
          const vBTCSoldNotional = preciseMul(vBTCPositionUnit, subjectSetQuantity);

          const expectedVETHBalance = initialVETHBalance.sub(vETHSoldNotional);
          const expectedVBTCBalance = initialVBTCBalance.sub(vBTCSoldNotional);

          expect(finalVETHBalance).eq(expectedVETHBalance);
          expect(finalVBTCBalance).eq(expectedVBTCBalance);
        });

        it("should set the expected USDC externalPositionUnit", async () => {
          const usdcTransferOutQuantity = await calculateUSDCTransferOutPreciseUnits(
            setToken,
            subjectSetQuantity,
            perpLeverageModule,
            perpSetup
          );

          await subject();

          const expectedExternalPositionUnit = toUSDCDecimals(
            preciseDiv(usdcTransferOutQuantity, subjectSetQuantity)
          );

          const externalPositionUnit = await setToken.getExternalPositionRealUnit(
            usdc.address,
            perpLeverageModule.address
          );

          expect(externalPositionUnit).to.be.eq(expectedExternalPositionUnit);
        });
      });

      describe("when redeeming multiple sets", async () => {
        it("buys expected amount of vETH, vBTC", async () => {
          const totalSupply = await setToken.totalSupply();
          const initialPositionInfo = await perpLeverageModule.getPositionNotionalInfo(subjectSetToken);

          const initialVETHBalance = initialPositionInfo[0].baseBalance;
          const initialVBTCBalance = initialPositionInfo[1].baseBalance;

          await subject();

          const finalPositionInfo = await perpLeverageModule.getPositionNotionalInfo(subjectSetToken);
          const finalVETHBalance = finalPositionInfo[0].baseBalance;
          const finalVBTCBalance = finalPositionInfo[1].baseBalance;

          const vETHPositionUnit = preciseDiv(initialVETHBalance, totalSupply);
          const vBTCPositionUnit = preciseDiv(initialVBTCBalance, totalSupply);

          const vETHBoughtNotional = preciseMul(vETHPositionUnit, subjectSetQuantity);
          const vBTCBoughtNotional = preciseMul(vBTCPositionUnit, subjectSetQuantity);

          const expectedVETHBalance = initialVETHBalance.sub(vETHBoughtNotional);
          const expectedVBTCBalance = initialVBTCBalance.sub(vBTCBoughtNotional);

          expect(finalVETHBalance).eq(expectedVETHBalance);
          expect(finalVBTCBalance).eq(expectedVBTCBalance);
        });

        it("should set the expected USDC externalPositionUnit", async () => {
          const usdcTransferOutQuantity = await calculateUSDCTransferOutPreciseUnits(
            setToken,
            subjectSetQuantity,
            perpLeverageModule,
            perpSetup
          );

          await subject();

          const expectedExternalPositionUnit = toUSDCDecimals(
            preciseDiv(usdcTransferOutQuantity, subjectSetQuantity)
          );

          const externalPositionUnit = await setToken.getExternalPositionRealUnit(
            usdc.address,
            perpLeverageModule.address
          );

          expect(externalPositionUnit).to.be.eq(expectedExternalPositionUnit);
        });
      });

      describe("when the Set owes funding", async () => {
        beforeEach(async() => {
          // set funding rate to non-zero value
          await perpSetup.clearingHouseConfig.setMaxFundingRate(BigNumber.from(0.1e6));       // 10% in decimal 6
        });

        it("should socialize the funding payment among existing set holders", async () => {
          // Move oracle price down and wait one day
          await perpSetup.setBaseTokenOraclePrice(vETH, usdcUnits(9.8));
          await perpSetup.setBaseTokenOraclePrice(vBTC, usdcUnits(19.9));

          await increaseTimeAsync(ONE_DAY_IN_SECONDS);
          const vEthBalance = await perpSetup.accountBalance.getBase(setToken.address, vETH.address);
          const vBtcBalance = await perpSetup.accountBalance.getBase(setToken.address, vBTC.address);
          const pendingFunding = (await perpLeverageModule.getAccountInfo(subjectSetToken)).pendingFundingPayments;
          const usdcTransferOutQuantity = await calculateUSDCTransferOutPreciseUnits(
            setToken,
            subjectSetQuantity,
            perpLeverageModule,
            perpSetup,
            false         // don't include funding
          );

          await subject();

          const vEthUsdcAmountDelta = await getUSDCDeltaDueToFundingGrowth(setToken, subjectSetQuantity, vETH.address, vEthBalance, perpSetup);
          const vBtcUsdcAmountDelta = await getUSDCDeltaDueToFundingGrowth(setToken, subjectSetQuantity, vBTC.address, vBtcBalance, perpSetup);
          const expectedExternalPositionUnit = toUSDCDecimals(
            preciseDiv(usdcTransferOutQuantity.add(vEthUsdcAmountDelta).add(vBtcUsdcAmountDelta), subjectSetQuantity)
          );

          const externalPositionUnit = await setToken.getExternalPositionRealUnit(
            usdc.address,
            perpLeverageModule.address
          );

          expect(pendingFunding).lt(0);
          expect(externalPositionUnit).to.be.eq(expectedExternalPositionUnit);
        });
      });

      describe("when the Set is owed funding", async () => {
        beforeEach(async() => {
          // set funding rate to non-zero value
          await perpSetup.clearingHouseConfig.setMaxFundingRate(BigNumber.from(0.1e6));       // 10% in decimal 6
        });

        it("should socialize the funding payment among existing set holders", async () => {
          // Move oracle price up and wait one day
          await perpSetup.setBaseTokenOraclePrice(vETH, usdcUnits(10.3));
          await perpSetup.setBaseTokenOraclePrice(vBTC, usdcUnits(20.2));

          await increaseTimeAsync(ONE_DAY_IN_SECONDS);

          const vEthBalance = await perpSetup.accountBalance.getBase(setToken.address, vETH.address);
          const vBtcBalance = await perpSetup.accountBalance.getBase(setToken.address, vBTC.address);
          const pendingFunding = (await perpLeverageModule.getAccountInfo(subjectSetToken)).pendingFundingPayments;
          const usdcTransferOutQuantity = await calculateUSDCTransferOutPreciseUnits(
            setToken,
            subjectSetQuantity,
            perpLeverageModule,
            perpSetup,
            false         // don't include funding
          );

          await subject();

          const vEthUsdcAmountDelta = await getUSDCDeltaDueToFundingGrowth(setToken, subjectSetQuantity, vETH.address, vEthBalance, perpSetup);
          const vBtcUsdcAmountDelta = await getUSDCDeltaDueToFundingGrowth(setToken, subjectSetQuantity, vBTC.address, vBtcBalance, perpSetup);
          const expectedExternalPositionUnit = toUSDCDecimals(
            preciseDiv(usdcTransferOutQuantity.add(vEthUsdcAmountDelta).add(vBtcUsdcAmountDelta), subjectSetQuantity)
          );

          const externalPositionUnit = await setToken.getExternalPositionRealUnit(
            usdc.address,
            perpLeverageModule.address
          );

          expect(pendingFunding).gt(ether(1));
          expect(externalPositionUnit).to.be.eq(expectedExternalPositionUnit);
        });
      });

      describe("when there is positive owedRealizedPnl", async () => {
        beforeEach(async () => {
          // Move price up by maker buying 2k USDC of vETH
          await perpSetup.clearingHouse.connect(maker.wallet).openPosition({
            baseToken: vETH.address,
            isBaseToQuote: false,     // long
            isExactInput: true,       // `amount` is USDC
            amount: ether(2000),
            oppositeAmountBound: ZERO,
            deadline: MAX_UINT_256,
            sqrtPriceLimitX96: ZERO,
            referralCode: ZERO_BYTES
          });

          await perpSetup.clearingHouse.connect(maker.wallet).openPosition({
            baseToken: vBTC.address,
            isBaseToQuote: false,     // long
            isExactInput: true,       // `amount` is USDC
            amount: ether(2000),
            oppositeAmountBound: ZERO,
            deadline: MAX_UINT_256,
            sqrtPriceLimitX96: ZERO,
            referralCode: ZERO_BYTES
          });

          // Sell a little, booking profit to owedRealizedPnl
          await perpLeverageModule.connect(owner.wallet).trade(
            subjectSetToken,
            vETH.address,
            ether(-.4),
            ether(4)
          );

          await perpLeverageModule.connect(owner.wallet).trade(
            subjectSetToken,
            vBTC.address,
            ether(-.4),
            ether(4)
          );
        });

        it("should set the expected USDC externalPositionUnit", async () => {
          const owedRealizedPnl = (await perpLeverageModule.getAccountInfo(subjectSetToken)).owedRealizedPnl;

          const usdcTransferOutQuantity = await calculateUSDCTransferOut(
            setToken,
            subjectSetQuantity,
            perpLeverageModule,
            perpSetup
          );

          const expectedExternalPositionUnit = preciseDiv(
            usdcTransferOutQuantity,
            subjectSetQuantity
          );

          await subject();

          const externalPositionUnit = await setToken.getExternalPositionRealUnit(
            usdc.address,
            perpLeverageModule.address
          );

          expect(owedRealizedPnl).gt(0);
          expect(externalPositionUnit).to.be.eq(expectedExternalPositionUnit);
        });
      });
    });

    describe("when short", async () => {
      let baseToken: Address;

      // Set up as 2X Short, allow 2% slippage
      cacheBeforeEach(async () => {
        baseToken = vETH.address;
        await leverUp(
          setToken,
          perpLeverageModule,
          perpSetup,
          owner,
          baseToken,
          2,
          ether(.02),
          false
        );
      });

      describe("when redeeming a single set", async () => {
        it("buys expected amount of vBase", async () => {
          const totalSupply = await setToken.totalSupply();

          const initialBaseBalance = (await perpLeverageModule.getPositionNotionalInfo(subjectSetToken))[0].baseBalance;
          await subject();
          const finalBaseBalance = (await perpLeverageModule.getPositionNotionalInfo(subjectSetToken))[0].baseBalance;

          const basePositionUnit = preciseDiv(initialBaseBalance, totalSupply);
          const baseTokenBoughtNotional = preciseMul(basePositionUnit, subjectSetQuantity);
          const expectedBaseBalance = initialBaseBalance.sub(baseTokenBoughtNotional);

          expect(finalBaseBalance).eq(expectedBaseBalance);
        });

        it("should set the expected USDC externalPositionUnit", async () => {
          const usdcTransferOutQuantity = await calculateUSDCTransferOutPreciseUnits(
            setToken,
            subjectSetQuantity,
            perpLeverageModule,
            perpSetup
          );

          await subject();

          const expectedExternalPositionUnit = toUSDCDecimals(
            preciseDiv(usdcTransferOutQuantity, subjectSetQuantity)
          );

          const externalPositionUnit = await setToken.getExternalPositionRealUnit(
            usdc.address,
            perpLeverageModule.address
          );

          expect(externalPositionUnit).to.be.eq(expectedExternalPositionUnit);
        });
      });

      describe("when there is positive owedRealizedPnl", async () => {
        beforeEach(async () => {
          // Move price down by maker buying 1k USDC of vETH
          await perpSetup.clearingHouse.connect(maker.wallet).openPosition({
            baseToken: vETH.address,
            isBaseToQuote: true,       // short
            isExactInput: false,       // `amount` is USDC
            amount: ether(10000),
            oppositeAmountBound: ZERO,
            deadline: MAX_UINT_256,
            sqrtPriceLimitX96: ZERO,
            referralCode: ZERO_BYTES
          });

          // Buy a little, booking profit to owedRealizedPnl
          await perpLeverageModule.connect(owner.wallet).trade(
            subjectSetToken,
            vETH.address,
            ether(.1),
            ether(2)
          );
        });

        it("should set the expected USDC externalPositionUnit", async () => {
          // owedRealizedPnl = 1_643_798_014_140_064_947
          const owedRealizedPnl = (await perpLeverageModule.getAccountInfo(subjectSetToken)).owedRealizedPnl;

          const usdcTransferOutQuantity = await calculateUSDCTransferOut(
            setToken,
            subjectSetQuantity,
            perpLeverageModule,
            perpSetup
          );

          const expectedExternalPositionUnit = preciseDiv(
            usdcTransferOutQuantity,
            subjectSetQuantity
          );

          await subject();

          const externalPositionUnit = await setToken.getExternalPositionRealUnit(
            usdc.address,
            perpLeverageModule.address
          );

          expect(owedRealizedPnl).gt(0);
          expect(externalPositionUnit).to.be.eq(expectedExternalPositionUnit);
        });
      });

      describe("when there is negative owedRealizedPnl", async () => {
        beforeEach(async () => {
          // Move price up by maker buy 1k USDC of vETH
          await perpSetup.clearingHouse.connect(maker.wallet).openPosition({
            baseToken: vETH.address,
            isBaseToQuote: false,       // long
            isExactInput: true,         // `amount` is USDC
            amount: ether(10000),
            oppositeAmountBound: ZERO,
            deadline: MAX_UINT_256,
            sqrtPriceLimitX96: ZERO,
            referralCode: ZERO_BYTES
          });

          // Buy a little, booking loss to owedRealizedPnl
          await perpLeverageModule.connect(owner.wallet).trade(
            subjectSetToken,
            vETH.address,
            ether(.1),
            ether(2)
          );
        });

        it("should set the expected USDC externalPositionUnit", async () => {
          const owedRealizedPnl = (await perpLeverageModule.getAccountInfo(subjectSetToken)).owedRealizedPnl;

          const usdcTransferOutQuantity = await calculateUSDCTransferOut(
            setToken,
            subjectSetQuantity,
            perpLeverageModule,
            perpSetup
          );

          const expectedExternalPositionUnit = preciseDiv(
            usdcTransferOutQuantity,
            subjectSetQuantity
          );

          await subject();

          const externalPositionUnit = await setToken.getExternalPositionRealUnit(
            usdc.address,
            perpLeverageModule.address
          );

          expect(owedRealizedPnl).lt(0);
          expect(externalPositionUnit).to.be.eq(expectedExternalPositionUnit);
        });
      });

      describe("when the Set owes funding", async () => {
        beforeEach(async() => {
          // set funding rate to non-zero value
          await perpSetup.clearingHouseConfig.setMaxFundingRate(BigNumber.from(0.1e6));       // 10% in decimal 6
        });

        it("should socialize the funding payment among existing set holders", async () => {
          // Move oracle price up and wait one day
          await perpSetup.setBaseTokenOraclePrice(vETH, usdcUnits(10.5));
          await increaseTimeAsync(ONE_DAY_IN_SECONDS);

          const vEthBalance = await perpSetup.accountBalance.getBase(setToken.address, vETH.address);
          const pendingFunding = (await perpLeverageModule.getAccountInfo(subjectSetToken)).pendingFundingPayments;
          const usdcTransferOutQuantity = await calculateUSDCTransferOutPreciseUnits(
            setToken,
            subjectSetQuantity,
            perpLeverageModule,
            perpSetup,
            false         // don't include funding
          );

          await subject();

          const vEthUsdcAmountDelta = await getUSDCDeltaDueToFundingGrowth(setToken, subjectSetQuantity, vETH.address, vEthBalance, perpSetup);
          const expectedExternalPositionUnit = toUSDCDecimals(
            preciseDiv(usdcTransferOutQuantity.add(vEthUsdcAmountDelta), subjectSetQuantity)
          );

          const externalPositionUnit = await setToken.getExternalPositionRealUnit(
            usdc.address,
            perpLeverageModule.address
          );

          expect(pendingFunding).lt(0);
          expect(externalPositionUnit).to.be.eq(expectedExternalPositionUnit);
        });
      });

      describe("when the Set is owed funding", async () => {
        beforeEach(async() => {
          // set funding rate to non-zero value
          await perpSetup.clearingHouseConfig.setMaxFundingRate(BigNumber.from(0.1e6));       // 10% in decimal 6
        });

        it("should socialize the funding payment among existing set holders", async () => {
          // Move oracle price down and wait one day
          await perpSetup.setBaseTokenOraclePrice(vETH, usdcUnits(5));
          await increaseTimeAsync(ONE_DAY_IN_SECONDS);

          const vEthBalance = await perpSetup.accountBalance.getBase(setToken.address, vETH.address);
          const pendingFunding = (await perpLeverageModule.getAccountInfo(subjectSetToken)).pendingFundingPayments;
          const usdcTransferOutQuantity = await calculateUSDCTransferOutPreciseUnits(
            setToken,
            subjectSetQuantity,
            perpLeverageModule,
            perpSetup,
            false         // don't include funding
          );

          await subject();

          const vEthUsdcAmountDelta = await getUSDCDeltaDueToFundingGrowth(setToken, subjectSetQuantity, vETH.address, vEthBalance, perpSetup);
          const expectedExternalPositionUnit = toUSDCDecimals(
            preciseDiv(usdcTransferOutQuantity.add(vEthUsdcAmountDelta), subjectSetQuantity)
          );

          const externalPositionUnit = await setToken.getExternalPositionRealUnit(
            usdc.address,
            perpLeverageModule.address
          );

          // We expect pending funding to be greater than -1 USDC and discount applied
          expect(pendingFunding).gt(0);
          expect(externalPositionUnit).to.be.eq(expectedExternalPositionUnit);
        });
      });

      describe("when the market price moves down and leverage drops", async () => {
        it("test assumptions and preconditions should be correct", async () => {
          let positionInfo = (await perpLeverageModule.getPositionNotionalInfo(subjectSetToken))[0];
          let collateralBalance = (await perpLeverageModule.getAccountInfo(subjectSetToken)).collateralBalance;

          const initialLeverage = await perpSetup.getCurrentLeverage(subjectSetToken, positionInfo, collateralBalance);
          const initialSpotPrice = await perpSetup.getSpotPrice(vETH.address);
          const initialUSDCTransferOutQuantity = await calculateUSDCTransferOut(
            setToken,
            subjectSetQuantity,
            perpLeverageModule,
            perpSetup
          );

          await perpSetup.clearingHouse.connect(maker.wallet).openPosition({
            baseToken: vETH.address,
            isBaseToQuote: true,       // short
            isExactInput: false,       // `amount` is USDC
            amount: ether(10000),      // move price down by selling 10k USDC of vETH
            oppositeAmountBound: ZERO,
            deadline: MAX_UINT_256,
            sqrtPriceLimitX96: ZERO,
            referralCode: ZERO_BYTES
          });

          positionInfo = (await perpLeverageModule.getPositionNotionalInfo(subjectSetToken))[0];
          collateralBalance = (await perpLeverageModule.getAccountInfo(subjectSetToken)).collateralBalance;

          const finalLeverage = await perpSetup.getCurrentLeverage(subjectSetToken, positionInfo, collateralBalance);
          const finalSpotPrice = await perpSetup.getSpotPrice(vETH.address);
          const finalUSDCTransferOutQuantity = await calculateUSDCTransferOut(
            setToken,
            subjectSetQuantity,
            perpLeverageModule,
            perpSetup
          );

          expect(initialSpotPrice).gt(finalSpotPrice);
          expect(initialUSDCTransferOutQuantity).lt(finalUSDCTransferOutQuantity);
          expect(initialLeverage).gt(ZERO);
          expect(finalLeverage).gt(ZERO);
          expect(initialLeverage).gt(finalLeverage);
        });

        it("buys expected amount of vBase", async () => {
          await perpSetup.clearingHouse.connect(maker.wallet).openPosition({
            baseToken: vETH.address,
            isBaseToQuote: true,       // short
            isExactInput: false,       // `amount` is USDC
            amount: ether(10000),      // move price down by selling 10k USDC of vETH
            oppositeAmountBound: ZERO,
            deadline: MAX_UINT_256,
            sqrtPriceLimitX96: ZERO,
            referralCode: ZERO_BYTES
          });

          const initialBaseBalance = (await perpLeverageModule.getPositionNotionalInfo(subjectSetToken))[0].baseBalance;
          await subject();
          const finalBaseBalance = (await perpLeverageModule.getPositionNotionalInfo(subjectSetToken))[0].baseBalance;

          const basePositionUnit = preciseDiv(initialBaseBalance, await setToken.totalSupply());
          const baseTokenBoughtNotional = preciseMul(basePositionUnit, subjectSetQuantity);
          const expectedBaseBalance = initialBaseBalance.sub(baseTokenBoughtNotional);

          expect(finalBaseBalance).eq(expectedBaseBalance);
        });

        it("should set the expected USDC externalPositionUnit", async () => {
          await perpSetup.clearingHouse.connect(maker.wallet).openPosition({
            baseToken: vETH.address,
            isBaseToQuote: true,       // short
            isExactInput: false,       // `amount` is USDC
            amount: ether(10000),      // move price down by selling 10k USDC of vETH
            oppositeAmountBound: ZERO,
            deadline: MAX_UINT_256,
            sqrtPriceLimitX96: ZERO,
            referralCode: ZERO_BYTES
          });

          const usdcTransferOutQuantity = await calculateUSDCTransferOut(
            setToken,
            subjectSetQuantity,
            perpLeverageModule,
            perpSetup
          );
          const expectedExternalPositionUnit = preciseDiv(usdcTransferOutQuantity, subjectSetQuantity);

          await subject();

          const externalPositionUnit = await setToken.getExternalPositionRealUnit(
            usdc.address,
            perpLeverageModule.address
          );

          expect(externalPositionUnit).to.be.eq(expectedExternalPositionUnit);
        });
      });

      describe("when redeeming multiple sets", async () => {
        it("should set the expected USDC externalPositionUnit", async () => {
          const usdcTransferOutQuantity = await calculateUSDCTransferOutPreciseUnits(
            setToken,
            subjectSetQuantity,
            perpLeverageModule,
            perpSetup
          );

          await subject();

          const expectedExternalPositionUnit = toUSDCDecimals(
            preciseDiv(usdcTransferOutQuantity, subjectSetQuantity)
          );

          const externalPositionUnit = await setToken.getExternalPositionRealUnit(
            usdc.address,
            perpLeverageModule.address
          );

          expect(externalPositionUnit).to.be.eq(expectedExternalPositionUnit);
        });
      });
    });

    describe("when long one asset and short another", async () => {
      // Long 2 ETH @ 10 USDC, Short 1 BTC @ 20 USDC
      cacheBeforeEach(async () => {
        await leverUp(setToken, perpLeverageModule, perpSetup, owner, vETH.address, 2, ether(.02), true);
        await leverUp(setToken, perpLeverageModule, perpSetup, owner, vBTC.address, 2, ether(.02), false);
      });

      describe("when redeeming a single set", async () => {
        beforeEach(async () => {
          const vETHSpotPrice = await perpSetup.getSpotPrice(vETH.address);
          await perpSetup.setBaseTokenOraclePrice(vETH, vETHSpotPrice.div(10 ** 12));
        });

        it("sells expected amount of vETH, buys expected amount of vBTC", async () => {
          const totalSupply = await setToken.totalSupply();
          const initialPositionInfo = await perpLeverageModule.getPositionNotionalInfo(subjectSetToken);

          const initialVETHBalance = initialPositionInfo[0].baseBalance;
          const initialVBTCBalance = initialPositionInfo[1].baseBalance;

          await subject();

          const finalPositionInfo = await perpLeverageModule.getPositionNotionalInfo(subjectSetToken);
          const finalVETHBalance = finalPositionInfo[0].baseBalance;
          const finalVBTCBalance = finalPositionInfo[1].baseBalance;

          const vETHPositionUnit = preciseDiv(initialVETHBalance, totalSupply);
          const vBTCPositionUnit = preciseDiv(initialVBTCBalance, totalSupply);

          const vETHBoughtNotional = preciseMul(vETHPositionUnit, subjectSetQuantity);
          const vBTCBoughtNotional = preciseMul(vBTCPositionUnit, subjectSetQuantity);

          const expectedVETHBalance = initialVETHBalance.sub(vETHBoughtNotional);
          const expectedVBTCBalance = initialVBTCBalance.sub(vBTCBoughtNotional);

          expect(finalVETHBalance).eq(expectedVETHBalance);
          expect(finalVBTCBalance).eq(expectedVBTCBalance);
        });

        it("should set the expected USDC externalPositionUnit", async () => {
          const usdcTransferOutQuantity = await calculateUSDCTransferOutPreciseUnits(
            setToken,
            subjectSetQuantity,
            perpLeverageModule,
            perpSetup
          );

          await subject();

          const expectedExternalPositionUnit = toUSDCDecimals(
            preciseDiv(usdcTransferOutQuantity, subjectSetQuantity)
          );

          const externalPositionUnit = await setToken.getExternalPositionRealUnit(
            usdc.address,
            perpLeverageModule.address
          );
          expect(externalPositionUnit).to.be.eq(expectedExternalPositionUnit);
        });

        // Long profit case
        describe("when the long asset market price moves up and leverage drops", async () => {
          it("test assumptions and preconditions should be correct", async () => {
            let positionInfo = (await perpLeverageModule.getPositionNotionalInfo(subjectSetToken))[0];
            let collateralBalance = (await perpLeverageModule.getAccountInfo(subjectSetToken)).collateralBalance;

            const initialLeverage = await perpSetup.getCurrentLeverage(subjectSetToken, positionInfo, collateralBalance);
            const initialSpotPrice = await perpSetup.getSpotPrice(vETH.address);
            const initialUSDCTransferOutQuantity = await calculateUSDCTransferOut(
              setToken,
              subjectSetQuantity,
              perpLeverageModule,
              perpSetup
            );

            // Price increases from ~10 USDC to 12_086_807_119_488_051_322 (~20%)
            await perpSetup.clearingHouse.connect(maker.wallet).openPosition({
              baseToken: vETH.address,
              isBaseToQuote: false,      // long
              isExactInput: true,        // `amount` is USDC
              amount: ether(10000),      // move price up by buying 10k USDC of vETH
              oppositeAmountBound: ZERO,
              deadline: MAX_UINT_256,
              sqrtPriceLimitX96: ZERO,
              referralCode: ZERO_BYTES
            });

            positionInfo = (await perpLeverageModule.getPositionNotionalInfo(subjectSetToken))[0];
            collateralBalance = (await perpLeverageModule.getAccountInfo(subjectSetToken)).collateralBalance;

            const finalLeverage = await perpSetup.getCurrentLeverage(subjectSetToken, positionInfo, collateralBalance);
            const finalSpotPrice = await perpSetup.getSpotPrice(vETH.address);
            const finalUSDCTransferOutQuantity = await calculateUSDCTransferOut(
              setToken,
              subjectSetQuantity,
              perpLeverageModule,
              perpSetup
            );


            // Leverage should drop as asset value rises
            // initialLeverage = 2041219945269276819
            // finalLeverage   = 1731198978421953524

            // Set should be worth 2X more as price increases in short asset
            // Price rose ~20%, so set worth ~40% more
            // initialUSDCTransferInQuantity  = 9201861
            // finalUSDCTransferInQuantity    = 13316592
            expect(initialSpotPrice).lt(finalSpotPrice);
            expect(initialUSDCTransferOutQuantity).lt(finalUSDCTransferOutQuantity);
            expect(initialLeverage).gt(ZERO);
            expect(finalLeverage).gt(ZERO);
            expect(initialLeverage).gt(finalLeverage);
          });

          it("sells expected amount of vBase", async () => {
            await perpSetup.clearingHouse.connect(maker.wallet).openPosition({
              baseToken: vETH.address,
              isBaseToQuote: true,       // long
              isExactInput: false,       // `amount` is USDC
              amount: ether(10000),      // move price up by buying 10k USDC of vETH
              oppositeAmountBound: ZERO,
              deadline: MAX_UINT_256,
              sqrtPriceLimitX96: ZERO,
              referralCode: ZERO_BYTES
            });

            const initialBaseBalance = (await perpLeverageModule.getPositionNotionalInfo(subjectSetToken))[0].baseBalance;
            await subject();
            const finalBaseBalance = (await perpLeverageModule.getPositionNotionalInfo(subjectSetToken))[0].baseBalance;

            const basePositionUnit = preciseDiv(initialBaseBalance, await setToken.totalSupply());
            const baseTokenSoldNotional = preciseMul(basePositionUnit, subjectSetQuantity);
            const expectedBaseBalance = initialBaseBalance.sub(baseTokenSoldNotional);

            expect(finalBaseBalance).eq(expectedBaseBalance);
          });

          it("should set the expected USDC externalPositionUnit", async () => {
            await perpSetup.clearingHouse.connect(maker.wallet).openPosition({
              baseToken: vETH.address,
              isBaseToQuote: true,       // long
              isExactInput: false,       // `amount` is USDC
              amount: ether(10000),      // move price up by buying 10k USDC of vETH
              oppositeAmountBound: ZERO,
              deadline: MAX_UINT_256,
              sqrtPriceLimitX96: ZERO,
              referralCode: ZERO_BYTES
            });

            const usdcTransferOutQuantity = await calculateUSDCTransferOutPreciseUnits(
              setToken,
              subjectSetQuantity,
              perpLeverageModule,
              perpSetup
            );

            await subject();

            const expectedExternalPositionUnit = toUSDCDecimals(
              preciseDiv(usdcTransferOutQuantity, subjectSetQuantity)
            );

            const externalPositionUnit = await setToken.getExternalPositionRealUnit(
              usdc.address,
              perpLeverageModule.address
            );

            expect(externalPositionUnit).to.be.eq(expectedExternalPositionUnit);
          });
        });

        // Short profit case
        describe("when the short asset market price moves down and leverage drops", async () => {
          it("test assumptions and preconditions should be correct", async () => {
            let positionInfo = (await perpLeverageModule.getPositionNotionalInfo(subjectSetToken))[1];
            let collateralBalance = (await perpLeverageModule.getAccountInfo(subjectSetToken)).collateralBalance;

            const initialLeverage = await perpSetup.getCurrentLeverage(subjectSetToken, positionInfo, collateralBalance);
            const initialSpotPrice = await perpSetup.getSpotPrice(vBTC.address);
            const initialUSDCTransferOutQuantity = await calculateUSDCTransferOut(
              setToken,
              subjectSetQuantity,
              perpLeverageModule,
              perpSetup
            );

            // Price decreases from ~20 USDC to  16_156_467_088_301_771_700 (~20%)
            await perpSetup.clearingHouse.connect(maker.wallet).openPosition({
              baseToken: vBTC.address,
              isBaseToQuote: true,        // short
              isExactInput: false,        // `amount` is USDC
              amount: ether(20000),       // move price down by selling 20k USDC of vBTC
              oppositeAmountBound: ZERO,
              deadline: MAX_UINT_256,
              sqrtPriceLimitX96: ZERO,
              referralCode: ZERO_BYTES
            });


            positionInfo = (await perpLeverageModule.getPositionNotionalInfo(subjectSetToken))[1];
            collateralBalance = (await perpLeverageModule.getAccountInfo(subjectSetToken)).collateralBalance;

            const finalLeverage = await perpSetup.getCurrentLeverage(subjectSetToken, positionInfo, collateralBalance);
            const finalSpotPrice = await perpSetup.getSpotPrice(vBTC.address);
            const finalUSDCTransferOutQuantity = await calculateUSDCTransferOut(
              setToken,
              subjectSetQuantity,
              perpLeverageModule,
              perpSetup
            );

            // Leverage should drop as asset value rises
            // initialLeverage  = 2039159946037302515
            // finalLeverage    = 1184528742574169001

            // Set should be worth 2X more as price decreases in short asset
            // Price dropped ~20%, so set worth ~40% more
            // initialUSDCTransferOutQuantity = 9201861
            // finalUSDCTransferOutQuantity   = 13076691
            expect(initialSpotPrice).gt(finalSpotPrice);
            expect(initialUSDCTransferOutQuantity).lt(finalUSDCTransferOutQuantity);
            expect(initialLeverage).gt(ZERO);
            expect(finalLeverage).gt(ZERO);
            expect(initialLeverage).gt(finalLeverage);
          });

          it("buys expected amount of vBase", async () => {
            await perpSetup.clearingHouse.connect(maker.wallet).openPosition({
              baseToken: vBTC.address,
              isBaseToQuote: true,        // short
              isExactInput: false,        // `amount` is USDC
              amount: ether(20000),       // move price down by selling 20k USDC of vBTC
              oppositeAmountBound: ZERO,
              deadline: MAX_UINT_256,
              sqrtPriceLimitX96: ZERO,
              referralCode: ZERO_BYTES
            });

            const initialBaseBalance = (await perpLeverageModule.getPositionNotionalInfo(subjectSetToken))[0].baseBalance;
            await subject();
            const finalBaseBalance = (await perpLeverageModule.getPositionNotionalInfo(subjectSetToken))[0].baseBalance;

            const basePositionUnit = preciseDiv(initialBaseBalance, await setToken.totalSupply());
            const baseTokenBoughtNotional = preciseMul(basePositionUnit, subjectSetQuantity);
            const expectedBaseBalance = initialBaseBalance.sub(baseTokenBoughtNotional);

            expect(finalBaseBalance).eq(expectedBaseBalance);
          });

          it("should set the expected USDC externalPositionUnit", async () => {
            await perpSetup.clearingHouse.connect(maker.wallet).openPosition({
              baseToken: vBTC.address,
              isBaseToQuote: true,        // short
              isExactInput: false,        // `amount` is USDC
              amount: ether(2000),       // move price down by selling 2k USDC of vBTC
              oppositeAmountBound: ZERO,
              deadline: MAX_UINT_256,
              sqrtPriceLimitX96: ZERO,
              referralCode: ZERO_BYTES
            });

            const usdcTransferOutQuantity = await calculateUSDCTransferOutPreciseUnits(
              setToken,
              subjectSetQuantity,
              perpLeverageModule,
              perpSetup
            );

            await subject();

            const expectedExternalPositionUnit = toUSDCDecimals(
              preciseDiv(usdcTransferOutQuantity, subjectSetQuantity)
            );

            const externalPositionUnit = await setToken.getExternalPositionRealUnit(
              usdc.address,
              perpLeverageModule.address
            );

            expect(externalPositionUnit).to.be.eq(expectedExternalPositionUnit);
          });
        });
      });

      describe("when there is positive owedRealizedPnl", async () => {
        beforeEach(async () => {
          // Move price down by maker selling 2k USDC of vETH
          await perpSetup.clearingHouse.connect(maker.wallet).openPosition({
            baseToken: vETH.address,
            isBaseToQuote: false,     // long
            isExactInput: true,     // `amount` is USDC
            amount: ether(2000),
            oppositeAmountBound: ZERO,
            deadline: MAX_UINT_256,
            sqrtPriceLimitX96: ZERO,
            referralCode: ZERO_BYTES
          });

          // Sell a little, booking profit to owedRealizedPnl
          await perpLeverageModule.connect(owner.wallet).trade(
            subjectSetToken,
            vETH.address,
            ether(.1).mul(-1),
            ZERO
          );

          const vETHSpotPrice = await perpSetup.getSpotPrice(vETH.address);
          await perpSetup.setBaseTokenOraclePrice(vETH, vETHSpotPrice.div(10 ** 12));
        });

        it("should set the expected USDC externalPositionUnit", async () => {
          const owedRealizedPnl = (await perpLeverageModule.getAccountInfo(subjectSetToken)).owedRealizedPnl;

          const usdcTransferOutQuantity = await calculateUSDCTransferOut(
            setToken,
            subjectSetQuantity,
            perpLeverageModule,
            perpSetup
          );

          const expectedExternalPositionUnit = preciseDiv(
            usdcTransferOutQuantity,
            subjectSetQuantity
          );

          await subject();

          const externalPositionUnit = await setToken.getExternalPositionRealUnit(
            usdc.address,
            perpLeverageModule.address
          );

          expect(owedRealizedPnl).gt(0);
          expect(externalPositionUnit).to.be.eq(expectedExternalPositionUnit);
        });
      });

      describe("when there is negative owedRealizedPnl", async () => {
        beforeEach(async () => {
          // Move price down by maker selling 1k USDC of vETH
          await perpSetup.clearingHouse.connect(maker.wallet).openPosition({
            baseToken: vETH.address,
            isBaseToQuote: true,     // short
            isExactInput: false,     // `amount` is USDC
            amount: ether(1000),
            oppositeAmountBound: ZERO,
            deadline: MAX_UINT_256,
            sqrtPriceLimitX96: ZERO,
            referralCode: ZERO_BYTES
          });

          // Sell a little, booking profit to owedRealizedPnl
          await perpLeverageModule.connect(owner.wallet).trade(
            subjectSetToken,
            vETH.address,
            ether(.1).mul(-1),
            ZERO
          );

          const vETHSpotPrice = await perpSetup.getSpotPrice(vETH.address);
          await perpSetup.setBaseTokenOraclePrice(vETH, vETHSpotPrice.div(10 ** 12));
        });

        it("should set the expected USDC externalPositionUnit", async () => {
          const owedRealizedPnl = (await perpLeverageModule.getAccountInfo(subjectSetToken)).owedRealizedPnl;

          const usdcTransferOutQuantity = await calculateUSDCTransferOut(
            setToken,
            subjectSetQuantity,
            perpLeverageModule,
            perpSetup
          );

          const expectedExternalPositionUnit = preciseDiv(
            usdcTransferOutQuantity,
            subjectSetQuantity
          );

          await subject();

          const externalPositionUnit = await setToken.getExternalPositionRealUnit(
            usdc.address,
            perpLeverageModule.address
          );

          expect(owedRealizedPnl).lt(0);
          expect(externalPositionUnit).to.be.eq(expectedExternalPositionUnit);
        });
      });

      describe("when the Set owes funding", async () => {
        beforeEach(async() => {
          // set funding rate to non-zero value
          await perpSetup.clearingHouseConfig.setMaxFundingRate(BigNumber.from(0.1e6));       // 10% in decimal 6
        });

        it("should socialize the funding payment among existing set holders", async () => {
          // Move oracle price up and wait one day
          await perpSetup.setBaseTokenOraclePrice(vETH, usdcUnits(9.7));
          await increaseTimeAsync(ONE_DAY_IN_SECONDS);

          const vEthBalance = await perpSetup.accountBalance.getBase(setToken.address, vETH.address);
          const vBtcBalance = await perpSetup.accountBalance.getBase(setToken.address, vBTC.address);
          const pendingFunding = (await perpLeverageModule.getAccountInfo(subjectSetToken)).pendingFundingPayments;
          const usdcTransferOutQuantity = await calculateUSDCTransferOutPreciseUnits(
            setToken,
            subjectSetQuantity,
            perpLeverageModule,
            perpSetup,
            false         // don't include funding
          );

          await subject();

          const vEthUsdcAmountDelta = await getUSDCDeltaDueToFundingGrowth(setToken, subjectSetQuantity, vETH.address, vEthBalance, perpSetup);
          const vBtcUsdcAmountDelta = await getUSDCDeltaDueToFundingGrowth(setToken, subjectSetQuantity, vBTC.address, vBtcBalance, perpSetup);
          const expectedExternalPositionUnit = toUSDCDecimals(
            preciseDiv(usdcTransferOutQuantity.add(vEthUsdcAmountDelta).add(vBtcUsdcAmountDelta), subjectSetQuantity)
          );

          const externalPositionUnit = await setToken.getExternalPositionRealUnit(
            usdc.address,
            perpLeverageModule.address
          );

          expect(pendingFunding).lt(0);
          expect(externalPositionUnit).to.be.eq(expectedExternalPositionUnit);
        });
      });

      describe("when the Set is owed funding", async () => {
        beforeEach(async() => {
          // set funding rate to non-zero value
          await perpSetup.clearingHouseConfig.setMaxFundingRate(BigNumber.from(0.1e6));       // 10% in decimal 6
        });

        it("should socialize the funding payment among existing set holders", async () => {
          // Move oracle price down and wait one day
          await perpSetup.setBaseTokenOraclePrice(vETH, usdcUnits(11));
          await increaseTimeAsync(ONE_DAY_IN_SECONDS);

          const vEthBalance = await perpSetup.accountBalance.getBase(setToken.address, vETH.address);
          const vBtcBalance = await perpSetup.accountBalance.getBase(setToken.address, vBTC.address);
          const pendingFunding = (await perpLeverageModule.getAccountInfo(subjectSetToken)).pendingFundingPayments;
          const usdcTransferOutQuantity = await calculateUSDCTransferOutPreciseUnits(
            setToken,
            subjectSetQuantity,
            perpLeverageModule,
            perpSetup,
            false         // don't include funding
          );

          await subject();

          const vEthUsdcAmountDelta = await getUSDCDeltaDueToFundingGrowth(setToken, subjectSetQuantity, vETH.address, vEthBalance, perpSetup);
          const vBtcUsdcAmountDelta = await getUSDCDeltaDueToFundingGrowth(setToken, subjectSetQuantity, vBTC.address, vBtcBalance, perpSetup);
          const expectedExternalPositionUnit = toUSDCDecimals(
            preciseDiv(usdcTransferOutQuantity.add(vEthUsdcAmountDelta).add(vBtcUsdcAmountDelta), subjectSetQuantity)
          );

          const externalPositionUnit = await setToken.getExternalPositionRealUnit(
            usdc.address,
            perpLeverageModule.address
          );

          expect(pendingFunding).gt(ZERO);
          expect(externalPositionUnit).to.be.eq(expectedExternalPositionUnit);
        });
      });
    });

    describe("when total supply is 0", async () => {
      let otherSetToken: SetToken;

      beforeEach(async () => {
        otherSetToken = await setup.createSetToken(
          [usdc.address],
          [usdcUnits(10)],
          [perpLeverageModule.address, debtIssuanceMock.address]
        );
        await debtIssuanceMock.initialize(otherSetToken.address);
        await perpLeverageModule.updateAllowedSetToken(otherSetToken.address, true);
        await perpLeverageModule.connect(owner.wallet).initialize(otherSetToken.address);

        // Initialize mock module
        await otherSetToken.addModule(mockModule.address);
        await otherSetToken.connect(mockModule.wallet).initializeModule();

        subjectSetToken = otherSetToken.address;
      });

      it("should not update the USDC externalPositionUnit", async () => {
        const initialExternalPositionUnit = await otherSetToken.getExternalPositionRealUnit(usdc.address, perpLeverageModule.address);
        await subject();
        const finalExternalPositionUnit = await otherSetToken.getExternalPositionRealUnit(usdc.address, perpLeverageModule.address);

        const expectedExternalPositionUnit = ZERO;
        expect(initialExternalPositionUnit).to.eq(finalExternalPositionUnit);
        expect(finalExternalPositionUnit).to.eq(expectedExternalPositionUnit);
      });
    });

    describe("when there is no external USDC position", () => {
      let otherSetToken: SetToken;

      beforeEach(async () => {
        otherSetToken = await setup.createSetToken(
          [usdc.address],
          [usdcUnits(10)],
          [perpLeverageModule.address, debtIssuanceMock.address, setup.issuanceModule.address]
        );

        await debtIssuanceMock.initialize(otherSetToken.address);
        await perpLeverageModule.updateAllowedSetToken(otherSetToken.address, true);

        await perpLeverageModule.connect(owner.wallet).initialize(otherSetToken.address);

        await otherSetToken.addModule(mockModule.address);
        await otherSetToken.connect(mockModule.wallet).initializeModule();

        // Issue to create some supply
        await usdc.approve(setup.issuanceModule.address, usdcUnits(1000));
        await setup.issuanceModule.initialize(otherSetToken.address, ADDRESS_ZERO);
        await setup.issuanceModule.issue(otherSetToken.address, ether(2), owner.address);

        subjectSetToken = otherSetToken.address;
      });

      it("should not update the externalPositionUnit", async () => {
        const initialExternalPositionUnit = await otherSetToken.getExternalPositionRealUnit(
          usdc.address,
          perpLeverageModule.address
        );

        await subject();

        const finalExternalPositionUnit = await otherSetToken.getExternalPositionRealUnit(
          usdc.address,
          perpLeverageModule.address
        );

        expect(initialExternalPositionUnit).eq(ZERO);
        expect(initialExternalPositionUnit).eq(finalExternalPositionUnit);
      });
    });

    describe("when caller is not module", async () => {
      beforeEach(async () => subjectCaller = owner);

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Only the module can call");
      });
    });

    describe("if disabled module is caller", async () => {
      beforeEach(async () => {
        await setup.controller.removeModule(mockModule.address);
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Module must be enabled on controller");
      });
    });
  });

  describe("#componentIssueHook", () => {
    let setToken: SetToken;
    let collateralQuantity: BigNumber;
    let subjectSetToken: Address;
    let subjectSetQuantity: BigNumber;
    let subjectIsEquity: boolean;
    let subjectCaller: Account;

    const initializeContracts = async () => {
      collateralQuantity = usdcUnits(10);
      setToken = await issueSetsAndDepositToPerp(collateralQuantity);
    };

    const initializeSubjectVariables = () => {
      subjectSetToken = setToken.address;
      subjectCaller = mockModule;
      subjectSetQuantity = ether(1);
      subjectIsEquity = true;
    };

    cacheBeforeEach(initializeContracts);
    beforeEach(initializeSubjectVariables);

    async function subject(): Promise<any> {
      return await perpLeverageModule.connect(subjectCaller.wallet).componentIssueHook(
        subjectSetToken,
        subjectSetQuantity,
        usdc.address,
        subjectIsEquity
      );
    }

    describe("when long", () => {
      // Set up as 2X Long, allow 2% slippage
      cacheBeforeEach(async () => {
        await leverUp(
          setToken,
          perpLeverageModule,
          perpSetup,
          owner,
          vETH.address,
          2,
          ether(.02),
          true
        );

        await perpLeverageModule
          .connect(subjectCaller.wallet)
          .moduleIssueHook(subjectSetToken, subjectSetQuantity);
      });

      it("transfer the expected amount from SetToken to Perp vault", async () => {
        const initialSetTokenUSDCBalance = await usdc.balanceOf(subjectSetToken);

        const externalUSDCPositionUnit = await setToken.getExternalPositionRealUnit(
          usdc.address,
          perpLeverageModule.address
        );

        const usdcToTransferOut = preciseMul(externalUSDCPositionUnit, subjectSetQuantity);

        await subject();

        const finalSetTokenUSDCBalance = await usdc.balanceOf(subjectSetToken);
        const expectedSetTokenUSDCBalance = initialSetTokenUSDCBalance.sub(usdcToTransferOut);

        expect(finalSetTokenUSDCBalance).eq(expectedSetTokenUSDCBalance);
      });

      it("should not update the USDC defaultPositionUnit", async () => {
        const initialDefaultPosition = await setToken.getDefaultPositionRealUnit(usdc.address);

        await subject();

        const finalDefaultPosition = await setToken.getDefaultPositionRealUnit(usdc.address);

        expect(finalDefaultPosition).to.eq(initialDefaultPosition);
      });

      it("should not update the USDC externalPositionUnit", async () => {
        const initialExternalPositionUnit = await setToken.getExternalPositionRealUnit(usdc.address, perpLeverageModule.address);
        await subject();
        const finalExternalPositionUnit = await setToken.getExternalPositionRealUnit(usdc.address, perpLeverageModule.address);

        expect(initialExternalPositionUnit).eq(finalExternalPositionUnit);
      });
    });

    describe("when short", () => {
      // Set up as 2X Short, allow 2% slippage
      cacheBeforeEach(async () => {
        await leverUp(
          setToken,
          perpLeverageModule,
          perpSetup,
          owner,
          vETH.address,
          2,
          ether(.02),
          false
        );

        await perpLeverageModule
          .connect(subjectCaller.wallet)
          .moduleIssueHook(subjectSetToken, subjectSetQuantity);
      });

      it("transfer the expected amount from SetToken to Perp vault", async () => {
        const initialSetTokenUSDCBalance = await usdc.balanceOf(subjectSetToken);

        const externalUSDCPositionUnit = await setToken.getExternalPositionRealUnit(
          usdc.address,
          perpLeverageModule.address
        );

        const usdcToTransferOut = preciseMul(externalUSDCPositionUnit, subjectSetQuantity);

        await subject();

        const finalSetTokenUSDCBalance = await usdc.balanceOf(subjectSetToken);
        const expectedSetTokenUSDCBalance = initialSetTokenUSDCBalance.sub(usdcToTransferOut);

        expect(finalSetTokenUSDCBalance).eq(expectedSetTokenUSDCBalance);
      });

      it("should not update the USDC defaultPositionUnit", async () => {
        const initialDefaultPosition = await setToken.getDefaultPositionRealUnit(usdc.address);

        await subject();

        const finalDefaultPosition = await setToken.getDefaultPositionRealUnit(usdc.address);

        expect(finalDefaultPosition).to.eq(initialDefaultPosition);
      });

      it("should not update the USDC externalPositionUnit", async () => {
        const initialExternalPositionUnit = await setToken.getExternalPositionRealUnit(usdc.address, perpLeverageModule.address);
        await subject();
        const finalExternalPositionUnit = await setToken.getExternalPositionRealUnit(usdc.address, perpLeverageModule.address);

        expect(initialExternalPositionUnit).eq(finalExternalPositionUnit);
      });
    });

    describe("when isEquity is false", async () => {
      beforeEach(async () => {
        subjectIsEquity = false;
      });

      it("should deposit nothing", async () => {
        const {
          collateralBalance: initialCollateralBalance
        } = await perpLeverageModule.getAccountInfo(subjectSetToken);

        await subject();

        const {
          collateralBalance: finalCollateralBalance
        } = await perpLeverageModule.getAccountInfo(subjectSetToken);

        expect(initialCollateralBalance).to.eq(finalCollateralBalance);
      });
    });

    describe("when caller is not module", async () => {
      beforeEach(async () => {
        subjectCaller = owner;
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Only the module can call");
      });
    });

    describe("if disabled module is caller", async () => {
      beforeEach(async () => {
        await setup.controller.removeModule(mockModule.address);
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Module must be enabled on controller");
      });
    });
  });

  describe("#componentRedeemHook", () => {
    let setToken: SetToken;
    let collateralQuantity: BigNumber;
    let subjectSetToken: Address;
    let subjectSetQuantity: BigNumber;
    let subjectIsEquity: boolean;
    let subjectCaller: Account;

    const initializeContracts = async () => {
      collateralQuantity = usdcUnits(10);
      setToken = await issueSetsAndDepositToPerp(collateralQuantity);
    };

    const initializeSubjectVariables = () => {
      subjectSetToken = setToken.address;
      subjectCaller = mockModule;
      subjectSetQuantity = ether(.5); // Sell half
      subjectIsEquity = true;
    };

    cacheBeforeEach(initializeContracts);
    beforeEach(initializeSubjectVariables);

    async function subject(): Promise<any> {
      return await perpLeverageModule.connect(subjectCaller.wallet).componentRedeemHook(
        subjectSetToken,
        subjectSetQuantity,
        usdc.address,
        subjectIsEquity
      );
    }

    describe("when long", () => {
      // Set up as 2X Long, allow 2% slippage
      cacheBeforeEach(async () => {
        await leverUp(
          setToken,
          perpLeverageModule,
          perpSetup,
          owner,
          vETH.address,
          2,
          ether(.02),
          true
        );

        await perpLeverageModule
          .connect(subjectCaller.wallet)
          .moduleRedeemHook(subjectSetToken, subjectSetQuantity);
      });

      it("transfer the expected amount from Perp vault to SetToken", async () => {
        const initialSetTokenUSDCBalance = await usdc.balanceOf(subjectSetToken);

        const externalUSDCPositionUnit = await setToken.getExternalPositionRealUnit(
          usdc.address,
          perpLeverageModule.address
        );

        const usdcToTransferOut = preciseMul(externalUSDCPositionUnit, subjectSetQuantity);

        await subject();

        const finalSetTokenUSDCBalance = await usdc.balanceOf(subjectSetToken);
        const expectedSetTokenUSDCBalance = initialSetTokenUSDCBalance.add(usdcToTransferOut);

        expect(finalSetTokenUSDCBalance).eq(expectedSetTokenUSDCBalance);
      });

      it("should not update the USDC defaultPositionUnit", async () => {
        const initialDefaultPositionUnit = await setToken.getDefaultPositionRealUnit(usdc.address);
        await subject();
        const finalDefaultPositionUnit = await setToken.getDefaultPositionRealUnit(usdc.address);

        expect(initialDefaultPositionUnit).eq(finalDefaultPositionUnit);
      });

      it("should not update the USDC externalPositionUnit", async () => {
        const initialExternalPositionUnit = await setToken.getExternalPositionRealUnit(usdc.address, perpLeverageModule.address);
        await subject();
        const finalExternalPositionUnit = await setToken.getExternalPositionRealUnit(usdc.address, perpLeverageModule.address);

        expect(initialExternalPositionUnit).eq(finalExternalPositionUnit);
      });
    });

    describe("when short", () => {
      // Set up as 2X Short, allow 2% slippage
      cacheBeforeEach(async () => {
        await leverUp(
          setToken,
          perpLeverageModule,
          perpSetup,
          owner,
          vETH.address,
          2,
          ether(.02),
          false
        );

        await perpLeverageModule
          .connect(subjectCaller.wallet)
          .moduleRedeemHook(subjectSetToken, subjectSetQuantity);
      });

      it("transfer the expected amount from Perp vault to SetToken", async () => {
        const initialSetTokenUSDCBalance = await usdc.balanceOf(subjectSetToken);

        const externalUSDCPositionUnit = await setToken.getExternalPositionRealUnit(
          usdc.address,
          perpLeverageModule.address
        );

        const usdcToTransferOut = preciseMul(externalUSDCPositionUnit, subjectSetQuantity);

        await subject();

        const finalSetTokenUSDCBalance = await usdc.balanceOf(subjectSetToken);
        const expectedSetTokenUSDCBalance = initialSetTokenUSDCBalance.add(usdcToTransferOut);

        expect(finalSetTokenUSDCBalance).eq(expectedSetTokenUSDCBalance);
      });

      it("should not update the USDC defaultPositionUnit", async () => {
        const initialDefaultPositionUnit = await setToken.getDefaultPositionRealUnit(usdc.address);
        await subject();
        const finalDefaultPositionUnit = await setToken.getDefaultPositionRealUnit(usdc.address);

        expect(initialDefaultPositionUnit).eq(finalDefaultPositionUnit);
      });

      it("should not update the USDC externalPositionUnit", async () => {
        const initialExternalPositionUnit = await setToken.getExternalPositionRealUnit(usdc.address, perpLeverageModule.address);
        await subject();
        const finalExternalPositionUnit = await setToken.getExternalPositionRealUnit(usdc.address, perpLeverageModule.address);

        expect(initialExternalPositionUnit).eq(finalExternalPositionUnit);
      });
    });

    describe("when isEquity is false", async () => {
      beforeEach(async () => {
        subjectIsEquity = false;
      });

      it("should withdraw nothing", async () => {
        const {
          collateralBalance: initialCollateralBalance
        } = await perpLeverageModule.getAccountInfo(subjectSetToken);

        await subject();

        const {
          collateralBalance: finalCollateralBalance
        } = await perpLeverageModule.getAccountInfo(subjectSetToken);

        expect(initialCollateralBalance).to.eq(finalCollateralBalance);
      });
    });

    describe("when caller is not module", async () => {
      beforeEach(async () => {
        subjectCaller = owner;
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Only the module can call");
      });
    });

    describe("if disabled module is caller", async () => {
      beforeEach(async () => {
        await setup.controller.removeModule(mockModule.address);
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Module must be enabled on controller");
      });
    });
  });

  describe("#registerToModule", async () => {
    let setToken: SetToken;
    let otherIssuanceModule: DebtIssuanceMock;
    let isInitialized: boolean;
    let subjectSetToken: Address;
    let subjectDebtIssuanceModule: Address;

    const initializeContracts = async function () {
      otherIssuanceModule = await deployer.mocks.deployDebtIssuanceMock();
      await setup.controller.addModule(otherIssuanceModule.address);

      setToken = await setup.createSetToken(
        [usdc.address],
        [ether(100)],
        [perpLeverageModule.address, setup.issuanceModule.address, debtIssuanceMock.address]
      );
      await debtIssuanceMock.initialize(setToken.address);
      // Add SetToken to allow list
      await perpLeverageModule.updateAllowedSetToken(setToken.address, true);
      // Initialize module if set to true
      if (isInitialized) {
        await perpLeverageModule.initialize(setToken.address);
      }
      await setup.issuanceModule.initialize(setToken.address, ADDRESS_ZERO);
      // Add other issuance mock after initializing PerpV2LeverageModuleV2, so register is never called
      await setToken.addModule(otherIssuanceModule.address);
      await otherIssuanceModule.initialize(setToken.address);
    };

    const initializeSubjectVariables = () => {
      subjectSetToken = setToken.address;
      subjectDebtIssuanceModule = otherIssuanceModule.address;
    };

    async function subject(): Promise<any> {
      return perpLeverageModule.registerToModule(subjectSetToken, subjectDebtIssuanceModule);
    }

    describe("when module is initialized", () => {
      beforeEach(() => {
        isInitialized = true;
      });

      cacheBeforeEach(initializeContracts);
      beforeEach(initializeSubjectVariables);

      it("should register on the other issuance module", async () => {
        const previousIsRegistered = await otherIssuanceModule.isRegistered(setToken.address);
        await subject();
        const currentIsRegistered = await otherIssuanceModule.isRegistered(setToken.address);
        expect(previousIsRegistered).to.be.false;
        expect(currentIsRegistered).to.be.true;
      });

      describe("when SetToken is not valid", async () => {
        beforeEach(async () => {
          const nonEnabledSetToken = await setup.createNonControllerEnabledSetToken(
            [usdc.address],
            [ether(1)],
            [perpLeverageModule.address],
            owner.address
          );

          subjectSetToken = nonEnabledSetToken.address;
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("Must be a valid and initialized SetToken");
        });
      });

      describe("when debt issuance module is not initialized on SetToken", async () => {
        beforeEach(async () => {
          await setToken.removeModule(otherIssuanceModule.address);
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("Issuance not initialized");
        });
      });
    });

    describe("when module is not initialized", async () => {
      beforeEach(async () => {
        isInitialized = false;
        await initializeContracts();
        initializeSubjectVariables();
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Must be a valid and initialized SetToken");
      });
    });
  });

  describe("#removeModule", async () => {
    let setToken: SetToken;
    let subjectModule: Address;

    cacheBeforeEach(async () => {
      setToken = await setup.createSetToken(
        [usdc.address],
        [ether(100)],
        [perpLeverageModule.address, debtIssuanceMock.address, setup.issuanceModule.address]
      );
      await debtIssuanceMock.initialize(setToken.address);
      // Add SetToken to allow list
      await perpLeverageModule.updateAllowedSetToken(setToken.address, true);
      await perpLeverageModule.initialize(setToken.address);
      await setup.issuanceModule.initialize(setToken.address, ADDRESS_ZERO);

      // Approve tokens to issuance module and call issue
      await usdc.approve(setup.issuanceModule.address, ether(100));
      await setup.issuanceModule.issue(setToken.address, ether(1), owner.address);
    });

    beforeEach(() => {
      subjectModule = perpLeverageModule.address;
    });

    async function subject(): Promise<any> {
      return setToken.removeModule(subjectModule);
    }

    it("should remove the Module on the SetToken", async () => {
      await subject();
      const isModuleEnabled = await setToken.isInitializedModule(perpLeverageModule.address);
      expect(isModuleEnabled).to.be.false;
    });

    it("should unregister on the debt issuance module", async () => {
      await subject();
      const isRegistered = await debtIssuanceMock.isRegistered(setToken.address);
      expect(isRegistered).to.be.false;
    });

    describe("when the account balance is positive", async () => {
      beforeEach(async () => {
        await perpLeverageModule.deposit(setToken.address, usdcUnits(10));
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Account balance exists");
      });
    });
  });

  describe("#getIssuanceAdjustments", () => {
    let setToken: SetToken;
    let collateralQuantity: BigNumber;
    let subjectSetToken: Address;
    let subjectCaller: Account;
    let subjectSetQuantity: BigNumber;

    const initializeContracts = async () => {
      collateralQuantity = usdcUnits(10);
      setToken = await issueSetsAndDepositToPerp(collateralQuantity);
    };

    const initializeSubjectVariables = () => {
      subjectSetToken = setToken.address;
      subjectCaller = mockModule;
      subjectSetQuantity = ether(1);
    };

    cacheBeforeEach(initializeContracts);
    beforeEach(initializeSubjectVariables);

    async function subject(): Promise<any> {
      return await perpLeverageModule
        .connect(subjectCaller.wallet)
        .callStatic
        .getIssuanceAdjustments(subjectSetToken, subjectSetQuantity);
    }

    describe("when long, single position", () => {
      let baseToken: Address;

      // Set up as 2X Long, allow 2% slippage
      cacheBeforeEach(async () => {
        baseToken = vETH.address;

        await leverUp(
          setToken,
          perpLeverageModule,
          perpSetup,
          owner,
          baseToken,
          2,
          ether(.02),
          true
        );
      });

      describe("when issuing a single set", async () => {
        it("does *not* change the vBase balance", async () => {
          const initialBaseBalance = (await perpLeverageModule.getPositionNotionalInfo(subjectSetToken))[0].baseBalance;
          await subject();
          const finalBaseBalance = (await perpLeverageModule.getPositionNotionalInfo(subjectSetToken))[0].baseBalance;

          expect(initialBaseBalance).eq(finalBaseBalance);
        });

        it("should return adjustment arrays of the correct length with value in correct position", async () => {
          const components = await setToken.getComponents();
          const expectedAdjustmentsLength = components.length;

          const adjustments = await subject();

          const equityAdjustmentsLength = adjustments[0].length;
          const debtAdjustmentsLength = adjustments[1].length;
          const wbtcAdjustment = adjustments[0][0];
          const usdcAdjustment = adjustments[0][1];

          expect(equityAdjustmentsLength).eq(expectedAdjustmentsLength);
          expect(debtAdjustmentsLength).eq(debtAdjustmentsLength);
          expect(wbtcAdjustment).eq(ZERO);
          expect(usdcAdjustment).gt(ZERO);
        });

        it("should return the expected USDC adjustment unit", async () => {
          const oldExternalPositionUnit = await setToken.getExternalPositionRealUnit(usdc.address, perpLeverageModule.address);
          const usdcTransferInQuantity = await calculateUSDCTransferInPreciseUnits(
            setToken,
            subjectSetQuantity,
            perpLeverageModule,
            perpSetup
          );

          const actualAdjustmentUnit = (await subject())[0][1];     // call subject

          const newExternalPositionUnit = toUSDCDecimals(preciseDiv(usdcTransferInQuantity, subjectSetQuantity));
          const expectedAdjustmentUnit = newExternalPositionUnit.sub(oldExternalPositionUnit);

          expect(actualAdjustmentUnit).to.be.eq(expectedAdjustmentUnit);
        });

        describe("when the set token doesn't contain the collateral token", async () => {
          let otherSetToken: SetToken;

          beforeEach(async () => {
            otherSetToken = await setup.createSetToken(
              [setup.wbtc.address],
              [bitcoin(10)],
              [perpLeverageModule.address, debtIssuanceMock.address, setup.issuanceModule.address]
            );
            await debtIssuanceMock.initialize(otherSetToken.address);
            await perpLeverageModule.updateAllowedSetToken(otherSetToken.address, true);
            await perpLeverageModule.connect(owner.wallet).initialize(otherSetToken.address);

            subjectSetToken = otherSetToken.address;
          });

          it("should return empty arrays", async () => {
            const components = await otherSetToken.getComponents();
            const adjustments = await subject();

            const expectedAdjustmentsLength = 2;
            const expectedAdjustmentValue = ZERO;
            const expectedAdjustmentsArrayLength = components.length;

            expect(adjustments.length).eq(expectedAdjustmentsLength);
            expect(adjustments[0].length).eq(expectedAdjustmentsArrayLength);
            expect(adjustments[1].length).eq(expectedAdjustmentsArrayLength);

            for (const adjustment of adjustments[0]) {
              expect(adjustment).eq(expectedAdjustmentValue);
            }

            for (const adjustment of adjustments[1]) {
              expect(adjustment).eq(expectedAdjustmentValue);
            }
          });
        });
      });
    });
  });

  describe("#getRedemptionAdjustments", () => {
    let setToken: SetToken;
    let collateralQuantity: BigNumber;
    let subjectSetToken: Address;
    let subjectSetQuantity: BigNumber;
    let subjectCaller: Account;

    const initializeContracts = async () => {
      collateralQuantity = usdcUnits(10);
      setToken = await issueSetsAndDepositToPerp(collateralQuantity);
    };

    const initializeSubjectVariables = () => {
      subjectSetToken = setToken.address;
      subjectCaller = mockModule;
      subjectSetQuantity = ether(1);
    };

    cacheBeforeEach(initializeContracts);
    beforeEach(initializeSubjectVariables);

    async function subject(): Promise<any> {
      return await perpLeverageModule
        .connect(subjectCaller.wallet)
        .callStatic
        .getRedemptionAdjustments(subjectSetToken, subjectSetQuantity);
    }

    describe("when long", async () => {
      let baseToken: Address;

      // Set up as 2X Long, allow 2% slippage
      cacheBeforeEach(async () => {
        baseToken = vETH.address;

        await leverUp(
          setToken,
          perpLeverageModule,
          perpSetup,
          owner,
          baseToken,
          2,
          ether(.02),
          true
        );
      });

      describe("when redeeming a single set", async () => {
        it("should *not* alter the vBase balance", async () => {
          const initialBaseBalance = (await perpLeverageModule.getPositionNotionalInfo(subjectSetToken))[0].baseBalance;
          await subject();
          const finalBaseBalance = (await perpLeverageModule.getPositionNotionalInfo(subjectSetToken))[0].baseBalance;

          expect(initialBaseBalance).eq(finalBaseBalance);
        });

        it("should return adjustment arrays of the correct length with value in correct position", async () => {
          const components = await setToken.getComponents();
          const expectedAdjustmentsLength = components.length;

          const adjustments = await subject();

          const equityAdjustmentsLength = adjustments[0].length;
          const debtAdjustmentsLength = adjustments[1].length;
          const wbtcAdjustment = adjustments[0][0];
          const usdcAdjustment = adjustments[0][1];

          expect(equityAdjustmentsLength).eq(expectedAdjustmentsLength);
          expect(debtAdjustmentsLength).eq(debtAdjustmentsLength);
          expect(wbtcAdjustment).eq(ZERO);
          expect(usdcAdjustment).lt(ZERO);
        });

        it("should return the expected USDC adjustment unit", async () => {
          const oldExternalPositionUnit = await setToken.getExternalPositionRealUnit(usdc.address, perpLeverageModule.address);
          const usdcTransferOutQuantity = await calculateUSDCTransferOutPreciseUnits(
            setToken,
            subjectSetQuantity,
            perpLeverageModule,
            perpSetup
          );

          const actualAdjustmentUnit = (await subject())[0][1];     // call subject

          const newExternalPositionUnit = toUSDCDecimals(preciseDiv(usdcTransferOutQuantity, subjectSetQuantity));
          const expectedAdjustmentUnit = newExternalPositionUnit.sub(oldExternalPositionUnit);

          expect(actualAdjustmentUnit).to.be.eq(expectedAdjustmentUnit);
        });

        describe("when the set token doesn't contain the collateral token", async () => {
          let otherSetToken: SetToken;

          beforeEach(async () => {
            otherSetToken = await setup.createSetToken(
              [setup.wbtc.address],
              [bitcoin(10)],
              [perpLeverageModule.address, debtIssuanceMock.address, setup.issuanceModule.address]
            );
            await debtIssuanceMock.initialize(otherSetToken.address);
            await perpLeverageModule.updateAllowedSetToken(otherSetToken.address, true);
            await perpLeverageModule.connect(owner.wallet).initialize(otherSetToken.address);

            subjectSetToken = otherSetToken.address;
          });

          it("should return empty arrays", async () => {
            const components = await otherSetToken.getComponents();
            const adjustments = await subject();

            const expectedAdjustmentsLength = 2;
            const expectedAdjustmentValue = ZERO;
            const expectedAdjustmentsArrayLength = components.length;

            expect(adjustments.length).eq(expectedAdjustmentsLength);
            expect(adjustments[0].length).eq(expectedAdjustmentsArrayLength);
            expect(adjustments[1].length).eq(expectedAdjustmentsArrayLength);

            for (const adjustment of adjustments[0]) {
              expect(adjustment).eq(expectedAdjustmentValue);
            }

            for (const adjustment of adjustments[1]) {
              expect(adjustment).eq(expectedAdjustmentValue);
            }
          });
        });
      });
    });
  });

  describe("#getPositionNotionalInfo", () => {
    let setToken: SetToken;
    let subjectSetToken: Address;

    let issueQuantity: BigNumber;
    let expectedVETHToken: Address;
    let expectedVBTCToken: Address;
    let vethTradeQuantityUnits: BigNumber;
    let vbtcTradeQuantityUnits: BigNumber;
    let expectedDepositQuantity: BigNumber;
    let expectedVETHDeltaQuote: BigNumber;
    let expectedVBTCDeltaQuote: BigNumber;

    beforeEach(async () => {
      expectedDepositQuantity = usdcUnits(100);
      issueQuantity = ether(2);

      setToken = await issueSetsAndDepositToPerp(expectedDepositQuantity, true, issueQuantity);

      subjectSetToken = setToken.address;
      expectedVETHToken = vETH.address;
      expectedVBTCToken = vBTC.address;
      vethTradeQuantityUnits = ether(1);
      vbtcTradeQuantityUnits = ether(2);

      ({ deltaQuote: expectedVETHDeltaQuote } = await perpSetup.getSwapQuote(
        expectedVETHToken,
        preciseMul(vethTradeQuantityUnits, issueQuantity),
        true
      ));

      ({ deltaQuote: expectedVBTCDeltaQuote } = await perpSetup.getSwapQuote(
        expectedVBTCToken,
        preciseMul(vbtcTradeQuantityUnits, issueQuantity),
        true
      ));

      const vETHQuoteBoundQuantityUnits = ether(10.15);
      const vBTCQuoteBoundQuantityUnits = ether(101);

      await perpLeverageModule.connect(owner.wallet).trade(
        subjectSetToken,
        expectedVETHToken,
        vethTradeQuantityUnits,
        vETHQuoteBoundQuantityUnits
      );

      await perpLeverageModule.connect(owner.wallet).trade(
        subjectSetToken,
        expectedVBTCToken,
        vbtcTradeQuantityUnits,
        vBTCQuoteBoundQuantityUnits
      );
    });

    async function subject(): Promise<any> {
      return perpLeverageModule.getPositionNotionalInfo(subjectSetToken);
    }

    it("should return info for multiple positions", async () => {
      const positionInfo = await subject();

      const expectedVETHNotionalPosition = preciseMul(vethTradeQuantityUnits, issueQuantity);
      const expectedVBTCNotionalPosition = preciseMul(vbtcTradeQuantityUnits, issueQuantity);

      expect(positionInfo.length).eq(2);
      expect(positionInfo[0].baseToken).eq(expectedVETHToken);
      expect(positionInfo[1].baseToken).eq(expectedVBTCToken);
      expect(positionInfo[0].baseBalance).eq(expectedVETHNotionalPosition);
      expect(positionInfo[1].baseBalance).eq(expectedVBTCNotionalPosition);
      expect(positionInfo[0].quoteBalance).eq(expectedVETHDeltaQuote.mul(-1));
      expect(positionInfo[1].quoteBalance).eq(expectedVBTCDeltaQuote.mul(-1));
    });
  });

  describe("#getPositionUnitInfo", () => {
    let setToken: SetToken;
    let issueQuantity: BigNumber;
    let subjectSetToken: Address;

    let expectedVETHToken: Address;
    let expectedVBTCToken: Address;
    let vethTradeQuantityUnits: BigNumber;
    let vbtcTradeQuantityUnits: BigNumber;
    let expectedDepositQuantity: BigNumber;
    let expectedVETHQuoteUnits: BigNumber;
    let expectedVBTCQuoteUnits: BigNumber;

    beforeEach(async () => {
      issueQuantity = ether(2);
      expectedDepositQuantity = usdcUnits(100);

      // Issue 2 sets
      setToken = await issueSetsAndDepositToPerp(expectedDepositQuantity, true, issueQuantity);

      subjectSetToken = setToken.address;
      expectedVETHToken = vETH.address;
      expectedVBTCToken = vBTC.address;
      vethTradeQuantityUnits = preciseDiv(ether(1), issueQuantity);
      vbtcTradeQuantityUnits = preciseDiv(ether(1), issueQuantity);

      const vETHQuoteBoundQuantityUnits = preciseDiv(ether(10.15), issueQuantity);
      const vBTCQuoteBoundQuantityUnits = preciseDiv(ether(50.575), issueQuantity);

      await perpLeverageModule.connect(owner.wallet).trade(
        subjectSetToken,
        expectedVETHToken,
        vethTradeQuantityUnits,
        vETHQuoteBoundQuantityUnits
      );

      await perpLeverageModule.connect(owner.wallet).trade(
        subjectSetToken,
        expectedVBTCToken,
        vbtcTradeQuantityUnits,
        vBTCQuoteBoundQuantityUnits
      );
    });

    async function subject(): Promise<any> {
      return perpLeverageModule.getPositionUnitInfo(subjectSetToken);
    }

    it("should return info for multiple positions", async () => {
      const vETHQuoteBalance = await perpSetup.accountBalance.getQuote(subjectSetToken, expectedVETHToken);
      const vBTCQuoteBalance = await perpSetup.accountBalance.getQuote(subjectSetToken, expectedVBTCToken);

      expectedVETHQuoteUnits = preciseDiv(vETHQuoteBalance, issueQuantity);
      expectedVBTCQuoteUnits = preciseDiv(vBTCQuoteBalance, issueQuantity);

      const positionInfo = await subject();

      expect(positionInfo.length).eq(2);
      expect(positionInfo[0].baseToken).eq(expectedVETHToken);
      expect(positionInfo[1].baseToken).eq(expectedVBTCToken);
      expect(positionInfo[0].baseUnit).eq(vethTradeQuantityUnits);
      expect(positionInfo[1].baseUnit).eq(vbtcTradeQuantityUnits);
      expect(positionInfo[0].quoteUnit).eq(expectedVETHQuoteUnits);
      expect(positionInfo[1].quoteUnit).eq(expectedVBTCQuoteUnits);
    });
  });

  describe("#getAccountInfo", () => {
    let setToken: SetToken;
    let subjectSetToken: Address;
    let expectedDepositQuantity: BigNumber;

    beforeEach(async () => {
      expectedDepositQuantity = usdcUnits(10);
      setToken = await issueSetsAndDepositToPerp(expectedDepositQuantity);
      subjectSetToken = setToken.address;

      await leverUp(setToken, perpLeverageModule, perpSetup, owner, vETH.address, 2, ether(0.02), true);
      await increaseTimeAsync(ONE_DAY_IN_SECONDS);
    });

    async function subject(): Promise<any> {
      return perpLeverageModule.getAccountInfo(subjectSetToken);
    }

    it("should return account info", async () => {
      const pendingFunding = await perpSetup.exchange.getAllPendingFundingPayment(setToken.address);

      const accountInfo = await subject();

      const expectedFunding = pendingFunding.mul(-1);

      expect(toUSDCDecimals(accountInfo.collateralBalance)).eq(expectedDepositQuantity);
      expect(accountInfo.owedRealizedPnl).eq(0);
      expect(accountInfo.pendingFundingPayments).eq(expectedFunding);
    });
  });

  describe("#updateMaxPerpPositionsPerSet", async () => {
    let subjectCaller: Account;
    let subjectMaxPerpPositionsPerSet: BigNumber;

    beforeEach(async () => {
      subjectCaller = owner;
      subjectMaxPerpPositionsPerSet = THREE;
    });

    async function subject(): Promise<any> {
      await perpLeverageModule.connect(subjectCaller.wallet).updateMaxPerpPositionsPerSet(subjectMaxPerpPositionsPerSet);
    }

    it("should update max perp positions per set", async () => {
      await subject();

      const maxPerpPositionsPerSet = await perpLeverageModule.maxPerpPositionsPerSet();

      expect(maxPerpPositionsPerSet).to.eq(THREE);
    });

    describe("when owner is not caller", async () => {
      beforeEach(async () => {
        subjectCaller = await getRandomAccount();
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Ownable: caller is not the owner");
      });
    });
  });
});
