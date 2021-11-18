import "module-alias/register";

import { Address } from "@utils/types";
import { Account } from "@utils/test/types";
import {
  PerpV2,
  PerpV2LeverageModule,
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
import { ADDRESS_ZERO, ZERO, ZERO_BYTES, MAX_UINT_256, ONE_DAY_IN_SECONDS  } from "@utils/constants";
import { BigNumber } from "ethers";
// import { inspect } from "util";

const expect = getWaffleExpect();

function toUSDCDecimals(quantity: BigNumber): BigNumber {
  return quantity.div(BigNumber.from(10).pow(12));
}

describe("PerpV2LeverageModule", () => {
  let owner: Account;
  let maker: Account;
  let otherTrader: Account;
  let mockModule: Account;
  let deployer: DeployHelper;

  let perpLib: PerpV2;
  let perpLeverageModule: PerpV2LeverageModule;
  let debtIssuanceMock: DebtIssuanceMock;
  let setup: SystemFixture;
  let perpSetup: PerpV2Fixture;

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

    vETH = perpSetup.vETH;
    vBTC = perpSetup.vBTC;
    usdc = perpSetup.usdc;

    // Create liquidity
    await perpSetup.setBaseTokenOraclePrice(vETH, "10");
    await perpSetup.initializePoolWithLiquidityWide(
      vETH,
      ether(10_000),
      ether(100_000)
    );

    await perpSetup.setBaseTokenOraclePrice(vBTC, "20");
    await perpSetup.initializePoolWithLiquidityWide(
      vBTC,
      ether(10_000),
      ether(200_000)
    );

    debtIssuanceMock = await deployer.mocks.deployDebtIssuanceMock();
    await setup.controller.addModule(debtIssuanceMock.address);

    perpLib = await deployer.libraries.deployPerpV2();
    perpLeverageModule = await deployer.modules.deployPerpV2LeverageModule(
      setup.controller.address,
      perpSetup.accountBalance.address,
      perpSetup.clearingHouse.address,
      perpSetup.exchange.address,
      perpSetup.vault.address,
      perpSetup.quoter.address,
      perpSetup.marketRegistry.address,
      "contracts/protocol/integration/lib/PerpV2.sol:PerpV2",
      perpLib.address,
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

  // Setup helper which allocates all deposited collateral to a levered position.
  // Returns new baseToken position unit
  async function leverUp(
    setToken: SetToken,
    baseToken: Address,
    leverageRatio: number,
    slippagePercentage: BigNumber,
    isLong: boolean
  ): Promise<BigNumber>{
    const spotPrice = await perpSetup.getSpotPrice(baseToken);
    const totalSupply = await setToken.totalSupply();
    const collateralBalance = (await perpLeverageModule.getAccountInfo(setToken.address)).collateralBalance;
    const baseTradeQuantityNotional = preciseDiv(collateralBalance.mul(leverageRatio), spotPrice);

    const baseTradeQuantityUnit = (isLong)
      ? preciseDiv(baseTradeQuantityNotional, totalSupply)
      : preciseDiv(baseTradeQuantityNotional, totalSupply).mul(-1);

    const estimatedQuoteQuantityNotional =  preciseMul(baseTradeQuantityNotional, spotPrice).abs();
    const allowedSlippage = preciseMul(estimatedQuoteQuantityNotional, ether(.02));

    const slippageAdjustedQuoteQuanitityNotional = (isLong)
      ? estimatedQuoteQuantityNotional.add(allowedSlippage)
      : estimatedQuoteQuantityNotional.sub(allowedSlippage);

    const receiveQuoteQuantityUnit = preciseDiv(
      slippageAdjustedQuoteQuanitityNotional,
      totalSupply
    );

    await perpLeverageModule.connect(owner.wallet).trade(
      setToken.address,
      baseToken,
      baseTradeQuantityUnit,
      receiveQuoteQuantityUnit
    );

    return baseTradeQuantityUnit;
  }

  // Creates SetToken, issues sets (default: 1), initializes PerpV2LeverageModule and deposits to Perp
  async function issueSetsAndDepositToPerp(
    depositQuantityUnit: BigNumber,
    isInitialized: boolean = true,
    issueQuantity: BigNumber = ether(1),
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
      await setup.controller.addModule(mockModule.address);
      await setToken.addModule(mockModule.address);
      await setToken.connect(mockModule.wallet).initializeModule();

      await usdc.approve(setup.issuanceModule.address, usdcUnits(1000));
      await setup.issuanceModule.initialize(setToken.address, ADDRESS_ZERO);
      await setup.issuanceModule.issue(setToken.address, issueQuantity, owner.address);

      await perpLeverageModule.deposit(setToken.address, depositQuantityUnit);
    }

    return setToken;
  }

  describe("#constructor", async () => {
    let subjectController: Address;
    let subjectAccountBalance: Address;
    let subjectClearingHouse: Address;
    let subjectExchange: Address;
    let subjectVault: Address;
    let subjectQuoter: Address;
    let subjectMarketRegistry: Address;

    beforeEach(async () => {
      subjectController = setup.controller.address;
      subjectAccountBalance = perpSetup.accountBalance.address;
      subjectClearingHouse = perpSetup.clearingHouse.address;
      subjectExchange = perpSetup.exchange.address;
      subjectVault = perpSetup.vault.address;
      subjectQuoter = perpSetup.quoter.address;
      subjectMarketRegistry = perpSetup.marketRegistry.address;
    });

    async function subject(): Promise<PerpV2LeverageModule> {
      return deployer.modules.deployPerpV2LeverageModule(
        subjectController,
        subjectAccountBalance,
        subjectClearingHouse,
        subjectExchange,
        subjectVault,
        subjectQuoter,
        subjectMarketRegistry,
        "contracts/protocol/integration/lib/PerpV2.sol:PerpV2",
        perpLib.address,
      );
    }

    it("should set the correct controller", async () => {
      const perpLeverageModule = await subject();

      const controller = await perpLeverageModule.controller();
      expect(controller).to.eq(subjectController);
    });

    it("should set the correct PerpV2 contracts", async () => {
      const perpLeverageModule = await subject();

      const perpAccountBalance = await perpLeverageModule.perpAccountBalance();
      const perpClearingHouse = await perpLeverageModule.perpClearingHouse();
      const perpExchange = await perpLeverageModule.perpExchange();
      const perpVault = await perpLeverageModule.perpVault();
      const perpQuoter = await perpLeverageModule.perpQuoter();

      expect(perpAccountBalance).to.eq(perpSetup.accountBalance.address);
      expect(perpClearingHouse).to.eq(perpSetup.clearingHouse.address);
      expect(perpExchange).to.eq(perpSetup.exchange.address);
      expect(perpVault).to.eq(perpSetup.vault.address);
      expect(perpQuoter).to.eq(perpSetup.quoter.address);
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

      it("should set the collateralToken", async () => {
        const initialCollateralToken = await perpLeverageModule.collateralToken();

        await subject();

        const finalCollateralToken = await perpLeverageModule.collateralToken();

        expect(initialCollateralToken).to.eq(ADDRESS_ZERO);
        expect(finalCollateralToken).to.eq(usdc.address);
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
    let subjectQuoteReceiveQuantityUnits: BigNumber;

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
        subjectQuoteReceiveQuantityUnits
      );
    }

    describe("when module is initialized", async () => {
      describe("when long", () => {
        describe("when no positions are open (total supply is 1)", async () => {
          beforeEach(async () => {
            // Long ~10 USDC of vETH
            subjectBaseTradeQuantityUnits = ether(1);
            subjectQuoteReceiveQuantityUnits = ether(10.15);
          });

          it("should open the expected position", async () => {
            const totalSupply = await setToken.totalSupply();

            const expectedBaseBalance = preciseMul(subjectBaseTradeQuantityUnits, totalSupply);
            const expectedQuoteBalance =
              (await perpSetup.getSwapQuote(subjectBaseToken, subjectBaseTradeQuantityUnits, true)).deltaQuote;

            const initialPositionInfo = await perpLeverageModule.getPositionInfo(subjectSetToken);
            await subject();
            const finalPositionInfo = (await perpLeverageModule.getPositionInfo(subjectSetToken))[0];

            expect(initialPositionInfo.length).to.eq(0);
            expect(finalPositionInfo.baseBalance).gt(0);
            expect(finalPositionInfo.quoteBalance).lt(0);
            expect(finalPositionInfo.baseBalance).eq(expectedBaseBalance);
            expect(finalPositionInfo.quoteBalance).eq(expectedQuoteBalance.mul(-1));
            expect(finalPositionInfo.quoteBalance.mul(-1)).lt(subjectQuoteReceiveQuantityUnits);
          });

          it("should emit the correct PerpTrade event", async () => {
            const {
              deltaBase: expectedDeltaBase,
              deltaQuote: expectedDeltaQuote
            } = await perpSetup.getSwapQuote(subjectBaseToken, subjectBaseTradeQuantityUnits, true);

            const expectedProtocolFee = ether(0);
            const expectedIsBuy = true;

            await expect(subject()).to.emit(perpLeverageModule, "PerpTrade").withArgs(
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
            subjectQuoteReceiveQuantityUnits = ether(20.3);
          });

          it("should open expected position", async () => {
            const totalSupply = await setToken.totalSupply();
            const collateralBalance = (await perpLeverageModule.getAccountInfo(subjectSetToken)).collateralBalance;
            const quoteBalanceMin = preciseMul(subjectQuoteReceiveQuantityUnits, totalSupply);

            const expectedQuoteBalance =
              (await perpSetup.getSwapQuote(subjectBaseToken, subjectBaseTradeQuantityUnits, true)).deltaQuote;

            await subject();

            const positionInfo = (await perpLeverageModule.getPositionInfo(subjectSetToken))[0];
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
          beforeEach(async () => {
            await setup.issuanceModule.issue(setToken.address, ether(1), owner.address);

            subjectBaseTradeQuantityUnits = ether(1);
            subjectQuoteReceiveQuantityUnits = ether(10.15);
          });

          it("should open position for the expected amount", async () => {
            const totalSupply = await setToken.totalSupply();
            const expectedBaseBalance = preciseMul(subjectBaseTradeQuantityUnits, totalSupply);

            await subject();

            const positionInfo = (await perpLeverageModule.getPositionInfo(subjectSetToken))[0];
            expect(positionInfo.baseBalance).to.eq(expectedBaseBalance);
          });
        });

        describe("when slippage is greater than allowed", async () => {
          beforeEach(async () => {
            // Long ~10 USDC of vETH: slippage incurred as larger negative quote delta
            subjectBaseTradeQuantityUnits = ether(1);
            subjectQuoteReceiveQuantityUnits = ether(10);
          });

          it("should revert", async () => {
            // ClearingHouse: too much quote received when long
            await expect(subject()).to.be.revertedWith("CH_TMRL");
          });
        });

        describe("when an existing position is long", async () => {
          beforeEach(async () => {
            subjectBaseTradeQuantityUnits = ether(1);
            subjectQuoteReceiveQuantityUnits = ether(10.15);

            await perpLeverageModule.connect(subjectCaller.wallet).trade(
              subjectSetToken,
              subjectBaseToken,
              subjectBaseTradeQuantityUnits,
              subjectQuoteReceiveQuantityUnits
            );
          });

          it("long trade should increase the position size", async () => {
            const totalSupply = await setToken.totalSupply();
            const initialPositionInfo = await perpLeverageModule.getPositionInfo(subjectSetToken);
            const expectedDeltaBase = preciseMul(subjectBaseTradeQuantityUnits, totalSupply);
            const expectedBaseBalance = initialPositionInfo[0].baseBalance.add(expectedDeltaBase);

            await subject();

            const finalPositionInfo = (await perpLeverageModule.getPositionInfo(subjectSetToken))[0];

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
            subjectQuoteReceiveQuantityUnits = ether(5.15);
          });

          it("long trade should reduce the position", async () => {
            const totalSupply = await setToken.totalSupply();
            const baseTradeQuantityNotional = preciseMul(subjectBaseTradeQuantityUnits, totalSupply);

            const { deltaBase } = await perpSetup.getSwapQuote(
              subjectBaseToken,
              baseTradeQuantityNotional,
              false
            );

            const initialPositionInfo = (await perpLeverageModule.getPositionInfo(subjectSetToken))[0];

            await subject();

            const finalPositionInfo = (await perpLeverageModule.getPositionInfo(subjectSetToken))[0];
            const closeRatio = preciseDiv(baseTradeQuantityNotional, initialPositionInfo.baseBalance);
            const reducedOpenNotional = preciseMul(initialPositionInfo.quoteBalance, closeRatio);

            const expectedBaseBalance = initialPositionInfo.baseBalance.add(deltaBase);
            const expectedQuoteBalance = initialPositionInfo.quoteBalance.add(reducedOpenNotional);

            expect(finalPositionInfo.baseBalance).gt(initialPositionInfo.baseBalance);
            expect(finalPositionInfo.quoteBalance).lt(initialPositionInfo.quoteBalance);

            expect(finalPositionInfo.baseBalance).eq(expectedBaseBalance);
            expect(finalPositionInfo.quoteBalance).eq(expectedQuoteBalance);
          });

          describe("when the position is zeroed out", async () => {
            beforeEach(async () => {
              subjectBaseTradeQuantityUnits = ether(1);
              subjectQuoteReceiveQuantityUnits = ether(10.15);
            });

            it("should remove the position from the positions array", async () => {
              const initialPositionInfo = await perpLeverageModule.getPositionInfo(subjectSetToken);
              await subject();
              const finalPositionInfo = await perpLeverageModule.getPositionInfo(subjectSetToken);

              expect(initialPositionInfo.length).eq(1);
              expect(finalPositionInfo.length).eq(0);
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
            subjectQuoteReceiveQuantityUnits = ether(10.15);
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
            const { quoteBalance } = (await perpLeverageModule.getPositionInfo(subjectSetToken))[0];
            const feeAmountInQuoteDecimals = preciseMul(quoteBalance.abs(), feePercentage);

            const expectedCollateralBalance = initialCollateralBalance.sub(feeAmountInQuoteDecimals);
            expect(toUSDCDecimals(finalCollateralBalance)).to.be.closeTo(toUSDCDecimals(expectedCollateralBalance), 1);
          });

          it("should transfer the correct protocol fee to the protocol", async () => {
            const feeRecipient = await setup.controller.feeRecipient();
            const initialFeeRecipientBalance = await usdc.balanceOf(feeRecipient);

            await subject();

            const { quoteBalance } = (await perpLeverageModule.getPositionInfo(subjectSetToken))[0];
            const feeAmountInQuoteDecimals = preciseMul(quoteBalance.mul(-1), feePercentage);
            const feeAmountInUSDCDecimals = toUSDCDecimals(feeAmountInQuoteDecimals);
            const expectedFeeRecipientBalance = initialFeeRecipientBalance.add(feeAmountInUSDCDecimals);

            const finalFeeRecipientBalance = await usdc.balanceOf(feeRecipient);
            expect(finalFeeRecipientBalance).to.eq(expectedFeeRecipientBalance);
          });

          it("should not change the value of the SetToken USDC defaultPositionUnit", async() => {
            const initialUSDCDefaultPositionUnit = await setToken.getDefaultPositionRealUnit(usdc.address);
            await subject();
            const finalUSDCDefaultPositionUnit = await setToken.getDefaultPositionRealUnit(usdc.address);

            expect(initialUSDCDefaultPositionUnit).to.eq(finalUSDCDefaultPositionUnit);
          });

          it("should emit the correct PerpTrade event", async () => {
            const {
              deltaBase: expectedDeltaBase,
              deltaQuote: expectedDeltaQuote
            } = await perpSetup.getSwapQuote(subjectBaseToken, subjectBaseTradeQuantityUnits, true);

            const expectedProtocolFee = toUSDCDecimals(preciseMul(expectedDeltaQuote, feePercentage));
            const expectedIsBuy = true;

            await expect(subject()).to.emit(perpLeverageModule, "PerpTrade").withArgs(
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
      });

      describe("when short", () => {
        beforeEach(async () => {
          // Short ~10 USDC of vETH
          subjectBaseTradeQuantityUnits = ether(-1);
          subjectQuoteReceiveQuantityUnits = ether(9.85);
        });

        it("should open the expected position", async () => {
          const totalSupply = await setToken.totalSupply();
          const expectedBaseBalance = preciseMul(subjectBaseTradeQuantityUnits, totalSupply);

          const expectedQuoteBalance = (await perpSetup.getSwapQuote(
            subjectBaseToken,
            subjectBaseTradeQuantityUnits.mul(-1),
            false
          )).deltaQuote;

          const initialPositionInfo = await perpLeverageModule.getPositionInfo(subjectSetToken);
          await subject();
          const finalPositionInfo = (await perpLeverageModule.getPositionInfo(subjectSetToken))[0];

          expect(initialPositionInfo.length).to.eq(0);
          expect(finalPositionInfo.baseBalance).lt(0);
          expect(finalPositionInfo.quoteBalance).gt(0);
          expect(finalPositionInfo.baseBalance).eq(expectedBaseBalance);
          expect(finalPositionInfo.quoteBalance).eq(expectedQuoteBalance);
          expect(finalPositionInfo.quoteBalance).gt(subjectQuoteReceiveQuantityUnits);
        });

        it("should emit the correct PerpTrade event", async () => {
          const {
            deltaBase: expectedDeltaBase,
            deltaQuote: expectedDeltaQuote
          } = await perpSetup.getSwapQuote(subjectBaseToken, subjectBaseTradeQuantityUnits.mul(-1), false);

          const expectedProtocolFee = ether(0);
          const expectedIsBuy = false;

          await expect(subject()).to.emit(perpLeverageModule, "PerpTrade").withArgs(
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
            subjectQuoteReceiveQuantityUnits = ether(4.85);
          });

          it("short trade should reduce the position", async () => {
            const totalSupply = await setToken.totalSupply();
            const baseTradeQuantityNotional = preciseMul(subjectBaseTradeQuantityUnits, totalSupply);

            const { deltaBase } = await perpSetup.getSwapQuote(
              subjectBaseToken,
              baseTradeQuantityNotional.mul(-1),
              false
            );

            const initialPositionInfo = (await perpLeverageModule.getPositionInfo(subjectSetToken))[0];

            await subject();

            const finalPositionInfo = (await perpLeverageModule.getPositionInfo(subjectSetToken))[0];
            const closeRatio = preciseDiv(baseTradeQuantityNotional, initialPositionInfo.baseBalance);
            const reducedOpenNotional = preciseMul(initialPositionInfo.quoteBalance, closeRatio);

            const expectedBaseBalance = initialPositionInfo.baseBalance.sub(deltaBase);
            const expectedQuoteBalance = initialPositionInfo.quoteBalance.add(reducedOpenNotional);

            expect(finalPositionInfo.baseBalance).lt(initialPositionInfo.baseBalance);
            expect(finalPositionInfo.quoteBalance).gt(initialPositionInfo.quoteBalance);

            expect(finalPositionInfo.baseBalance).eq(expectedBaseBalance);
            expect(finalPositionInfo.quoteBalance).eq(expectedQuoteBalance);
          });

          describe("when the position is zeroed out", async () => {
            beforeEach(async () => {
              subjectBaseTradeQuantityUnits = ether(-1);
              subjectQuoteReceiveQuantityUnits = ether(9.85);
            });

            it("should remove the position from the positions array", async () => {
              const initialPositionInfo = await perpLeverageModule.getPositionInfo(subjectSetToken);
              await subject();
              const finalPositionInfo = await perpLeverageModule.getPositionInfo(subjectSetToken);

              expect(initialPositionInfo.length).eq(1);
              expect(finalPositionInfo.length).eq(0);
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
            const initialPositionInfo = await perpLeverageModule.getPositionInfo(subjectSetToken);
            const expectedDeltaBase = preciseMul(subjectBaseTradeQuantityUnits, totalSupply);
            const expectedBaseBalance = initialPositionInfo[0].baseBalance.add(expectedDeltaBase);

            await subject();

            const finalPositionInfo = (await perpLeverageModule.getPositionInfo(subjectSetToken))[0];

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
            subjectQuoteReceiveQuantityUnits = ether(9.85);
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
            const { quoteBalance } = (await perpLeverageModule.getPositionInfo(subjectSetToken))[0];
            const feeAmountInQuoteDecimals = preciseMul(quoteBalance, feePercentage);

            const expectedCollateralBalance = initialCollateralBalance.sub(feeAmountInQuoteDecimals);
            expect(toUSDCDecimals(finalCollateralBalance)).to.be.closeTo(toUSDCDecimals(expectedCollateralBalance), 1);
          });
        });

        describe("when slippage is greater than allowed", async () => {
          beforeEach(async () => {
            // Short ~10 USDC of vETH, slippage incurred as smaller positive quote delta
            subjectBaseTradeQuantityUnits = ether(-1);
            subjectQuoteReceiveQuantityUnits = ether(10);
          });

          it("should revert", async () => {
            // ClearingHouse: too little quote received when short
            await expect(subject()).to.be.revertedWith("CH_TLRS");
          });
        });
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

        const issueQuantity = ether(1);
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
      await perpLeverageModule
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


        const expectedCollateralBalance = toUSDCDecimals(initialCollateralBalance).add(subjectDepositQuantity);
        expect(toUSDCDecimals(finalCollateralBalance)).to.eq(expectedCollateralBalance);
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
    let subjectSetToken: SetToken;
    let subjectWithdrawAmount: number;
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

        const issueQuantity = ether(1);
        await usdc.approve(setup.issuanceModule.address, usdcUnits(1000));
        await setup.issuanceModule.initialize(subjectSetToken.address, ADDRESS_ZERO);
        await setup.issuanceModule.issue(subjectSetToken.address, issueQuantity, owner.address);

        // Deposit 10 USDC
        await perpLeverageModule
          .connect(owner.wallet)
          .deposit(subjectSetToken.address, usdcUnits(10));
      }
    };

    const initializeSubjectVariables = (withdrawAmount: number = 5) => {
      subjectWithdrawAmount = withdrawAmount;
      subjectCaller = owner;
      subjectWithdrawQuantity = usdcUnits(withdrawAmount);
    };

    async function subject(): Promise<any> {
      await perpLeverageModule
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

        const expectedCollateralBalance = toUSDCDecimals(initialCollateralBalance).sub(subjectWithdrawQuantity);
        expect(toUSDCDecimals(finalCollateralBalance)).to.eq(expectedCollateralBalance);
      });

      it("should update the USDC defaultPositionUnit", async () => {
        const initialDefaultPosition = await subjectSetToken.getDefaultPositionRealUnit(usdc.address);
        await subject();
        const finalDefaultPosition = await subjectSetToken.getDefaultPositionRealUnit(usdc.address);;

        const expectedDefaultPosition = initialDefaultPosition.add(usdcUnits(subjectWithdrawAmount));
        expect(finalDefaultPosition).to.eq(expectedDefaultPosition);
      });

      it("should update the USDC externalPositionUnit", async () => {
        const initialExternalPositionUnit = await subjectSetToken.getExternalPositionRealUnit(usdc.address, perpLeverageModule.address);
        await subject();
        const finalExternalPositionUnit = await subjectSetToken.getExternalPositionRealUnit(usdc.address, perpLeverageModule.address);

        const expectedExternalPositionUnit = initialExternalPositionUnit.sub(subjectWithdrawQuantity);
        expect(finalExternalPositionUnit).to.eq(expectedExternalPositionUnit);
      });

      describe("when withdraw amount is 0", async () => {
        beforeEach(() => {
          const withdrawAmount = 0;
          initializeSubjectVariables(withdrawAmount);
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("Withdraw amount is 0");
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

      async function calculateUSDCTransferIn() {
        const positionInfo = (await perpLeverageModule.getPositionInfo(subjectSetToken))[0];
        const collateralBalance = (await perpLeverageModule.getAccountInfo(subjectSetToken)).collateralBalance;
        const basePositionUnit = preciseDiv(positionInfo.baseBalance, await setToken.totalSupply());
        const baseTradeQuantityNotional = preciseMul(basePositionUnit, subjectSetQuantity);

        const currentLeverage = await perpSetup.getCurrentLeverage(
          subjectSetToken,
          positionInfo,
          collateralBalance
        );

        const { deltaBase, deltaQuote } = await perpSetup.getSwapQuote(
          baseToken,
          baseTradeQuantityNotional,
          true
        );

        const idealQuote = preciseMul(deltaBase, await perpSetup.getSpotPrice(baseToken));
        const expectedSlippage = idealQuote.sub(deltaQuote).mul(-1);

        return toUSDCDecimals(preciseDiv(idealQuote, currentLeverage).add(expectedSlippage));
      }

      describe("when issuing a single set", async () => {
        let usdcTransferInQuantity: BigNumber;

        beforeEach(async () => {
          // Set up as 2X Long, allow 2% slippage
          baseToken = vETH.address;
          await leverUp(setToken, baseToken, 2, ether(.02), true);
          usdcTransferInQuantity = await calculateUSDCTransferIn();
        });

        it("buys expected amount of vBase", async () => {
          const totalSupply = await setToken.totalSupply();

          const initialBaseBalance = (await perpLeverageModule.getPositionInfo(subjectSetToken))[0].baseBalance;
          await subject();
          const finalBaseBalance = (await perpLeverageModule.getPositionInfo(subjectSetToken))[0].baseBalance;

          const basePositionUnit = preciseDiv(initialBaseBalance, totalSupply);
          const baseTokenBoughtNotional = preciseMul(basePositionUnit, subjectSetQuantity);
          const expectedBaseBalance = initialBaseBalance.add(baseTokenBoughtNotional);

          expect(finalBaseBalance).eq(expectedBaseBalance);
        });

        it("should set the expected USDC externalPositionUnit", async () => {
          const expectedExternalPositionUnit = preciseDiv(usdcTransferInQuantity, subjectSetQuantity);

          await subject();

          const externalPositionUnit = await setToken.getExternalPositionRealUnit(
            usdc.address,
            perpLeverageModule.address
          );

          // Not perfect... needs investigation. Not even consistent??? e.g off by one occasionally
          // 10008085936690386266 vs 10008085658829252928
          expect(externalPositionUnit).to.be.closeTo(expectedExternalPositionUnit, 1);
        });


      });

      describe("when there is positive owedRealizedPnl", async () => {
        beforeEach(async () => {
          // Set up as 2X Long, allow 2% slippage
          baseToken = vETH.address;
          await leverUp(setToken, baseToken, 2, ether(.02), true);

          // Move price up by maker buying 20k USDC of vETH
          // Post trade spot price rises from ~10 USDC to 14_356_833_358_751_766_356
          await perpSetup.clearingHouse.connect(maker.wallet).openPosition({
            baseToken: vETH.address,
            isBaseToQuote: false,     // long
            isExactInput: true,       // `amount` is USDC
            amount: ether(20000),
            oppositeAmountBound: ZERO,
            deadline:  MAX_UINT_256,
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
          const totalSupply = await setToken.totalSupply();
          const owedRealizedPnl = (await perpLeverageModule.getAccountInfo(subjectSetToken)).owedRealizedPnl;
          const owedRealizedPnlUnit = preciseDiv(owedRealizedPnl, totalSupply);
          const owedRealizedPnlDiscountNotional = preciseMul(owedRealizedPnlUnit, subjectSetQuantity);

          const usdcTransferInQuantity = await calculateUSDCTransferIn();

          const expectedExternalPositionUnit = preciseDiv(
            usdcTransferInQuantity.add(toUSDCDecimals(owedRealizedPnlDiscountNotional)),
            subjectSetQuantity
          );

          await subject();

          const externalPositionUnit = await setToken.getExternalPositionRealUnit(
            usdc.address,
            perpLeverageModule.address
          );

          expect(owedRealizedPnl).gt(ether(1));
          expect(externalPositionUnit).to.be.closeTo(expectedExternalPositionUnit, 100);
        });
      });

      describe("when there is negative owedRealizedPnl", async () => {
        beforeEach(async () => {
          // Set up as 2X Long, allow 2% slippage
          baseToken = vETH.address;
          await leverUp(setToken, baseToken, 2, ether(.02), true);

          // Move price down by maker selling 20k USDC of vETH
          // Post trade spot price rises from ~10 USDC to 6_370_910_537_702_299_856
          await perpSetup.clearingHouse.connect(maker.wallet).openPosition({
            baseToken: vETH.address,
            isBaseToQuote: true,       // short
            isExactInput: false,       // `amount` is USDC
            amount: ether(20000),
            oppositeAmountBound: ZERO,
            deadline:  MAX_UINT_256,
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
        });

        it("should set the expected USDC externalPositionUnit", async () => {
          const totalSupply = await setToken.totalSupply();
          const owedRealizedPnl = (await perpLeverageModule.getAccountInfo(subjectSetToken)).owedRealizedPnl;
          const owedRealizedPnlUnit = preciseDiv(owedRealizedPnl, totalSupply);
          const owedRealizedPnlDiscountNotional = preciseMul(owedRealizedPnlUnit, subjectSetQuantity);

          const usdcTransferInQuantity = await calculateUSDCTransferIn();

          const expectedExternalPositionUnit = preciseDiv(
            usdcTransferInQuantity.add(toUSDCDecimals(owedRealizedPnlDiscountNotional)),
            subjectSetQuantity
          );

          await subject();

          const externalPositionUnit = await setToken.getExternalPositionRealUnit(
            usdc.address,
            perpLeverageModule.address
          );

          expect(owedRealizedPnl).lt(ether(1).mul(-1));
          expect(externalPositionUnit).to.be.closeTo(expectedExternalPositionUnit, 100);
        });
      });

      describe("when there is positive pending funding", async () => {
        let usdcTransferInQuantity: BigNumber;

        beforeEach(async () => {
          // Set up as 2X Long, allow 2% slippage
          baseToken = vETH.address;
          await leverUp(setToken, baseToken, 2, ether(.02), true);
          usdcTransferInQuantity = await calculateUSDCTransferIn();
        });

        it("should socialize the funding payment among existing set holders", async () => {
          // Move oracle price down and wait one day
          await perpSetup.setBaseTokenOraclePrice(vETH, "9.5");
          await increaseTimeAsync(ONE_DAY_IN_SECONDS);

          const totalSupply = await setToken.totalSupply();
          const pendingFunding = (await perpLeverageModule.getAccountInfo(subjectSetToken)).pendingFundingPayments;
          const pendingFundingUnit = preciseDiv(pendingFunding, totalSupply);
          const pendingFundingDiscountNotional = preciseMul(pendingFundingUnit, subjectSetQuantity);

          const expectedExternalPositionUnit = preciseDiv(
            usdcTransferInQuantity.add(toUSDCDecimals(pendingFundingDiscountNotional)),
            subjectSetQuantity
          );

          await subject();

          const externalPositionUnit = await setToken.getExternalPositionRealUnit(
            usdc.address,
            perpLeverageModule.address
          );

          expect(pendingFunding).gt(0);
          expect(externalPositionUnit).to.be.closeTo(expectedExternalPositionUnit, 100);
        });
      });

      describe("when there is negative pending funding", async () => {
        let usdcTransferInQuantity: BigNumber;

        beforeEach(async () => {
          // Set up as 2X Long, allow 2% slippage
          baseToken = vETH.address;
          await leverUp(setToken, baseToken, 2, ether(.02), true);
          usdcTransferInQuantity = await calculateUSDCTransferIn();
        });

        it("should socialize the funding payment among existing set holders", async () => {
          // Move oracle price up and wait one day
          await perpSetup.setBaseTokenOraclePrice(vETH, "15");
          await increaseTimeAsync(ONE_DAY_IN_SECONDS);

          const totalSupply = await setToken.totalSupply();
          const pendingFunding = (await perpLeverageModule.getAccountInfo(subjectSetToken)).pendingFundingPayments;
          const pendingFundingUnit = preciseDiv(pendingFunding, totalSupply);
          const pendingFundingDiscountNotional = preciseMul(pendingFundingUnit, subjectSetQuantity);

          const expectedExternalPositionUnit = preciseDiv(
            usdcTransferInQuantity.add(toUSDCDecimals(pendingFundingDiscountNotional)),
            subjectSetQuantity
          );

          await subject();

          const externalPositionUnit = await setToken.getExternalPositionRealUnit(
            usdc.address,
            perpLeverageModule.address
          );

          expect(pendingFunding).lt(ether(1));
          expect(externalPositionUnit).to.be.closeTo(expectedExternalPositionUnit, 100);
        });
      });

      describe("when the market price moves up and leverage drops", async () => {
        beforeEach(async () => {
          // Set up as 2X Long, allow 2% slippage
          baseToken = vETH.address;
          await leverUp(setToken, baseToken, 2, ether(.02), true);
        });

        it("test assumptions and preconditions should be correct", async () => {
          let positionInfo = (await perpLeverageModule.getPositionInfo(subjectSetToken))[0];
          let collateralBalance = (await perpLeverageModule.getAccountInfo(subjectSetToken)).collateralBalance;

          const initialLeverage = await perpSetup.getCurrentLeverage(subjectSetToken, positionInfo, collateralBalance);
          const initialSpotPrice = await perpSetup.getSpotPrice(vETH.address);
          const initialUSDCTransferInQuantity = await calculateUSDCTransferIn();

          await perpSetup.clearingHouse.connect(maker.wallet).openPosition({
            baseToken: vETH.address,
            isBaseToQuote: false,     // long
            isExactInput: true,       // `amount` is USDC
            amount: ether(10000),     // move price up by buying 10k USDC of vETH
            oppositeAmountBound: ZERO,
            deadline:  MAX_UINT_256,
            sqrtPriceLimitX96: ZERO,
            referralCode: ZERO_BYTES
          });

          positionInfo = (await perpLeverageModule.getPositionInfo(subjectSetToken))[0];
          collateralBalance = (await perpLeverageModule.getAccountInfo(subjectSetToken)).collateralBalance;

          const finalLeverage = await perpSetup.getCurrentLeverage(subjectSetToken, positionInfo, collateralBalance);
          const finalSpotPrice = await perpSetup.getSpotPrice(vETH.address);
          const finalUSDCTransferInQuantity = await calculateUSDCTransferIn();

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
            deadline:  MAX_UINT_256,
            sqrtPriceLimitX96: ZERO,
            referralCode: ZERO_BYTES
          });

          const initialBaseBalance = (await perpLeverageModule.getPositionInfo(subjectSetToken))[0].baseBalance;
          await subject();
          const finalBaseBalance = (await perpLeverageModule.getPositionInfo(subjectSetToken))[0].baseBalance;

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
            amount: ether(10000),     // move price up by buying 10k USDC of vETH
            oppositeAmountBound: ZERO,
            deadline:  MAX_UINT_256,
            sqrtPriceLimitX96: ZERO,
            referralCode: ZERO_BYTES
          });

          const usdcTransferInQuantity = await calculateUSDCTransferIn();

          const expectedExternalPositionUnit = preciseDiv(usdcTransferInQuantity, subjectSetQuantity);
          await subject();
          const actualExternalPositionUnit = await setToken.getExternalPositionRealUnit(
            usdc.address,
            perpLeverageModule.address
          );

          expect(actualExternalPositionUnit).to.be.closeTo(expectedExternalPositionUnit, 100);
        });
      });

      describe("when issuing multiple sets", async () => {
        let usdcTransferInQuantity: BigNumber;

        beforeEach(async () => {
          // Set up as 2X Long, allow 2% slippage
          baseToken = vETH.address;
          subjectSetQuantity = ether(2);

          await leverUp(setToken, baseToken, 2, ether(.02), true);
          usdcTransferInQuantity = await calculateUSDCTransferIn();
        });

        it("buys expected amount of vETH, vBTC", async () => {
          const totalSupply = await setToken.totalSupply();
          const initialPositionInfo = await perpLeverageModule.getPositionInfo(subjectSetToken);
          const initialBalance = initialPositionInfo[0].baseBalance;

          await subject();

          const finalPositionInfo = await perpLeverageModule.getPositionInfo(subjectSetToken);
          const finalBalance = finalPositionInfo[0].baseBalance;

          const basePositionUnit = preciseDiv(initialBalance, totalSupply);
          const baseBoughtNotional = preciseMul(basePositionUnit, subjectSetQuantity);

          const expectedBalance = initialBalance.add(baseBoughtNotional);

          expect(finalBalance).eq(expectedBalance);
        });

        it("should set the expected USDC externalPositionUnit", async () => {
          const expectedExternalPositionUnit = preciseDiv(usdcTransferInQuantity, subjectSetQuantity);

          await subject();

          const externalPositionUnit = await setToken.getExternalPositionRealUnit(
            usdc.address,
            perpLeverageModule.address
          );

          expect(externalPositionUnit).to.be.closeTo(expectedExternalPositionUnit, 1);
        });
      });
    });

    describe("when long, multiple positions", async () => {
      async function calculateUSDCTransferOut() {
        const totalSupply = await setToken.totalSupply();
        const positionInfo = await perpLeverageModule.getPositionInfo(subjectSetToken);
        const collateralBalance = (await perpLeverageModule.getAccountInfo(subjectSetToken)).collateralBalance;
        const netQuoteBalance = await perpSetup.accountBalance.getNetQuoteBalance(subjectSetToken);

        const vETHPositionInfo = positionInfo[0];
        const vBTCPositionInfo = positionInfo[1];

        const vETHPositionUnit = preciseDiv(vETHPositionInfo.baseBalance, totalSupply);
        const vETHTradeQuantityNotional = preciseMul(vETHPositionUnit, subjectSetQuantity);

        const vBTCPositionUnit = preciseDiv(vBTCPositionInfo.baseBalance, totalSupply);
        const vBTCTradeQuantityNotional = preciseMul(vBTCPositionUnit, subjectSetQuantity);

        const vETHSpotPrice = await perpSetup.getSpotPrice(vETHPositionInfo.baseToken);
        const vBTCSpotPrice = await perpSetup.getSpotPrice(vBTCPositionInfo.baseToken);

        const vETHIdealQuote = preciseMul(vETHTradeQuantityNotional, vETHSpotPrice);
        const vBTCIdealQuote = preciseMul(vBTCTradeQuantityNotional, vBTCSpotPrice);

        const vETHPositionValue = preciseMul(vETHPositionInfo.baseBalance, vETHSpotPrice).abs();
        const vBTCPositionValue = preciseMul(vBTCPositionInfo.baseBalance, vBTCSpotPrice).abs();

        const totalPositionValue = vETHPositionValue.add(vBTCPositionValue);

        const currentLeverage = preciseDiv(
          totalPositionValue,

          totalPositionValue
            .add(netQuoteBalance)
            .add(collateralBalance)
        );

        const { deltaQuote: vETHDeltaQuote } = await perpSetup.getSwapQuote(
          vETHPositionInfo.baseToken,
          vETHTradeQuantityNotional,
          true
        );

        const { deltaQuote: vBTCDeltaQuote } = await perpSetup.getSwapQuote(
          vBTCPositionInfo.baseToken,
          vBTCTradeQuantityNotional,
          true
        );

        const vETHExpectedSlippage = vETHIdealQuote.sub(vETHDeltaQuote).mul(-1);
        const vBTCExpectedSlippage = vBTCIdealQuote.sub(vBTCDeltaQuote).mul(-1);

        const vETHTotal = preciseDiv(vETHIdealQuote, currentLeverage).add(vETHExpectedSlippage);
        const vBTCTotal = preciseDiv(vBTCIdealQuote, currentLeverage).add(vBTCExpectedSlippage);

        return toUSDCDecimals(vETHTotal.add(vBTCTotal));
      }

      cacheBeforeEach(async () => {
        await leverUp(setToken, vETH.address, 2, ether(.02), true);
        await leverUp(setToken, vBTC.address, 1, ether(.02), true);
      });

      describe("when issuing a single set", async () => {
        let usdcTransferOutQuantity: BigNumber;

        beforeEach(async () => {
          usdcTransferOutQuantity = await calculateUSDCTransferOut();
        });

        it("buys expected amount of vETH, vBTC", async () => {
          const totalSupply = await setToken.totalSupply();
          const initialPositionInfo = await perpLeverageModule.getPositionInfo(subjectSetToken);

          const initialVETHBalance = initialPositionInfo[0].baseBalance;
          const initialVBTCBalance = initialPositionInfo[1].baseBalance;

          await subject();

          const finalPositionInfo = await perpLeverageModule.getPositionInfo(subjectSetToken);
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
          const expectedExternalPositionUnit = preciseDiv(usdcTransferOutQuantity, subjectSetQuantity);

          await subject();

          const externalPositionUnit = await setToken.getExternalPositionRealUnit(
            usdc.address,
            perpLeverageModule.address
          );

          expect(externalPositionUnit).to.be.closeTo(expectedExternalPositionUnit, 3);
        });
      });

      describe("when issuing multiple sets", async () => {
        let usdcTransferOutQuantity: BigNumber;

        beforeEach(async () => {
          subjectSetQuantity = ether(2);

          // Deposit more collateral to avoid NEFC error
          await perpLeverageModule.deposit(subjectSetToken, usdcUnits(30));
          usdcTransferOutQuantity = await calculateUSDCTransferOut();
        });

        it("buys expected amount of vETH, vBTC", async () => {
          const totalSupply = await setToken.totalSupply();
          const initialPositionInfo = await perpLeverageModule.getPositionInfo(subjectSetToken);

          const initialVETHBalance = initialPositionInfo[0].baseBalance;
          const initialVBTCBalance = initialPositionInfo[1].baseBalance;

          await subject();

          const finalPositionInfo = await perpLeverageModule.getPositionInfo(subjectSetToken);
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
          const expectedExternalPositionUnit = preciseDiv(usdcTransferOutQuantity, subjectSetQuantity);

          await subject();

          const externalPositionUnit = await setToken.getExternalPositionRealUnit(
            usdc.address,
            perpLeverageModule.address
          );

          expect(externalPositionUnit).to.be.closeTo(expectedExternalPositionUnit, 3);
        });
      });

      describe("when there is positive pending funding", async () => {
        let usdcTransferOutQuantity: BigNumber;

        beforeEach(async () => {
          usdcTransferOutQuantity = await calculateUSDCTransferOut();
        });

        it("should socialize the funding payment among existing set holders", async () => {
          // Move oracle price down and wait one day
          await perpSetup.setBaseTokenOraclePrice(vETH, "9.8");
          await perpSetup.setBaseTokenOraclePrice(vBTC, "19.9");

          await increaseTimeAsync(ONE_DAY_IN_SECONDS);
          const pendingFunding = (await perpLeverageModule.getAccountInfo(subjectSetToken)).pendingFundingPayments;
          const pendingFundingUnit = preciseDiv(pendingFunding, await setToken.totalSupply());
          const pendingFundingNotionalShare = preciseMul(pendingFundingUnit, subjectSetQuantity);

          const expectedExternalPositionUnit = preciseDiv(
            usdcTransferOutQuantity.add(toUSDCDecimals(pendingFundingNotionalShare)),
            subjectSetQuantity
          );

          await subject();

          const externalPositionUnit = await setToken.getExternalPositionRealUnit(
            usdc.address,
            perpLeverageModule.address
          );

          expect(pendingFunding).gt(0);
          expect(externalPositionUnit).to.be.closeTo(expectedExternalPositionUnit, 100);
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
            deadline:  MAX_UINT_256,
            sqrtPriceLimitX96: ZERO,
            referralCode: ZERO_BYTES
          });

          await perpSetup.clearingHouse.connect(maker.wallet).openPosition({
            baseToken: vBTC.address,
            isBaseToQuote: false,     // long
            isExactInput: true,       // `amount` is USDC
            amount: ether(20000),
            oppositeAmountBound: ZERO,
            deadline:  MAX_UINT_256,
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
          const owedRealizedPnlUnit = preciseDiv(owedRealizedPnl, await setToken.totalSupply());
          const owedRealizedPnlShareNotional = preciseMul(owedRealizedPnlUnit, subjectSetQuantity);

          const usdcTransferOutQuantity = await calculateUSDCTransferOut();

          const expectedExternalPositionUnit = preciseDiv(
            usdcTransferOutQuantity.add(toUSDCDecimals(owedRealizedPnlShareNotional)),
            subjectSetQuantity
          );

          await subject();

          const externalPositionUnit = await setToken.getExternalPositionRealUnit(
            usdc.address,
            perpLeverageModule.address
          );

          expect(owedRealizedPnl).gt(ether(1));
          expect(externalPositionUnit).to.be.closeTo(expectedExternalPositionUnit, 200);
        });
      });
    });

    describe("when short", async () => {
      let baseToken: Address;

      async function calculateUSDCTransferIn() {
        const positionInfo = (await perpLeverageModule.getPositionInfo(subjectSetToken))[0];
        const collateralBalance = (await perpLeverageModule.getAccountInfo(subjectSetToken)).collateralBalance;
        const basePositionUnit = preciseDiv(positionInfo.baseBalance, await setToken.totalSupply());
        const baseTradeQuantityNotional = preciseMul(basePositionUnit, subjectSetQuantity);

        const currentLeverage = await perpSetup.getCurrentLeverage(
          subjectSetToken,
          positionInfo,
          collateralBalance
        );

        const { deltaBase, deltaQuote } = await perpSetup.getSwapQuote(
          baseToken,
          baseTradeQuantityNotional.abs(),
          false
        );

        const idealQuote = preciseMul(deltaBase, await perpSetup.getSpotPrice(baseToken));
        const expectedSlippage = idealQuote.sub(deltaQuote);

        return toUSDCDecimals(preciseDiv(idealQuote, currentLeverage).add(expectedSlippage));
      }

      async function subject(): Promise<any> {
        await perpLeverageModule
          .connect(subjectCaller.wallet)
          .moduleIssueHook(subjectSetToken, subjectSetQuantity);
      }

      describe("when issuing a single set", async () => {
        let usdcTransferInQuantity: BigNumber;

        beforeEach(async () => {
          // Set up as 2X Short, allow 2% slippage
          baseToken = vETH.address;
          await leverUp(setToken, baseToken, 2, ether(.02), false);
          usdcTransferInQuantity = await calculateUSDCTransferIn();
        });

        it("shorts expected amount of vBase", async () => {
          const totalSupply = await setToken.totalSupply();

          const initialBaseBalance = (await perpLeverageModule.getPositionInfo(subjectSetToken))[0].baseBalance;
          await subject();
          const finalBaseBalance = (await perpLeverageModule.getPositionInfo(subjectSetToken))[0].baseBalance;

          const basePositionUnit = preciseDiv(initialBaseBalance, totalSupply);
          const baseTokenSoldNotional = preciseMul(basePositionUnit, subjectSetQuantity);
          const expectedBaseBalance = initialBaseBalance.add(baseTokenSoldNotional);

          expect(finalBaseBalance).eq(expectedBaseBalance);
        });

        it("should set the expected USDC externalPositionUnit", async () => {
          const expectedExternalPositionUnit = preciseDiv(usdcTransferInQuantity, subjectSetQuantity);

          await subject();

          const externalPositionUnit = await setToken.getExternalPositionRealUnit(
            usdc.address,
            perpLeverageModule.address
          );

          expect(externalPositionUnit).to.be.closeTo(expectedExternalPositionUnit, 1);
        });
      });

      describe("when there is positive owedRealizedPnl", async () => {
        beforeEach(async () => {
          // Set up as 2X short, allow 2% slippage
          baseToken = vETH.address;
          await leverUp(setToken, baseToken, 2, ether(.02), false);

          // Move price down by maker selling 10k USDC of vETH
          await perpSetup.clearingHouse.connect(maker.wallet).openPosition({
            baseToken: vETH.address,
            isBaseToQuote: true,     // short
            isExactInput: false,     // `amount` is USDC
            amount: ether(10000),
            oppositeAmountBound: ZERO,
            deadline:  MAX_UINT_256,
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
          const totalSupply = await setToken.totalSupply();
          const owedRealizedPnl = (await perpLeverageModule.getAccountInfo(subjectSetToken)).owedRealizedPnl;
          const owedRealizedPnlUnit = preciseDiv(owedRealizedPnl, totalSupply);
          const owedRealizedPnlDiscountNotional = preciseMul(owedRealizedPnlUnit, subjectSetQuantity);

          const usdcTransferInQuantity = await calculateUSDCTransferIn();

          const expectedExternalPositionUnit = preciseDiv(
            usdcTransferInQuantity.add(toUSDCDecimals(owedRealizedPnlDiscountNotional)),
            subjectSetQuantity
          );

          await subject();

          const externalPositionUnit = await setToken.getExternalPositionRealUnit(
            usdc.address,
            perpLeverageModule.address
          );

          expect(owedRealizedPnl).gt(0);
          expect(externalPositionUnit).to.be.closeTo(expectedExternalPositionUnit, 100);
        });
      });

      describe("when there is negative owedRealizedPnl", async () => {
        beforeEach(async () => {
          // Set up as 2X Short, allow 2% slippage
          baseToken = vETH.address;
          await leverUp(setToken, baseToken, 2, ether(.02), false);

          // Move price up by maker buying 20k USDC of vETH
          await perpSetup.clearingHouse.connect(maker.wallet).openPosition({
            baseToken: vETH.address,
            isBaseToQuote: false,       // long
            isExactInput: true,         // `amount` is USDC
            amount: ether(10000),
            oppositeAmountBound: ZERO,
            deadline:  MAX_UINT_256,
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
          const totalSupply = await setToken.totalSupply();
          const owedRealizedPnl = (await perpLeverageModule.getAccountInfo(subjectSetToken)).owedRealizedPnl;
          const owedRealizedPnlUnit = preciseDiv(owedRealizedPnl, totalSupply);
          const owedRealizedPnlDiscountNotional = preciseMul(owedRealizedPnlUnit, subjectSetQuantity);

          const usdcTransferInQuantity = await calculateUSDCTransferIn();

          const expectedExternalPositionUnit = preciseDiv(
            usdcTransferInQuantity.add(toUSDCDecimals(owedRealizedPnlDiscountNotional)),
            subjectSetQuantity
          );

          await subject();

          const externalPositionUnit = await setToken.getExternalPositionRealUnit(
            usdc.address,
            perpLeverageModule.address
          );

          expect(owedRealizedPnl).lt(0);
          expect(externalPositionUnit).to.be.closeTo(expectedExternalPositionUnit, 100);
        });
      });

      describe("when there is positive pending funding", async () => {
        beforeEach(async () => {
          // Set up as 2X Short, allow 2% slippage
          baseToken = vETH.address;
          await leverUp(setToken, baseToken, 2, ether(.02), false);
        });

        it("should socialize the funding payment among existing set holders", async () => {
          // Move oracle price up and wait one day
          await perpSetup.setBaseTokenOraclePrice(vETH, "10.5");
          await increaseTimeAsync(ONE_DAY_IN_SECONDS);

          const totalSupply = await setToken.totalSupply();
          const pendingFunding = (await perpLeverageModule.getAccountInfo(subjectSetToken)).pendingFundingPayments;
          const pendingFundingUnit = preciseDiv(pendingFunding, totalSupply);
          const pendingFundingDiscountNotional = preciseMul(pendingFundingUnit, subjectSetQuantity);
          const usdcTransferInQuantity = await calculateUSDCTransferIn();

          // pending funding discount is positive here, we expect set to be slightly more expensive
          const expectedExternalPositionUnit = preciseDiv(
            usdcTransferInQuantity.add(toUSDCDecimals(pendingFundingDiscountNotional)),
            subjectSetQuantity
          );

          await subject();

          const externalPositionUnit = await setToken.getExternalPositionRealUnit(
            usdc.address,
            perpLeverageModule.address
          );

          expect(pendingFunding).gt(0);
          expect(externalPositionUnit).to.be.closeTo(expectedExternalPositionUnit, 100);
        });
      });

      describe("when there is negative pending funding", async () => {
        beforeEach(async () => {
          // Set up as 2X Short, allow 2% slippage
          baseToken = vETH.address;
          await leverUp(setToken, baseToken, 2, ether(.02), false);
        });

        it("should socialize the funding payment among existing set holders", async () => {
          // Move oracle price down and wait one day
          await perpSetup.setBaseTokenOraclePrice(vETH, "5");
          await increaseTimeAsync(ONE_DAY_IN_SECONDS);

          const totalSupply = await setToken.totalSupply();
          const pendingFunding = (await perpLeverageModule.getAccountInfo(subjectSetToken)).pendingFundingPayments;
          const pendingFundingUnit = preciseDiv(pendingFunding, totalSupply);
          const pendingFundingDiscountNotional = preciseMul(pendingFundingUnit, subjectSetQuantity);

          const usdcTransferInQuantity = await calculateUSDCTransferIn();

          // pending funding discount is negative here, we expect set to be slightly less expensive
          const expectedExternalPositionUnit = preciseDiv(
            usdcTransferInQuantity.add(toUSDCDecimals(pendingFundingDiscountNotional)),
            subjectSetQuantity
          );

          await subject();

          const externalPositionUnit = await setToken.getExternalPositionRealUnit(
            usdc.address,
            perpLeverageModule.address
          );

          expect(pendingFunding).lt(ether(1));
          expect(externalPositionUnit).to.be.closeTo(expectedExternalPositionUnit, 100);
        });
      });

      describe("when the market price moves down and leverage drops", async () => {
        beforeEach(async () => {
          // Set up as 2X Short, allow 2% slippage
          baseToken = vETH.address;
          await leverUp(setToken, baseToken, 2, ether(.02), false);
        });

        it("test assumptions and preconditions should be correct", async () => {
          let positionInfo = (await perpLeverageModule.getPositionInfo(subjectSetToken))[0];
          let collateralBalance = (await perpLeverageModule.getAccountInfo(subjectSetToken)).collateralBalance;

          const initialLeverage = await perpSetup.getCurrentLeverage(subjectSetToken, positionInfo, collateralBalance);
          const initialSpotPrice = await perpSetup.getSpotPrice(vETH.address);
          const initialUSDCTransferInQuantity = await calculateUSDCTransferIn();

          await perpSetup.clearingHouse.connect(maker.wallet).openPosition({
            baseToken: vETH.address,
            isBaseToQuote: true,       // short
            isExactInput: false,       // `amount` is USDC
            amount: ether(10000),      // move price down by selling 10k USDC of vETH
            oppositeAmountBound: ZERO,
            deadline:  MAX_UINT_256,
            sqrtPriceLimitX96: ZERO,
            referralCode: ZERO_BYTES
          });

          positionInfo = (await perpLeverageModule.getPositionInfo(subjectSetToken))[0];
          collateralBalance = (await perpLeverageModule.getAccountInfo(subjectSetToken)).collateralBalance;

          const finalLeverage = await perpSetup.getCurrentLeverage(subjectSetToken, positionInfo, collateralBalance);
          const finalSpotPrice = await perpSetup.getSpotPrice(vETH.address);
          const finalUSDCTransferInQuantity = await calculateUSDCTransferIn();

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
            deadline:  MAX_UINT_256,
            sqrtPriceLimitX96: ZERO,
            referralCode: ZERO_BYTES
          });

          const initialBaseBalance = (await perpLeverageModule.getPositionInfo(subjectSetToken))[0].baseBalance;
          await subject();
          const finalBaseBalance = (await perpLeverageModule.getPositionInfo(subjectSetToken))[0].baseBalance;

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
            deadline:  MAX_UINT_256,
            sqrtPriceLimitX96: ZERO,
            referralCode: ZERO_BYTES
          });

          const usdcTransferInQuantity = await calculateUSDCTransferIn();
          const expectedExternalPositionUnit = preciseDiv(usdcTransferInQuantity, subjectSetQuantity);

          await subject();

          const externalPositionUnit = await setToken.getExternalPositionRealUnit(
            usdc.address,
            perpLeverageModule.address
          );

          expect(externalPositionUnit).to.be.closeTo(expectedExternalPositionUnit, 100);
        });
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

      async function calculateUSDCTransferOut() {
        const positionInfo = (await perpLeverageModule.getPositionInfo(subjectSetToken))[0];
        const collateralBalance = (await perpLeverageModule.getAccountInfo(subjectSetToken)).collateralBalance;
        const basePositionUnit = preciseDiv(positionInfo.baseBalance, await setToken.totalSupply());
        const baseTradeQuantityNotional = preciseMul(basePositionUnit, subjectSetQuantity);

        const currentLeverage = await perpSetup.getCurrentLeverage(
          subjectSetToken,
          positionInfo,
          collateralBalance
        );

        const { deltaBase, deltaQuote } = await perpSetup.getSwapQuote(
          baseToken,
          baseTradeQuantityNotional,
          false
        );

        const idealQuote = preciseMul(deltaBase, await perpSetup.getSpotPrice(baseToken));

        const expectedSlippage = deltaQuote.sub(idealQuote);

        return toUSDCDecimals(preciseDiv(idealQuote, currentLeverage).add(expectedSlippage));
      }

      describe("when redeeming a single set", async () => {
        let usdcTransferOutQuantity: BigNumber;

        beforeEach(async () => {
          // Set up as 2X Long, allow 2% slippage
          baseToken = vETH.address;
          await leverUp(setToken, baseToken, 2, ether(.02), true);
          usdcTransferOutQuantity = await calculateUSDCTransferOut();
        });

        it("sells expected amount of vBase", async () => {
          const totalSupply = await setToken.totalSupply();

          const initialBaseBalance = (await perpLeverageModule.getPositionInfo(subjectSetToken))[0].baseBalance;
          await subject();
          const finalBaseBalance = (await perpLeverageModule.getPositionInfo(subjectSetToken))[0].baseBalance;

          const basePositionUnit = preciseDiv(initialBaseBalance, totalSupply);
          const baseTokenBoughtNotional = preciseMul(basePositionUnit, subjectSetQuantity);
          const expectedBaseBalance = initialBaseBalance.sub(baseTokenBoughtNotional);

          expect(finalBaseBalance).eq(expectedBaseBalance);
        });

        it("should set the expected USDC externalPositionUnit", async () => {
          const expectedExternalPositionUnit = preciseDiv(usdcTransferOutQuantity, subjectSetQuantity);

          await subject();

          const externalPositionUnit = await setToken.getExternalPositionRealUnit(
            usdc.address,
            perpLeverageModule.address
          );

          expect(externalPositionUnit).to.be.closeTo(expectedExternalPositionUnit, 1);
        });
      });

      describe("when there is positive owedRealizedPnl", async () => {
        beforeEach(async () => {
          // Set up as 2X Long, allow 2% slippage
          baseToken = vETH.address;
          await leverUp(setToken, baseToken, 2, ether(.02), true);

          // Move price up by maker buying 20k USDC of vETH
          // Post trade spot price rises from ~10 USDC to 14_356_833_358_751_766_356
          await perpSetup.clearingHouse.connect(maker.wallet).openPosition({
            baseToken: vETH.address,
            isBaseToQuote: false,     // long
            isExactInput: true,       // `amount` is USDC
            amount: ether(20000),
            oppositeAmountBound: ZERO,
            deadline:  MAX_UINT_256,
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
          const owedRealizedPnlUnit = preciseDiv(owedRealizedPnl, await setToken.totalSupply());
          const owedRealizedPnlShareNotional = preciseMul(owedRealizedPnlUnit, subjectSetQuantity);

          const usdcTransferOutQuantity = await calculateUSDCTransferOut();

          const expectedExternalPositionUnit = preciseDiv(
            usdcTransferOutQuantity.add(toUSDCDecimals(owedRealizedPnlShareNotional)),
            subjectSetQuantity
          );

          await subject();

          const externalPositionUnit = await setToken.getExternalPositionRealUnit(
            usdc.address,
            perpLeverageModule.address
          );

          expect(owedRealizedPnl).gt(ether(1));
          expect(externalPositionUnit).to.be.closeTo(expectedExternalPositionUnit, 100);
        });
      });

      describe("when there is negative owedRealizedPnl", async () => {
        beforeEach(async () => {
          // Set up as 2X Long, allow 2% slippage
          baseToken = vETH.address;
          await leverUp(setToken, baseToken, 2, ether(.02), true);

          // Move price down by maker selling 20k USDC of vETH
          // Post trade spot price rises from ~10 USDC to 6_370_910_537_702_299_856
          await perpSetup.clearingHouse.connect(maker.wallet).openPosition({
            baseToken: vETH.address,
            isBaseToQuote: true,       // short
            isExactInput: false,       // `amount` is USDC
            amount: ether(10000),
            oppositeAmountBound: ZERO,
            deadline:  MAX_UINT_256,
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
          const owedRealizedPnlUnit = preciseDiv(owedRealizedPnl, await setToken.totalSupply());
          const owedRealizedPnlShareNotional = preciseMul(owedRealizedPnlUnit, subjectSetQuantity);

          const usdcTransferOutQuantity = await calculateUSDCTransferOut();

          const expectedExternalPositionUnit = preciseDiv(
            usdcTransferOutQuantity.add(toUSDCDecimals(owedRealizedPnlShareNotional)),
            subjectSetQuantity
          );

          await subject();

          const externalPositionUnit = await setToken.getExternalPositionRealUnit(
            usdc.address,
            perpLeverageModule.address
          );

          expect(owedRealizedPnl).lt(0);
          expect(externalPositionUnit).to.be.closeTo(expectedExternalPositionUnit, 100);
        });
      });

      describe("when there is positive pending funding", async () => {
        let usdcTransferOutQuantity: BigNumber;

        beforeEach(async () => {
          // Set up as 2X Long, allow 2% slippage
          baseToken = vETH.address;
          await leverUp(setToken, baseToken, 2, ether(.02), true);
          usdcTransferOutQuantity = await calculateUSDCTransferOut();
        });

        it("should socialize the funding payment among existing set holders", async () => {
          // Move oracle price down and wait one day
          await perpSetup.setBaseTokenOraclePrice(vETH, "9.5");
          await increaseTimeAsync(ONE_DAY_IN_SECONDS);
          const pendingFunding = (await perpLeverageModule.getAccountInfo(subjectSetToken)).pendingFundingPayments;
          const pendingFundingUnit = preciseDiv(pendingFunding, await setToken.totalSupply());
          const pendingFundingNotionalShare = preciseMul(pendingFundingUnit, subjectSetQuantity);

          const expectedExternalPositionUnit = preciseDiv(
            usdcTransferOutQuantity.add(toUSDCDecimals(pendingFundingNotionalShare)),
            subjectSetQuantity
          );

          await subject();

          const externalPositionUnit = await setToken.getExternalPositionRealUnit(
            usdc.address,
            perpLeverageModule.address
          );

          expect(pendingFunding).gt(0);
          expect(externalPositionUnit).to.be.closeTo(expectedExternalPositionUnit, 100);
        });
      });

      describe("when there is negative pending funding", async () => {
        let usdcTransferOutQuantity: BigNumber;

        beforeEach(async () => {
          // Set up as 2X Long, allow 2% slippage
          baseToken = vETH.address;
          await leverUp(setToken, baseToken, 2, ether(.02), true);
          usdcTransferOutQuantity = await calculateUSDCTransferOut();
        });

        it("should socialize the funding payment among existing set holders", async () => {
          // Move oracle price up and wait one day
          await perpSetup.setBaseTokenOraclePrice(vETH, "15");
          await increaseTimeAsync(ONE_DAY_IN_SECONDS);
          const pendingFunding = (await perpLeverageModule.getAccountInfo(subjectSetToken)).pendingFundingPayments;
          const pendingFundingUnit = preciseDiv(pendingFunding, await setToken.totalSupply());
          const pendingFundingNotionalShare = preciseMul(pendingFundingUnit, subjectSetQuantity);

          const expectedExternalPositionUnit = preciseDiv(
            usdcTransferOutQuantity.add(toUSDCDecimals(pendingFundingNotionalShare)),
            subjectSetQuantity
          );

          await subject();

          const externalPositionUnit = await setToken.getExternalPositionRealUnit(
            usdc.address,
            perpLeverageModule.address
          );

          expect(pendingFunding).lt(ether(1));
          expect(externalPositionUnit).to.be.closeTo(expectedExternalPositionUnit, 100);
        });
      });

      describe("when the market price moves up and leverage drops", async () => {
        beforeEach(async () => {
          // Set up as 2X Long, allow 2% slippage
          baseToken = vETH.address;
          await leverUp(setToken, baseToken, 2, ether(.02), true);
        });

        it("test assumptions and preconditions should be correct", async () => {
          let positionInfo = (await perpLeverageModule.getPositionInfo(subjectSetToken))[0];
          let collateralBalance = (await perpLeverageModule.getAccountInfo(subjectSetToken)).collateralBalance;

          const initialLeverage = await perpSetup.getCurrentLeverage(subjectSetToken, positionInfo, collateralBalance);
          const initialSpotPrice = await perpSetup.getSpotPrice(vETH.address);
          const initialUSDCTransferOutQuantity = await calculateUSDCTransferOut();

          await perpSetup.clearingHouse.connect(maker.wallet).openPosition({
            baseToken: vETH.address,
            isBaseToQuote: false,     // long
            isExactInput: true,       // `amount` is USDC
            amount: ether(10000),     // move price up by buying 10k USDC of vETH
            oppositeAmountBound: ZERO,
            deadline:  MAX_UINT_256,
            sqrtPriceLimitX96: ZERO,
            referralCode: ZERO_BYTES
          });

          positionInfo = (await perpLeverageModule.getPositionInfo(subjectSetToken))[0];
          collateralBalance = (await perpLeverageModule.getAccountInfo(subjectSetToken)).collateralBalance;

          const finalLeverage = await perpSetup.getCurrentLeverage(subjectSetToken, positionInfo, collateralBalance);
          const finalSpotPrice = await perpSetup.getSpotPrice(vETH.address);
          const finalUSDCTransferOutQuantity = await calculateUSDCTransferOut();

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
            deadline:  MAX_UINT_256,
            sqrtPriceLimitX96: ZERO,
            referralCode: ZERO_BYTES
          });

          const initialBaseBalance = (await perpLeverageModule.getPositionInfo(subjectSetToken))[0].baseBalance;
          await subject();
          const finalBaseBalance = (await perpLeverageModule.getPositionInfo(subjectSetToken))[0].baseBalance;

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
            deadline:  MAX_UINT_256,
            sqrtPriceLimitX96: ZERO,
            referralCode: ZERO_BYTES
          });

          const usdcTransferOutQuantity = await calculateUSDCTransferOut();
          const expectedExternalPositionUnit = preciseDiv(usdcTransferOutQuantity, subjectSetQuantity);

          await subject();

          const actualExternalPositionUnit = await setToken.getExternalPositionRealUnit(
            usdc.address,
            perpLeverageModule.address
          );

          expect(actualExternalPositionUnit).to.be.closeTo(expectedExternalPositionUnit, 100);
        });
      });

      describe("when issuing multiple sets", async () => {
        let usdcTransferOutQuantity: BigNumber;

        beforeEach(async () => {
          // Set up as 2X Long, allow 2% slippage
          baseToken = vETH.address;
          subjectSetQuantity = ether(2);

          await leverUp(setToken, baseToken, 2, ether(.02), true);
          usdcTransferOutQuantity = await calculateUSDCTransferOut();
        });

        it("should set the expected USDC externalPositionUnit", async () => {
          const expectedExternalPositionUnit = preciseDiv(usdcTransferOutQuantity, subjectSetQuantity);

          await subject();

          const externalPositionUnit = await setToken.getExternalPositionRealUnit(
            usdc.address,
            perpLeverageModule.address
          );

          expect(externalPositionUnit).to.be.closeTo(expectedExternalPositionUnit, 1);
        });
      });
    });

    describe("when long, multiple positions", async () => {
      async function calculateUSDCTransferOut() {
        const totalSupply = await setToken.totalSupply();
        const positionInfo = await perpLeverageModule.getPositionInfo(subjectSetToken);
        const collateralBalance = (await perpLeverageModule.getAccountInfo(subjectSetToken)).collateralBalance;

        const vETHPositionInfo = positionInfo[0];
        const vBTCPositionInfo = positionInfo[1];

        const vETHPositionUnit = preciseDiv(vETHPositionInfo.baseBalance, totalSupply);
        const vETHTradeQuantityNotional = preciseMul(vETHPositionUnit, subjectSetQuantity);

        const vBTCPositionUnit = preciseDiv(vBTCPositionInfo.baseBalance, totalSupply);
        const vBTCTradeQuantityNotional = preciseMul(vBTCPositionUnit, subjectSetQuantity);

        const collateralPositionUnit = preciseDiv(collateralBalance, await setToken.totalSupply());
        const collateralQuantityNotional = preciseMul(collateralPositionUnit, subjectSetQuantity);

        const vETHCloseRatio = preciseDiv(vETHTradeQuantityNotional, vETHPositionInfo.baseBalance);
        const vBTCCloseRatio = preciseDiv(vBTCTradeQuantityNotional, vBTCPositionInfo.baseBalance);

        const vETHReducedOpenNotional = preciseMul(vETHPositionInfo.quoteBalance, vETHCloseRatio);
        const vBTCReducedOpenNotional = preciseMul(vBTCPositionInfo.quoteBalance, vBTCCloseRatio);

        const { deltaQuote: vETHDeltaQuote } = await perpSetup.getSwapQuote(
          vETHPositionInfo.baseToken,
          vETHTradeQuantityNotional.abs(),
          false
        );

        const { deltaQuote: vBTCDeltaQuote } = await perpSetup.getSwapQuote(
          vBTCPositionInfo.baseToken,
          vBTCTradeQuantityNotional.abs(),
          false
        );

        const vETHRealizedPnl = (vETHPositionUnit.gte(ZERO))
          ? vETHReducedOpenNotional.add(vETHDeltaQuote)
          : vETHReducedOpenNotional.sub(vETHDeltaQuote);

        const vBTCRealizedPnl = (vETHPositionUnit.gte(ZERO))
          ? vBTCReducedOpenNotional.add(vBTCDeltaQuote)
          : vBTCReducedOpenNotional.sub(vBTCDeltaQuote);

        const totalRealizedPnl = vETHRealizedPnl.add(vBTCRealizedPnl);

        return toUSDCDecimals(collateralQuantityNotional.add(totalRealizedPnl).abs());
      }

      cacheBeforeEach(async () => {
        await leverUp(setToken, vETH.address, 2, ether(.02), true);
        await leverUp(setToken, vBTC.address, 1, ether(.02), true);
      });

      describe("when redeeming a single set", async () => {
        let usdcTransferOutQuantity: BigNumber;

        beforeEach(async () => {
          usdcTransferOutQuantity = await calculateUSDCTransferOut();
        });

        it("sells expected amount of vETH, vBTC", async () => {
          const totalSupply = await setToken.totalSupply();
          const initialPositionInfo = await perpLeverageModule.getPositionInfo(subjectSetToken);

          const initialVETHBalance = initialPositionInfo[0].baseBalance;
          const initialVBTCBalance = initialPositionInfo[1].baseBalance;

          await subject();

          const finalPositionInfo = await perpLeverageModule.getPositionInfo(subjectSetToken);
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
          const expectedExternalPositionUnit = preciseDiv(usdcTransferOutQuantity, subjectSetQuantity);

          await subject();

          const externalPositionUnit = await setToken.getExternalPositionRealUnit(
            usdc.address,
            perpLeverageModule.address
          );

          expect(externalPositionUnit).to.be.closeTo(expectedExternalPositionUnit, 1);
        });
      });

      describe("when issuing multiple sets", async () => {
        let usdcTransferOutQuantity: BigNumber;

        beforeEach(async () => {
          subjectSetQuantity = ether(2);

          // Deposit more collateral to avoid NEFC error
          await perpLeverageModule.deposit(subjectSetToken, usdcUnits(30));
          usdcTransferOutQuantity = await calculateUSDCTransferOut();
        });

        it("buys expected amount of vETH, vBTC", async () => {
          const totalSupply = await setToken.totalSupply();
          const initialPositionInfo = await perpLeverageModule.getPositionInfo(subjectSetToken);

          const initialVETHBalance = initialPositionInfo[0].baseBalance;
          const initialVBTCBalance = initialPositionInfo[1].baseBalance;

          await subject();

          const finalPositionInfo = await perpLeverageModule.getPositionInfo(subjectSetToken);
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
          const expectedExternalPositionUnit = preciseDiv(usdcTransferOutQuantity, subjectSetQuantity);

          await subject();

          const externalPositionUnit = await setToken.getExternalPositionRealUnit(
            usdc.address,
            perpLeverageModule.address
          );

          expect(externalPositionUnit).to.be.closeTo(expectedExternalPositionUnit, 3);
        });
      });

      describe("when there is positive pending funding", async () => {
        let usdcTransferOutQuantity: BigNumber;

        beforeEach(async () => {
          usdcTransferOutQuantity = await calculateUSDCTransferOut();
        });

        it("should socialize the funding payment among existing set holders", async () => {
          // Move oracle price down and wait one day
          await perpSetup.setBaseTokenOraclePrice(vETH, "9.5");
          await perpSetup.setBaseTokenOraclePrice(vBTC, "19.5");

          await increaseTimeAsync(ONE_DAY_IN_SECONDS);
          const pendingFunding = (await perpLeverageModule.getAccountInfo(subjectSetToken)).pendingFundingPayments;
          const pendingFundingUnit = preciseDiv(pendingFunding, await setToken.totalSupply());
          const pendingFundingNotionalShare = preciseMul(pendingFundingUnit, subjectSetQuantity);

          const expectedExternalPositionUnit = preciseDiv(
            usdcTransferOutQuantity.add(toUSDCDecimals(pendingFundingNotionalShare)),
            subjectSetQuantity
          );

          await subject();

          const externalPositionUnit = await setToken.getExternalPositionRealUnit(
            usdc.address,
            perpLeverageModule.address
          );

          expect(pendingFunding).gt(0);
          expect(externalPositionUnit).to.be.closeTo(expectedExternalPositionUnit, 100);
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
            deadline:  MAX_UINT_256,
            sqrtPriceLimitX96: ZERO,
            referralCode: ZERO_BYTES
          });

          await perpSetup.clearingHouse.connect(maker.wallet).openPosition({
            baseToken: vBTC.address,
            isBaseToQuote: false,     // long
            isExactInput: true,       // `amount` is USDC
            amount: ether(20000),
            oppositeAmountBound: ZERO,
            deadline:  MAX_UINT_256,
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
          const owedRealizedPnlUnit = preciseDiv(owedRealizedPnl, await setToken.totalSupply());
          const owedRealizedPnlShareNotional = preciseMul(owedRealizedPnlUnit, subjectSetQuantity);

          const usdcTransferOutQuantity = await calculateUSDCTransferOut();

          const expectedExternalPositionUnit = preciseDiv(
            usdcTransferOutQuantity.add(toUSDCDecimals(owedRealizedPnlShareNotional)),
            subjectSetQuantity
          );

          await subject();

          const externalPositionUnit = await setToken.getExternalPositionRealUnit(
            usdc.address,
            perpLeverageModule.address
          );

          expect(owedRealizedPnl).gt(ether(1));
          expect(externalPositionUnit).to.be.closeTo(expectedExternalPositionUnit, 100);
        });
      });
    });

    describe("when short", async () => {
      let baseToken: Address;

      async function calculateUSDCTransferOut() {
        const positionInfo = (await perpLeverageModule.getPositionInfo(subjectSetToken))[0];
        const collateralBalance = (await perpLeverageModule.getAccountInfo(subjectSetToken)).collateralBalance;

        const collateralPositionUnit = preciseDiv(collateralBalance, await setToken.totalSupply());
        const collateralQuantityNotional = preciseMul(collateralPositionUnit, subjectSetQuantity);

        const basePositionUnit = preciseDiv(positionInfo.baseBalance, await setToken.totalSupply());
        const baseTradeQuantityNotional = preciseMul(basePositionUnit, subjectSetQuantity);

        const closeRatio = preciseDiv(baseTradeQuantityNotional, positionInfo.baseBalance);
        const reducedOpenNotional = preciseMul(positionInfo.quoteBalance, closeRatio);

        const { deltaQuote } = await perpSetup.getSwapQuote(
          baseToken,
          baseTradeQuantityNotional.abs(),
          true
        );

        const realizedPnl = (basePositionUnit.gte(ZERO))
          ? reducedOpenNotional.add(deltaQuote)
          : reducedOpenNotional.sub(deltaQuote);

        return toUSDCDecimals(collateralQuantityNotional.add(realizedPnl).abs());
      }

      describe("when issuing a single set", async () => {
        let usdcTransferOutQuantity: BigNumber;

        beforeEach(async () => {
          // Set up as 2X Short, allow 2% slippage
          baseToken = vETH.address;
          await leverUp(setToken, baseToken, 2, ether(.02), false);
          usdcTransferOutQuantity = await calculateUSDCTransferOut();
        });

        it("buys expected amount of vBase", async () => {
          const totalSupply = await setToken.totalSupply();

          const initialBaseBalance = (await perpLeverageModule.getPositionInfo(subjectSetToken))[0].baseBalance;
          await subject();
          const finalBaseBalance = (await perpLeverageModule.getPositionInfo(subjectSetToken))[0].baseBalance;

          const basePositionUnit = preciseDiv(initialBaseBalance, totalSupply);
          const baseTokenBoughtNotional = preciseMul(basePositionUnit, subjectSetQuantity);
          const expectedBaseBalance = initialBaseBalance.sub(baseTokenBoughtNotional);

          expect(finalBaseBalance).eq(expectedBaseBalance);
        });

        it("should set the expected USDC externalPositionUnit", async () => {
          const expectedExternalPositionUnit = preciseDiv(usdcTransferOutQuantity, subjectSetQuantity);

          await subject();

          const externalPositionUnit = await setToken.getExternalPositionRealUnit(
            usdc.address,
            perpLeverageModule.address
          );

          expect(externalPositionUnit).to.be.closeTo(expectedExternalPositionUnit, 1);
        });
      });

      describe("when there is positive owedRealizedPnl", async () => {
        beforeEach(async () => {
          // Set up as 2X short, allow 2% slippage
          baseToken = vETH.address;
          await leverUp(setToken, baseToken, 2, ether(.02), false);

          // Move price down by maker buying 10k USDC of vETH
          await perpSetup.clearingHouse.connect(maker.wallet).openPosition({
            baseToken: vETH.address,
            isBaseToQuote: true,       // short
            isExactInput: false,       // `amount` is USDC
            amount: ether(10000),
            oppositeAmountBound: ZERO,
            deadline:  MAX_UINT_256,
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
          const owedRealizedPnlUnit = preciseDiv(owedRealizedPnl, await setToken.totalSupply());
          const owedRealizedPnlShareNotional = preciseMul(owedRealizedPnlUnit, subjectSetQuantity);

          const usdcTransferOutQuantity = await calculateUSDCTransferOut();

          const expectedExternalPositionUnit = preciseDiv(
            usdcTransferOutQuantity.add(toUSDCDecimals(owedRealizedPnlShareNotional)),
            subjectSetQuantity
          );

          await subject();

          const externalPositionUnit = await setToken.getExternalPositionRealUnit(
            usdc.address,
            perpLeverageModule.address
          );

          expect(owedRealizedPnl).gt(0);
          expect(externalPositionUnit).to.be.closeTo(expectedExternalPositionUnit, 100);
        });
      });

      describe("when there is negative owedRealizedPnl", async () => {
        beforeEach(async () => {
          // Set up as 2X Short, allow 2% slippage
          baseToken = vETH.address;
          await leverUp(setToken, baseToken, 2, ether(.02), false);

          // Move price up by maker buy 10k USDC of vETH
          await perpSetup.clearingHouse.connect(maker.wallet).openPosition({
            baseToken: vETH.address,
            isBaseToQuote: false,       // long
            isExactInput: true,         // `amount` is USDC
            amount: ether(10000),
            oppositeAmountBound: ZERO,
            deadline:  MAX_UINT_256,
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
          const owedRealizedPnlUnit = preciseDiv(owedRealizedPnl, await setToken.totalSupply());
          const owedRealizedPnlShareNotional = preciseMul(owedRealizedPnlUnit, subjectSetQuantity);

          const usdcTransferOutQuantity = await calculateUSDCTransferOut();

          const expectedExternalPositionUnit = preciseDiv(
            usdcTransferOutQuantity.add(toUSDCDecimals(owedRealizedPnlShareNotional)),
            subjectSetQuantity
          );

          await subject();

          const externalPositionUnit = await setToken.getExternalPositionRealUnit(
            usdc.address,
            perpLeverageModule.address
          );

          expect(owedRealizedPnl).lt(0);
          expect(externalPositionUnit).to.be.closeTo(expectedExternalPositionUnit, 100);
        });
      });

      describe("when there is positive pending funding", async () => {
        let usdcTransferOutQuantity: BigNumber;

        beforeEach(async () => {
          // Set up as 2X Short, allow 2% slippage
          baseToken = vETH.address;
          await leverUp(setToken, baseToken, 2, ether(.02), false);
          usdcTransferOutQuantity = await calculateUSDCTransferOut();
        });

        it("should socialize the funding payment among existing set holders", async () => {
          // Move oracle price down and wait one day
          await perpSetup.setBaseTokenOraclePrice(vETH, "15");
          await increaseTimeAsync(ONE_DAY_IN_SECONDS);
          const pendingFunding = (await perpLeverageModule.getAccountInfo(subjectSetToken)).pendingFundingPayments;
          const pendingFundingUnit = preciseDiv(pendingFunding, await setToken.totalSupply());
          const pendingFundingNotionalShare = preciseMul(pendingFundingUnit, subjectSetQuantity);

          const expectedExternalPositionUnit = preciseDiv(
            usdcTransferOutQuantity.add(toUSDCDecimals(pendingFundingNotionalShare)),
            subjectSetQuantity
          );

          await subject();

          const externalPositionUnit = await setToken.getExternalPositionRealUnit(
            usdc.address,
            perpLeverageModule.address
          );

          expect(pendingFunding).gt(0);
          expect(externalPositionUnit).to.be.closeTo(expectedExternalPositionUnit, 100);
        });
      });

      describe("when there is negative pending funding", async () => {
        let usdcTransferOutQuantity: BigNumber;

        beforeEach(async () => {
          // Set up as 2X Short, allow 2% slippage
          baseToken = vETH.address;
          await leverUp(setToken, baseToken, 2, ether(.02), false);
          usdcTransferOutQuantity = await calculateUSDCTransferOut();
        });

        it("should socialize the funding payment among existing set holders", async () => {
          // Move oracle price up and wait one day
          await perpSetup.setBaseTokenOraclePrice(vETH, "9.5");
          await increaseTimeAsync(ONE_DAY_IN_SECONDS);
          const pendingFunding = (await perpLeverageModule.getAccountInfo(subjectSetToken)).pendingFundingPayments;
          const pendingFundingUnit = preciseDiv(pendingFunding, await setToken.totalSupply());
          const pendingFundingNotionalShare = preciseMul(pendingFundingUnit, subjectSetQuantity);

          const expectedExternalPositionUnit = preciseDiv(
            usdcTransferOutQuantity.add(toUSDCDecimals(pendingFundingNotionalShare)),
            subjectSetQuantity
          );

          await subject();

          const externalPositionUnit = await setToken.getExternalPositionRealUnit(
            usdc.address,
            perpLeverageModule.address
          );

          // We expect pending funding to be greater than -1 USDC and discount applied
          expect(pendingFunding).lt(0);
          expect(externalPositionUnit).to.be.closeTo(expectedExternalPositionUnit, 100);
        });
      });

      describe("when the market price moves down and leverage drops", async () => {
        beforeEach(async () => {
          // Set up as 2X Short, allow 2% slippage
          baseToken = vETH.address;
          await leverUp(setToken, baseToken, 2, ether(.02), false);
        });

        it("test assumptions and preconditions should be correct", async () => {
          let positionInfo = (await perpLeverageModule.getPositionInfo(subjectSetToken))[0];
          let collateralBalance = (await perpLeverageModule.getAccountInfo(subjectSetToken)).collateralBalance;

          const initialLeverage = await perpSetup.getCurrentLeverage(subjectSetToken, positionInfo, collateralBalance);
          const initialSpotPrice = await perpSetup.getSpotPrice(vETH.address);
          const initialUSDCTransferOutQuantity = await calculateUSDCTransferOut();

          await perpSetup.clearingHouse.connect(maker.wallet).openPosition({
            baseToken: vETH.address,
            isBaseToQuote: true,       // short
            isExactInput: false,       // `amount` is USDC
            amount: ether(10000),      // move price down by selling 10k USDC of vETH
            oppositeAmountBound: ZERO,
            deadline:  MAX_UINT_256,
            sqrtPriceLimitX96: ZERO,
            referralCode: ZERO_BYTES
          });

          positionInfo = (await perpLeverageModule.getPositionInfo(subjectSetToken))[0];
          collateralBalance = (await perpLeverageModule.getAccountInfo(subjectSetToken)).collateralBalance;

          const finalLeverage = await perpSetup.getCurrentLeverage(subjectSetToken, positionInfo, collateralBalance);
          const finalSpotPrice = await perpSetup.getSpotPrice(vETH.address);
          const finalUSDCTransferOutQuantity = await calculateUSDCTransferOut();

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
            deadline:  MAX_UINT_256,
            sqrtPriceLimitX96: ZERO,
            referralCode: ZERO_BYTES
          });

          const initialBaseBalance = (await perpLeverageModule.getPositionInfo(subjectSetToken))[0].baseBalance;
          await subject();
          const finalBaseBalance = (await perpLeverageModule.getPositionInfo(subjectSetToken))[0].baseBalance;

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
            deadline:  MAX_UINT_256,
            sqrtPriceLimitX96: ZERO,
            referralCode: ZERO_BYTES
          });

          const usdcTransferOutQuantity = await calculateUSDCTransferOut();
          const expectedExternalPositionUnit = preciseDiv(usdcTransferOutQuantity, subjectSetQuantity);

          await subject();

          const externalPositionUnit = await setToken.getExternalPositionRealUnit(
            usdc.address,
            perpLeverageModule.address
          );

          expect(externalPositionUnit).to.be.closeTo(expectedExternalPositionUnit, 100);
        });
      });

      describe("when redeeming multiple sets", async () => {
        let usdcTransferOutQuantity: BigNumber;

        beforeEach(async () => {
          // Set up as 2X Long, allow 2% slippage
          baseToken = vETH.address;
          subjectSetQuantity = ether(2);

          await leverUp(setToken, baseToken, 2, ether(.02), false);
          usdcTransferOutQuantity = await calculateUSDCTransferOut();
        });

        it("should set the expected USDC externalPositionUnit", async () => {
          const expectedExternalPositionUnit = preciseDiv(usdcTransferOutQuantity, subjectSetQuantity);

          await subject();

          const externalPositionUnit = await setToken.getExternalPositionRealUnit(
            usdc.address,
            perpLeverageModule.address
          );

          expect(externalPositionUnit).to.be.closeTo(expectedExternalPositionUnit, 1);
        });
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
      return await perpLeverageModule.connect(subjectCaller.wallet).componentIssueHook(
        subjectSetToken,
        subjectSetQuantity,
        usdc.address,
        true // unused
      );
    }

    describe("when long", () => {
      // Set up as 2X Long, allow 2% slippage
      cacheBeforeEach(async () => {
        await leverUp(setToken, vETH.address, 2, ether(.02), true);

        await perpLeverageModule
          .connect(subjectCaller.wallet)
          .moduleIssueHook(subjectSetToken, subjectSetQuantity);
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
        const expectedSetTokenUSDCBalance = initialSetTokenUSDCBalance.sub(usdcToTransferOut);

        expect(finalSetTokenUSDCBalance).eq(expectedSetTokenUSDCBalance);
      });

      it("should update the USDC defaultPositionUnit", async () => {
        const externalPositionUnit = await setToken.getExternalPositionRealUnit(usdc.address, perpLeverageModule.address);
        const initialDefaultPosition = await setToken.getDefaultPositionRealUnit(usdc.address);
        await subject();
        const finalDefaultPosition = await setToken.getDefaultPositionRealUnit(usdc.address);

        const depositQuantity = preciseMul(externalPositionUnit, subjectSetQuantity);
        const expectedDefaultPosition = initialDefaultPosition.sub(depositQuantity);
        expect(finalDefaultPosition).to.eq(expectedDefaultPosition);
      });

      it("should not update the USDC externalPositionUnit", async () => {
        const initialExternalPositionUnit = await setToken.getExternalPositionRealUnit(usdc.address, perpLeverageModule.address);
        await subject();
        const finalExternalPositionUnit = await setToken.getExternalPositionRealUnit(usdc.address, perpLeverageModule.address);

        expect(initialExternalPositionUnit).eq(finalExternalPositionUnit);
      });
    });

    describe("when short", () => {
      // Set up as 2X Long, allow 2% slippage
      cacheBeforeEach(async () => {
        await leverUp(setToken, vETH.address, 2, ether(.02), false);

        await perpLeverageModule
          .connect(subjectCaller.wallet)
          .moduleIssueHook(subjectSetToken, subjectSetQuantity);
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
        const expectedSetTokenUSDCBalance = initialSetTokenUSDCBalance.sub(usdcToTransferOut);

        expect(finalSetTokenUSDCBalance).eq(expectedSetTokenUSDCBalance);
      });

      it("should update the USDC defaultPositionUnit", async () => {
        const externalPositionUnit = await setToken.getExternalPositionRealUnit(usdc.address, perpLeverageModule.address);
        const initialDefaultPosition = await setToken.getDefaultPositionRealUnit(usdc.address);
        await subject();
        const finalDefaultPosition = await setToken.getDefaultPositionRealUnit(usdc.address);

        const depositQuantity = preciseMul(externalPositionUnit, subjectSetQuantity);
        const expectedDefaultPosition = initialDefaultPosition.sub(depositQuantity);
        expect(finalDefaultPosition).to.eq(expectedDefaultPosition);
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
    let subjectCaller: Account;

    const initializeContracts = async () => {
      collateralQuantity = usdcUnits(10);
      setToken = await issueSetsAndDepositToPerp(collateralQuantity);
    };

    const initializeSubjectVariables = () => {
      subjectSetToken = setToken.address;
      subjectCaller = mockModule;
      subjectSetQuantity = ether(.5); // Sell half
    };

    cacheBeforeEach(initializeContracts);
    beforeEach(initializeSubjectVariables);

    async function subject(): Promise<any> {
      return await perpLeverageModule.connect(subjectCaller.wallet).componentRedeemHook(
        subjectSetToken,
        subjectSetQuantity,
        usdc.address,
        true // unused
      );
    }

    describe("when long", () => {
      // Set up as 2X Long, allow 2% slippage
      cacheBeforeEach(async () => {
        await leverUp(setToken, vETH.address, 2, ether(.02), true);

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
      // Add other issuance mock after initializing PerpV2LeverageModule, so register is never called
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

    describe("when collateral balance exists", async () => {
      beforeEach(async () => {
        await perpLeverageModule.deposit(setToken.address, usdcUnits(10));
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Collateral balance remaining");
      });
    });
  });

  describe("#updateAllowedSetToken", async () => {
    let setToken: SetToken;

    let subjectSetToken: Address;
    let subjectStatus: boolean;
    let subjectCaller: Account;

    beforeEach(async () => {
      setToken = setToken = await setup.createSetToken(
        [usdc.address],
        [ether(2)],
        [perpLeverageModule.address, debtIssuanceMock.address]
      );

      subjectSetToken = setToken.address;
      subjectStatus = true;
      subjectCaller = owner;
    });

    async function subject(): Promise<any> {
      return perpLeverageModule.connect(subjectCaller.wallet).updateAllowedSetToken(
        subjectSetToken,
        subjectStatus
      );
    }

    it("should add Set to allow list", async () => {
      await subject();

      const isAllowed = await perpLeverageModule.allowedSetTokens(subjectSetToken);

      expect(isAllowed).to.be.true;
    });

    it("should emit the correct SetTokenStatusUpdated event", async () => {
      await expect(subject()).to.emit(perpLeverageModule, "SetTokenStatusUpdated").withArgs(
        subjectSetToken,
        subjectStatus
      );
    });

    describe("when disabling a Set", async () => {
      beforeEach(async () => {
        await subject();
        subjectStatus = false;
      });

      it("should remove Set from allow list", async () => {
        await subject();

        const isAllowed = await perpLeverageModule.allowedSetTokens(subjectSetToken);

        expect(isAllowed).to.be.false;
      });

      it("should emit the correct SetTokenStatusUpdated event", async () => {
        await expect(subject()).to.emit(perpLeverageModule, "SetTokenStatusUpdated").withArgs(
          subjectSetToken,
          subjectStatus
        );
      });

      describe("when Set Token is removed on controller", async () => {
        beforeEach(async () => {
          await setup.controller.removeSet(setToken.address);
        });

        it("should remove the Set from allow list", async () => {
          await subject();

          const isAllowed = await perpLeverageModule.allowedSetTokens(subjectSetToken);

          expect(isAllowed).to.be.false;
        });
      });
    });

    describe("when Set is removed on controller", async () => {
      beforeEach(async () => {
        await setup.controller.removeSet(setToken.address);
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Invalid SetToken");
      });
    });

    describe("when not called by owner", async () => {
      beforeEach(async () => {
        subjectCaller = await getRandomAccount();
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Ownable: caller is not the owner");
      });
    });
  });

  describe("#updateAnySetAllowed", async () => {
    let subjectAnySetAllowed: boolean;
    let subjectCaller: Account;

    beforeEach(async () => {
      subjectAnySetAllowed = true;
      subjectCaller = owner;
    });

    async function subject(): Promise<any> {
      return perpLeverageModule.connect(subjectCaller.wallet).updateAnySetAllowed(subjectAnySetAllowed);
    }

    it("should remove Set from allow list", async () => {
      await subject();

      const anySetAllowed = await perpLeverageModule.anySetAllowed();

      expect(anySetAllowed).to.be.true;
    });

    it("should emit the correct AnySetAllowedUpdated event", async () => {
      await expect(subject()).to.emit(perpLeverageModule, "AnySetAllowedUpdated").withArgs(
        subjectAnySetAllowed
      );
    });

    describe("when not called by owner", async () => {
      beforeEach(async () => {
        subjectCaller = await getRandomAccount();
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Ownable: caller is not the owner");
      });
    });
  });

  // This method uses the same flow as #moduleIssueHook, except the trade is router via QuoterSwap
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

      async function calculateUSDCTransferIn() {
        const positionInfo = (await perpLeverageModule.getPositionInfo(subjectSetToken))[0];
        const collateralBalance = (await perpLeverageModule.getAccountInfo(subjectSetToken)).collateralBalance;
        const basePositionUnit = preciseDiv(positionInfo.baseBalance, await setToken.totalSupply());
        const baseTradeQuantityNotional = preciseMul(basePositionUnit, subjectSetQuantity);

        const currentLeverage = await perpSetup.getCurrentLeverage(
          subjectSetToken,
          positionInfo,
          collateralBalance
        );

        const { deltaBase, deltaQuote } = await perpSetup.getSwapQuote(
          baseToken,
          baseTradeQuantityNotional,
          true
        );

        const idealQuote = preciseMul(deltaBase, await perpSetup.getSpotPrice(baseToken));
        const expectedSlippage = idealQuote.sub(deltaQuote).mul(-1);

        return toUSDCDecimals(preciseDiv(idealQuote, currentLeverage).add(expectedSlippage));
      }

      describe("when issuing a single set", async () => {
        let usdcTransferInQuantity: BigNumber;

        beforeEach(async () => {
          // Set up as 2X Long, allow 2% slippage
          baseToken = vETH.address;
          await leverUp(setToken, baseToken, 2, ether(.02), true);
          usdcTransferInQuantity = await calculateUSDCTransferIn();
        });

        it("does *not* change the vBase balance", async () => {
          const initialBaseBalance = (await perpLeverageModule.getPositionInfo(subjectSetToken))[0].baseBalance;
          await subject();
          const finalBaseBalance = (await perpLeverageModule.getPositionInfo(subjectSetToken))[0].baseBalance;

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
          const newExternalPositionUnit = preciseDiv(usdcTransferInQuantity, subjectSetQuantity);
          const expectedAdjustmentUnit = newExternalPositionUnit.sub(oldExternalPositionUnit);

          const actualAdjustmentUnit = (await subject())[0][1];

          expect(actualAdjustmentUnit).to.be.closeTo(expectedAdjustmentUnit, 1);
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

  // This method uses the same flow as #moduleRedeemHook, except the trade is router via QuoterSwap
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

      async function calculateUSDCTransferOut() {
        const positionInfo = (await perpLeverageModule.getPositionInfo(subjectSetToken))[0];
        const collateralBalance = (await perpLeverageModule.getAccountInfo(subjectSetToken)).collateralBalance;
        const basePositionUnit = preciseDiv(positionInfo.baseBalance, await setToken.totalSupply());
        const baseTradeQuantityNotional = preciseMul(basePositionUnit, subjectSetQuantity);

        const currentLeverage = await perpSetup.getCurrentLeverage(
          subjectSetToken,
          positionInfo,
          collateralBalance
        );

        const { deltaBase, deltaQuote } = await perpSetup.getSwapQuote(
          baseToken,
          baseTradeQuantityNotional,
          false
        );

        const idealQuote = preciseMul(deltaBase, await perpSetup.getSpotPrice(baseToken));

        const expectedSlippage = deltaQuote.sub(idealQuote);

        return toUSDCDecimals(preciseDiv(idealQuote, currentLeverage).add(expectedSlippage));
      }

      describe("when redeeming a single set", async () => {
        let usdcTransferOutQuantity: BigNumber;

        beforeEach(async () => {
          // Set up as 2X Long, allow 2% slippage
          baseToken = vETH.address;
          await leverUp(setToken, baseToken, 2, ether(.02), true);
          usdcTransferOutQuantity = await calculateUSDCTransferOut();
        });

        it("should *not* alter the vBase balance", async () => {
          const initialBaseBalance = (await perpLeverageModule.getPositionInfo(subjectSetToken))[0].baseBalance;
          await subject();
          const finalBaseBalance = (await perpLeverageModule.getPositionInfo(subjectSetToken))[0].baseBalance;

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
          const newExternalPositionUnit = preciseDiv(usdcTransferOutQuantity, subjectSetQuantity);
          const expectedAdjustmentUnit = newExternalPositionUnit.sub(oldExternalPositionUnit);

          const actualAdjustmentUnit = (await subject())[0][1];

          expect(actualAdjustmentUnit).to.be.closeTo(expectedAdjustmentUnit, 1);
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

  describe("#getPositionInfo", () => {
    let setToken: SetToken;
    let subjectSetToken: Address;

    let expectedVETHToken: Address;
    let expectedVBTCToken: Address;
    let expectedVETHTradeQuantityUnits: BigNumber;
    let expectedVBTCTradeQuantityUnits: BigNumber;
    let expectedVETHQuoteReceiveQuantityUnits: BigNumber;
    let expectedVBTCQuoteReceiveQuantityUnits: BigNumber;
    let expectedDepositQuantity: BigNumber;
    let expectedVETHDeltaQuote: BigNumber;
    let expectedVBTCDeltaQuote: BigNumber;

    beforeEach(async () => {
      expectedDepositQuantity = usdcUnits(100);

      setToken = await issueSetsAndDepositToPerp(expectedDepositQuantity);

      subjectSetToken = setToken.address;
      expectedVETHToken = vETH.address;
      expectedVBTCToken = vBTC.address;
      expectedVETHTradeQuantityUnits = ether(1);
      expectedVBTCTradeQuantityUnits = ether(1);
      expectedVETHQuoteReceiveQuantityUnits = ether(10.15);
      expectedVBTCQuoteReceiveQuantityUnits = ether(50.575);

      ({ deltaQuote: expectedVETHDeltaQuote } = await perpSetup.getSwapQuote(
        expectedVETHToken,
        expectedVETHTradeQuantityUnits,
        true
      ));

      ({ deltaQuote: expectedVBTCDeltaQuote } = await perpSetup.getSwapQuote(
        expectedVBTCToken,
        expectedVBTCTradeQuantityUnits,
        true
      ));

      await perpLeverageModule.connect(owner.wallet).trade(
        subjectSetToken,
        expectedVETHToken,
        expectedVETHTradeQuantityUnits,
        expectedVETHQuoteReceiveQuantityUnits
      );

      await perpLeverageModule.connect(owner.wallet).trade(
        subjectSetToken,
        expectedVBTCToken,
        expectedVBTCTradeQuantityUnits,
        expectedVBTCQuoteReceiveQuantityUnits
      );
    });

    async function subject(): Promise<any> {
      return perpLeverageModule.getPositionInfo(subjectSetToken);
    }

    it("should return info for multiple positions", async () => {
      const positionInfo = await subject();

      expect(positionInfo.length).eq(2);
      expect(positionInfo[0].baseToken).eq(expectedVETHToken);
      expect(positionInfo[1].baseToken).eq(expectedVBTCToken);
      expect(positionInfo[0].baseBalance).eq(expectedVETHTradeQuantityUnits);
      expect(positionInfo[1].baseBalance).eq(expectedVBTCTradeQuantityUnits);
      expect(positionInfo[0].quoteBalance).eq(expectedVETHDeltaQuote.mul(-1));
      expect(positionInfo[1].quoteBalance).eq(expectedVBTCDeltaQuote.mul(-1));
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
    });

    async function subject(): Promise<any> {
      return perpLeverageModule.getAccountInfo(subjectSetToken);
    }

    it("should return account info", async () => {
      const accountInfo = await subject();

      expect(toUSDCDecimals(accountInfo.collateralBalance)).eq(expectedDepositQuantity);
      expect(accountInfo.owedRealizedPnl).eq(0);
      expect(accountInfo.pendingFundingPayments).eq(0);
    });
  });

  describe("#getSpotPrice", () => {
    let subjectVETHToken: Address;
    let subjectVBTCToken: Address;

    beforeEach(() => {
      subjectVETHToken = vETH.address;
      subjectVBTCToken = vBTC.address;
    });

    async function subject(vToken: Address): Promise<BigNumber> {
      return perpLeverageModule.getSpotPrice(vToken);
    }

    it("should get the mid-point price for vETH", async () => {
      const expectedPrice = await perpSetup.getSpotPrice(subjectVETHToken);
      const price = await subject(subjectVETHToken);
      expect(price).eq(expectedPrice);
    });

    it("should get the mid-point price for vBTC", async () => {
      const expectedPrice = await perpSetup.getSpotPrice(subjectVBTCToken);
      const price = await subject(subjectVBTCToken);
      expect(price).eq(expectedPrice);
    });
  });
});
