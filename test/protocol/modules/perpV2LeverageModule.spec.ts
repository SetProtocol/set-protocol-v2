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
} from "@utils/test/index";

import { PerpV2Fixture, SystemFixture } from "@utils/fixtures";
import { ADDRESS_ZERO, ZERO  } from "@utils/constants";
import { BigNumber } from "ethers";
// import { inspect } from "util";

const expect = getWaffleExpect();

function toUSDCDecimals(quantity: BigNumber): BigNumber {
  return quantity.div(BigNumber.from(10).pow(12));
}

describe("PerpV2LeverageModule", () => {
  let owner: Account;
  let maker: Account;
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
      mockModule,
    ] = await getAccounts();

    deployer = new DeployHelper(owner.wallet);
    setup = getSystemFixture(owner.address);
    await setup.initialize();

    perpSetup = getPerpV2Fixture(owner.address);
    await perpSetup.initialize(maker);

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

    await perpSetup.setBaseTokenOraclePrice(vBTC, "50");
    await perpSetup.initializePoolWithLiquidityWide(
      vBTC,
      ether(10_000),
      ether(500_000)
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
    let subjectCollateralToken: Address;
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
      subjectCollateralToken = usdc.address;
      subjectCaller = owner;
    };

    async function subject(): Promise<any> {
      return perpLeverageModule.connect(subjectCaller.wallet).initialize(
        subjectSetToken,
        subjectCollateralToken
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

      it("should set the collateralToken mapping", async () => {
        const initialCollateralToken = await perpLeverageModule.collateralToken(setToken.address);

        await subject();

        const finalCollateralToken = await perpLeverageModule.collateralToken(setToken.address);

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

  describe("#lever", () => {
    let setToken: SetToken;
    let isInitialized: boolean = true;

    let subjectSetToken: Address;
    let subjectCaller: Account;
    let subjectBaseToken: Address;
    let subjectBaseTradeQuantityUnits: BigNumber;
    let subjectQuoteReceiveQuantityUnits: BigNumber;
    let subjectDepositQuantity: BigNumber;

    const initializeContracts = async () => {
      setToken = await setup.createSetToken(
        [usdc.address],
        [usdcUnits(100)],
        [perpLeverageModule.address, debtIssuanceMock.address, setup.issuanceModule.address]
      );

      subjectSetToken = setToken.address;
      subjectDepositQuantity = ether(10);

      if (isInitialized === true) {
        await debtIssuanceMock.initialize(setToken.address);
        await perpLeverageModule.updateAllowedSetToken(setToken.address, true);

        await perpLeverageModule.connect(owner.wallet).initialize(
          setToken.address,
          usdc.address
        );

        const issueQuantity = ether(1);
        await usdc.approve(setup.issuanceModule.address, usdcUnits(1000));
        await setup.issuanceModule.initialize(setToken.address, ADDRESS_ZERO);
        await setup.issuanceModule.issue(setToken.address, issueQuantity, owner.address);
      }
    };

    const initializeSubjectVariables = async () => {
      subjectCaller = owner;
      subjectBaseToken = vETH.address;
    };

    cacheBeforeEach(initializeContracts);
    beforeEach(initializeSubjectVariables);

    async function subject(): Promise<any> {
      return await perpLeverageModule.connect(subjectCaller.wallet).lever(
        subjectSetToken,
        subjectBaseToken,
        subjectBaseTradeQuantityUnits,
        subjectQuoteReceiveQuantityUnits
      );
    }

    describe("when module is initialized", async () => {
      cacheBeforeEach(async () => {
        await perpLeverageModule.deposit(subjectSetToken, subjectDepositQuantity);
      });

      describe("when long", () => {
        describe("when no positions are open (total supply is 1)", async () => {
          beforeEach(async () => {
            // Long ~10 USDC of vETH
            subjectBaseTradeQuantityUnits = ether(1);
            subjectQuoteReceiveQuantityUnits = ether(10.15);

            await perpLeverageModule.deposit(subjectSetToken, subjectDepositQuantity);
          });

          it("should open a position", async () => {
            const initialPositionInfo = await perpLeverageModule.getPositionInfo(subjectSetToken);
            await subject();
            const finalPositionInfo = (await perpLeverageModule.getPositionInfo(subjectSetToken))[0];

            expect(initialPositionInfo.length).to.eq(0);
            expect(finalPositionInfo.baseBalance).eq(subjectBaseTradeQuantityUnits);
            expect(finalPositionInfo.quoteBalance).lt(0);
            expect(finalPositionInfo.quoteBalance.mul(-1)).lt(subjectQuoteReceiveQuantityUnits);
          });

          it("should emit the correct LeverageIncreased event", async () => {
            const {
              deltaBase: expectedDeltaBase,
              deltaQuote: expectedDeltaQuote
            } = await perpSetup.getSwapQuote(subjectBaseToken, subjectBaseTradeQuantityUnits, true);

            const expectedProtocolFee = ether(0);

            await expect(subject()).to.emit(perpLeverageModule, "LeverageIncreased").withArgs(
              subjectSetToken,
              subjectBaseToken,
              expectedDeltaBase,
              expectedDeltaQuote.add(1), // Swap quote is off by one (18 decimals),
              expectedProtocolFee
            );
          });
        });

        describe("when trading on margin", async () => {
          beforeEach(async () => {
            // Long ~20 USDC of vETH with 10 USDC collateral
            subjectBaseTradeQuantityUnits = ether(2);
            subjectQuoteReceiveQuantityUnits = ether(20.3);
          });

          it("should open a position", async () => {
            const spotPrice = await perpSetup.getSpotPrice(subjectBaseToken);
            const { collateralBalance } = await perpLeverageModule.getAccountInfo(subjectSetToken);

            await subject();

            const positionInfo = (await perpLeverageModule.getPositionInfo(subjectSetToken))[0];
            const quoteBalanceMin = preciseMul(subjectBaseTradeQuantityUnits,spotPrice);

            expect(collateralBalance).to.eq(subjectDepositQuantity);
            expect(quoteBalanceMin).to.be.gt(subjectDepositQuantity);
            expect(positionInfo.baseBalance).to.eq(subjectBaseTradeQuantityUnits);
            expect(positionInfo.quoteBalance.mul(-1)).to.be.gt(subjectDepositQuantity);
            expect(positionInfo.quoteBalance.mul(-1)).to.be.gt(quoteBalanceMin);
          });

          afterEach(() => subjectDepositQuantity = ether(10));
        });

        describe("when total supply is 2", async () => {
          beforeEach(async () => {
            await setup.issuanceModule.issue(setToken.address, ether(1), owner.address);

            subjectBaseTradeQuantityUnits = ether(1);
            subjectQuoteReceiveQuantityUnits = ether(10.15);
          });

          it("should open position for the expected amount", async () => {
            const spotPrice = await perpSetup.getSpotPrice(subjectBaseToken);

            await subject();
            const positionInfo = (await perpLeverageModule.getPositionInfo(subjectSetToken))[0];

            const totalSupply = await setToken.totalSupply();
            const positionValueUnits = preciseMul(spotPrice, subjectBaseTradeQuantityUnits);

            const expectedBaseBalance = preciseMul(subjectBaseTradeQuantityUnits, totalSupply);
            const expectedQuoteBalanceMin = preciseMul(subjectBaseTradeQuantityUnits, positionValueUnits);

            expect(totalSupply).to.be.gt(1);
            expect(positionInfo.baseBalance).to.eq(expectedBaseBalance);
            expect(positionInfo.quoteBalance.mul(-1)).to.be.gt(expectedQuoteBalanceMin);
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

            // Levering up from 0, delta quote is the new quote balance
            const { quoteBalance } = (await perpLeverageModule.getPositionInfo(subjectSetToken))[0];
            const feeAmountInQuoteDecimals = preciseMul(quoteBalance.mul(-1), feePercentage);

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

          it("should emit the correct LeverageIncreased event", async () => {
            const {
              deltaBase: expectedDeltaBase,
              deltaQuote: expectedDeltaQuote
            } = await perpSetup.getSwapQuote(subjectBaseToken, subjectBaseTradeQuantityUnits, true);

            const expectedProtocolFee = toUSDCDecimals(preciseMul(expectedDeltaQuote, feePercentage));

            await expect(subject()).to.emit(perpLeverageModule, "LeverageIncreased").withArgs(
              subjectSetToken,
              subjectBaseToken,
              expectedDeltaBase,
              expectedDeltaQuote.add(1), // Swap quote is off by one (18 decimals)
              expectedProtocolFee
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

          afterEach(() => subjectSetToken = setToken.address);
        });
      });

      describe("when short", () => {
        beforeEach(async () => {
          // Short ~10 USDC of vETH
          subjectBaseTradeQuantityUnits = ether(-1);
          subjectQuoteReceiveQuantityUnits = ether(9.85);
        });

        it("should open a position", async () => {
          const spotPrice = await perpSetup.getSpotPrice(subjectBaseToken);

          await subject();

          const positionInfo = (await perpLeverageModule.getPositionInfo(subjectSetToken))[0];
          const quoteBalanceMax = preciseMul(subjectBaseTradeQuantityUnits,spotPrice).mul(-1);

          expect(positionInfo.baseBalance).to.eq(subjectBaseTradeQuantityUnits);
          expect(positionInfo.quoteBalance).to.be.lt(quoteBalanceMax);
        });

        describe("when short and slippage is greater than allowed", async () => {
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

  describe("#delever", () => {
    let setToken: SetToken;
    let isInitialized: boolean = true;

    let subjectSetToken: Address;
    let subjectCaller: Account;
    let subjectBaseToken: Address;
    let subjectBaseTradeQuantityUnits: BigNumber;
    let subjectQuoteReceiveQuantityUnits: BigNumber;
    let subjectDepositQuantity: BigNumber;

    const initializeContracts = async () => {
      setToken = await setup.createSetToken(
        [usdc.address],
        [usdcUnits(100)],
        [perpLeverageModule.address, debtIssuanceMock.address, setup.issuanceModule.address]
      );

      subjectSetToken = setToken.address;
      subjectDepositQuantity = ether(10);

      if (isInitialized === true) {
        await debtIssuanceMock.initialize(setToken.address);
        await perpLeverageModule.updateAllowedSetToken(setToken.address, true);

        await perpLeverageModule.connect(owner.wallet).initialize(
          setToken.address,
          usdc.address
        );

        const issueQuantity = ether(1);
        await usdc.approve(setup.issuanceModule.address, usdcUnits(1000));
        await setup.issuanceModule.initialize(setToken.address, ADDRESS_ZERO);
        await setup.issuanceModule.issue(setToken.address, issueQuantity, owner.address);
      }
    };

    const initializeSubjectVariables = async () => {
      subjectCaller = owner;
      subjectBaseToken = vETH.address;
    };

    cacheBeforeEach(initializeContracts);
    beforeEach(initializeSubjectVariables);

    async function subject(): Promise<any> {
      return await perpLeverageModule.connect(subjectCaller.wallet).delever(
        subjectSetToken,
        subjectBaseToken,
        subjectBaseTradeQuantityUnits,
        subjectQuoteReceiveQuantityUnits
      );
    }

    describe("when module is initialized (Long)", async () => {
      describe("when long", () => {
        cacheBeforeEach(async () => {
          await perpLeverageModule.deposit(subjectSetToken, subjectDepositQuantity);
          await perpLeverageModule.lever(
            subjectSetToken,
            subjectBaseToken,
            ether(1),
            ether(10.15)
          );
        });

        describe("when total supply is 1", async () => {
          beforeEach(async () => {
            // Sell ~5 USDC of vETH
            subjectBaseTradeQuantityUnits = ether(.5);
            subjectQuoteReceiveQuantityUnits = ether(4.95);
          });

          it("should reduce a position", async () => {
            const {
              deltaBase: expectedDeltaBase
            } = await perpSetup.getSwapQuote(subjectBaseToken, subjectBaseTradeQuantityUnits, false);

            const initialPositionInfo = (await perpLeverageModule.getPositionInfo(subjectSetToken))[0];

            await subject();

            const finalPositionInfo = (await perpLeverageModule.getPositionInfo(subjectSetToken))[0];
            const closeRatio = preciseDiv(subjectBaseTradeQuantityUnits, initialPositionInfo.baseBalance);
            const reducedOpenNotional = preciseMul(initialPositionInfo.quoteBalance, closeRatio);

            const expectedBaseBalance = initialPositionInfo.baseBalance.sub(expectedDeltaBase);
            const expectedQuoteBalance = initialPositionInfo.quoteBalance.sub(reducedOpenNotional);

            expect(finalPositionInfo.baseBalance).lt(initialPositionInfo.baseBalance);
            expect(finalPositionInfo.quoteBalance).gt(initialPositionInfo.quoteBalance);

            expect(finalPositionInfo.baseBalance).eq(expectedBaseBalance);
            expect(finalPositionInfo.quoteBalance).eq(expectedQuoteBalance);
          });

          it("should emit the correct LeverageDecreased event", async () => {
            /* const {
              deltaBase: expectedDeltaBase,
              deltaQuote: expectedDeltaQuote,
            } = await perpSetup.getSwapQuote(subjectBaseToken, subjectBaseTradeQuantityUnits, false);

            const expectedProtocolFee = ether(0);*/


            await subject();
            await expect(subject()).to.emit(perpLeverageModule, "LeverageDecreased");

            // TODO: swap quote is not identical to what returns from open position
            // ex: Expected "4950247512375618780" to be equal 4950742586634282208
            /*
            .withArgs(
              subjectSetToken,
              subjectBaseToken,
              expectedDeltaBase,
              expectedDeltaQuote,
              expectedProtocolFee
            );*/

          });
        });

        describe("when total supply is 2", async () => {
          beforeEach(async () => {
            await setup.issuanceModule.issue(setToken.address, ether(1), owner.address);

            subjectBaseTradeQuantityUnits = ether(.25);
            subjectQuoteReceiveQuantityUnits = ether(2.45);

            await perpLeverageModule.deposit(subjectSetToken, subjectDepositQuantity.mul(2));
          });

          it("should reduce the position", async () => {
            const totalSupply = await setToken.totalSupply();

            const {
              deltaBase: expectedDeltaBase
            } = await perpSetup.getSwapQuote(
              subjectBaseToken,
              preciseMul(subjectBaseTradeQuantityUnits, totalSupply),
              false
            );

            const initialPositionInfo = (await perpLeverageModule.getPositionInfo(subjectSetToken))[0];

            await subject();

            const finalPositionInfo = (await perpLeverageModule.getPositionInfo(subjectSetToken))[0];

            const baseTradeQuantityNotional = preciseMul(subjectBaseTradeQuantityUnits, totalSupply);
            const closeRatio = preciseDiv(baseTradeQuantityNotional, initialPositionInfo.baseBalance);
            const reducedOpenNotional = preciseMul(initialPositionInfo.quoteBalance, closeRatio);

            const expectedBaseBalance = initialPositionInfo.baseBalance.sub(expectedDeltaBase);
            const expectedQuoteBalance = initialPositionInfo.quoteBalance.sub(reducedOpenNotional);

            expect(finalPositionInfo.baseBalance).lt(initialPositionInfo.baseBalance);
            expect(finalPositionInfo.quoteBalance).gt(initialPositionInfo.quoteBalance);

            expect(finalPositionInfo.baseBalance).eq(expectedBaseBalance);
            expect(finalPositionInfo.quoteBalance).eq(expectedQuoteBalance);
          });
        });

        describe("when slippage is greater than allowed", async () => {
          beforeEach(async () => {
            // Sell ~5 USDC of vETH
            subjectBaseTradeQuantityUnits = ether(.5);
            subjectQuoteReceiveQuantityUnits = ether(5);
          });

          it("should revert", async () => {
            // ClearingHouse: too little quote received when short
            await expect(subject()).to.be.revertedWith("CH_TLRS");
          });
        });

        describe("when the position is closed out", async () => {
          beforeEach(async () => {
            // Sell ~5 USDC of vETH
            subjectBaseTradeQuantityUnits = ether(1);
            subjectQuoteReceiveQuantityUnits = ether(9.85);
          });

          it("should update the positions mapping (removing vETH)", async () => {
            await subject();

            const positionInfo = await perpLeverageModule.getPositionInfo(subjectSetToken);
            expect(positionInfo.length).eq(0);
          });
        });

        describe("when a protocol fee is charged", async () => {
          let feePercentage: BigNumber;
          let idealDeltaQuote: BigNumber;
          let actualDeltaQuote: BigNumber;
          let protocolFeeInQuoteDecimals: BigNumber;
          let insuranceFee: BigNumber;
          let slippage: BigNumber;


          cacheBeforeEach(async () => {
            // Sell ~5 USDC of vETH
            subjectBaseTradeQuantityUnits = ether(.5);
            subjectQuoteReceiveQuantityUnits = ether(4.95);

            feePercentage = ether(0.05);
            setup.controller = setup.controller.connect(owner.wallet);

            await setup.controller.addFee(
              perpLeverageModule.address,
              ZERO,         // Fee type on trade function denoted as 0
              feePercentage
            );

            const spotPrice = await perpSetup.getSpotPrice(subjectBaseToken);

            idealDeltaQuote = preciseMul(subjectBaseTradeQuantityUnits, spotPrice);

            ({ deltaQuote: actualDeltaQuote } = await perpSetup.getSwapQuote(
              subjectBaseToken,
              subjectBaseTradeQuantityUnits,
              false
            ));

            protocolFeeInQuoteDecimals = preciseMul(actualDeltaQuote, feePercentage);
            insuranceFee = preciseMul(idealDeltaQuote, perpSetup.feeTierPercent);
            slippage = idealDeltaQuote.sub(actualDeltaQuote);
          });

          it("should withdraw the expected collateral amount from the Perp vault", async () => {
            const {
              collateralBalance: initialCollateralBalance
            } = await perpLeverageModule.getAccountInfo(subjectSetToken);

            await subject();

            const {
              collateralBalance: finalCollateralBalance,
            } = await perpLeverageModule.getAccountInfo(subjectSetToken);

            const expectedCollateralBalance = initialCollateralBalance
              .sub(slippage)
              .sub(insuranceFee)
              .sub(protocolFeeInQuoteDecimals);

            expect(toUSDCDecimals(finalCollateralBalance)).to.be.closeTo(toUSDCDecimals(expectedCollateralBalance), 1);
          });

          it("should transfer the correct protocol fee to the fee recipient", async () => {
            const feeRecipient = await setup.controller.feeRecipient();
            const initialFeeRecipientBalance = await usdc.balanceOf(feeRecipient);

            await subject();

            const finalFeeRecipientBalance = await usdc.balanceOf(feeRecipient);

            const protocolFeeInUSDCDecimals = toUSDCDecimals(protocolFeeInQuoteDecimals);
            const expectedFeeRecipientBalance = initialFeeRecipientBalance.add(protocolFeeInUSDCDecimals);

            expect(finalFeeRecipientBalance).to.eq(expectedFeeRecipientBalance);
          });

          it("should not change the value of the SetToken USDC defaultPositionUnit", async() => {
            const initialUSDCDefaultPositionUnit = await setToken.getDefaultPositionRealUnit(usdc.address);
            await subject();
            const finalUSDCDefaultPositionUnit = await setToken.getDefaultPositionRealUnit(usdc.address);

            expect(initialUSDCDefaultPositionUnit).to.eq(finalUSDCDefaultPositionUnit);
          });

          // TODO: swap quote is not identical to what returns from open position
          // ex: Expected "4950247512375618780" to be equal 4950742586634282208
          it("should emit the correct LeverageDecreased event", async () => {
            /*
            const {
              deltaBase: expectedDeltaBase,
              deltaQuote: expectedDeltaQuote
            } = await perpSetup.getSwapQuote(subjectBaseToken, subjectBaseTradeQuantityUnits, true);

            const expectedProtocolFee = toUSDCDecimals(preciseMul(expectedDeltaQuote, feePercentage));
             */

            await expect(subject()).to.emit(perpLeverageModule, "LeverageDecreased");


            /*
            .withArgs(
              subjectSetToken,
              subjectBaseToken,
              expectedDeltaBase,
              expectedDeltaQuote
              expectedProtocolFee
            );
             */
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

          afterEach(() => subjectSetToken = setToken.address);
        });
      });
    });

    describe("when short", async () => {
      cacheBeforeEach(async () => {
        await perpLeverageModule.deposit(subjectSetToken, subjectDepositQuantity);
        await perpLeverageModule.lever(
          subjectSetToken,
          subjectBaseToken,
          ether(-1),
          ether(9.85)
        );
      });

      describe("when total supply is 1", async () => {
        beforeEach(async () => {
          // Buy ~5 USDC of vETH
          subjectBaseTradeQuantityUnits = ether(-.5);
          subjectQuoteReceiveQuantityUnits = ether(5.15);
        });

        it("should reduce the magnitude of the short position", async () => {
          const {
            deltaBase: expectedDeltaBase
          } = await perpSetup.getSwapQuote(
            subjectBaseToken,
            subjectBaseTradeQuantityUnits.mul(-1),
            true // Long
          );

          const initialPositionInfo = (await perpLeverageModule.getPositionInfo(subjectSetToken))[0];

          await subject();

          const finalPositionInfo = (await perpLeverageModule.getPositionInfo(subjectSetToken))[0];
          const closeRatio = preciseDiv(subjectBaseTradeQuantityUnits, initialPositionInfo.baseBalance);
          const reducedOpenNotional = preciseMul(initialPositionInfo.quoteBalance, closeRatio);

          const expectedBaseBalance = initialPositionInfo.baseBalance.add(expectedDeltaBase);
          const expectedQuoteBalance = initialPositionInfo.quoteBalance.sub(reducedOpenNotional);

          expect(finalPositionInfo.baseBalance).gt(initialPositionInfo.baseBalance);
          expect(finalPositionInfo.quoteBalance).lt(initialPositionInfo.quoteBalance);

          expect(finalPositionInfo.baseBalance).eq(expectedBaseBalance);
          expect(finalPositionInfo.quoteBalance).eq(expectedQuoteBalance);
        });
      });

      describe("when slippage is greater than allowed", async () => {
        beforeEach(async () => {
          // Buy ~5 USDC of vETH: slippage incurred as larger negative quote delta
          subjectBaseTradeQuantityUnits = ether(-5);
          subjectQuoteReceiveQuantityUnits = ether(5);
        });

        it("should revert", async () => {
          // ClearingHouse: too much quote received when long
          await expect(subject()).to.be.revertedWith("CH_TMRL");
        });
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
        await perpLeverageModule.initialize(
          subjectSetToken.address,
          usdc.address
        );

        const issueQuantity = ether(1);
        await usdc.approve(setup.issuanceModule.address, usdcUnits(1000));
        await setup.issuanceModule.initialize(subjectSetToken.address, ADDRESS_ZERO);
        await setup.issuanceModule.issue(subjectSetToken.address, issueQuantity, owner.address);
      }
    };

    const initializeSubjectVariables = () => {
      subjectCaller = owner;
      subjectDepositAmount = 1;
      subjectDepositQuantity = ether(subjectDepositAmount); // 1 USDC in 10**18
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


        const expectedCollateralBalance = initialCollateralBalance.add(subjectDepositQuantity);
        expect(finalCollateralBalance).to.eq(expectedCollateralBalance);
      });

      it("should update the USDC defaultPositionUnit", async () => {
        const initialDefaultPosition = await subjectSetToken.getDefaultPositionRealUnit(usdc.address);
        await subject();
        const finalDefaultPosition = await subjectSetToken.getDefaultPositionRealUnit(usdc.address);;

        const expectedDefaultPosition = initialDefaultPosition.sub(usdcUnits(subjectDepositAmount));
        expect(finalDefaultPosition).to.eq(expectedDefaultPosition);
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
        await perpLeverageModule.initialize(
          subjectSetToken.address,
          usdc.address
        );

        const issueQuantity = ether(1);
        await usdc.approve(setup.issuanceModule.address, usdcUnits(1000));
        await setup.issuanceModule.initialize(subjectSetToken.address, ADDRESS_ZERO);
        await setup.issuanceModule.issue(subjectSetToken.address, issueQuantity, owner.address);

        // Deposit 10 USDC
        await perpLeverageModule
          .connect(owner.wallet)
          .deposit(subjectSetToken.address, ether(10));
      }
    };

    const initializeSubjectVariables = (withdrawAmount: number = 5) => {
      subjectWithdrawAmount = withdrawAmount;
      subjectCaller = owner;
      subjectWithdrawQuantity = ether(withdrawAmount); // USDC in 10**18
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

      it("should create a deposit", async () => {
        const {
          collateralBalance: initialCollateralBalance
        } = await perpLeverageModule.getAccountInfo(subjectSetToken.address);

        await subject();

        const {
          collateralBalance: finalCollateralBalance
        } = await perpLeverageModule.getAccountInfo(subjectSetToken.address);


        const expectedCollateralBalance = initialCollateralBalance.sub(subjectWithdrawQuantity);
        expect(finalCollateralBalance).to.eq(expectedCollateralBalance);
      });

      it("should update the USDC defaultPositionUnit", async () => {
        const initialDefaultPosition = await subjectSetToken.getDefaultPositionRealUnit(usdc.address);
        await subject();
        const finalDefaultPosition = await subjectSetToken.getDefaultPositionRealUnit(usdc.address);;

        const expectedDefaultPosition = initialDefaultPosition.add(usdcUnits(subjectWithdrawAmount));
        expect(finalDefaultPosition).to.eq(expectedDefaultPosition);
      });

      describe("when withdraw amount is 0", async () => {
        beforeEach(() => initializeSubjectVariables(0));

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
    let subjectSetToken: Address;
    let subjectCaller: Account;
    let subjectSetQuantity: BigNumber;
    let subjectLeverageRatio: number;

    const initializeContracts = async () => {
      // Add mock module to controller
      await setup.controller.addModule(mockModule.address);

      setToken = await setup.createSetToken(
        [usdc.address],
        [usdcUnits(100)],
        [perpLeverageModule.address, debtIssuanceMock.address, setup.issuanceModule.address]
      );

      await debtIssuanceMock.initialize(setToken.address);
      await perpLeverageModule.updateAllowedSetToken(setToken.address, true);

      await perpLeverageModule.connect(owner.wallet).initialize(
        setToken.address,
        usdc.address
      );

      // Initialize mock module
      await setToken.addModule(mockModule.address);
      await setToken.connect(mockModule.wallet).initializeModule();

      const issueQuantity = ether(1);
      await usdc.approve(setup.issuanceModule.address, usdcUnits(1000));
      await setup.issuanceModule.initialize(setToken.address, ADDRESS_ZERO);
      await setup.issuanceModule.issue(setToken.address, issueQuantity, owner.address);

      // Deposit 10 USDC (in 10**18)
      await perpLeverageModule.deposit(setToken.address, ether(10));
    };

    const initializeSubjectVariables = () => {
      subjectSetToken = setToken.address;
      subjectCaller = mockModule;
      subjectSetQuantity = ether(1);
      subjectLeverageRatio = 2;
    };

    cacheBeforeEach(initializeContracts);
    beforeEach(initializeSubjectVariables);

    async function subject(): Promise<any> {
      return await perpLeverageModule
        .connect(subjectCaller.wallet)
        .moduleIssueHook(subjectSetToken, subjectSetQuantity);
    }

    describe("when long, single position", () => {
      let baseTradeQuantityUnit: BigNumber;

      cacheBeforeEach(async () => {
        const spotPrice = await perpSetup.getSpotPrice(vETH.address);
        const totalSupply = await setToken.totalSupply();

        const { collateralBalance } = await perpLeverageModule.getAccountInfo(subjectSetToken);
        const baseTradeQuantityNotional = preciseDiv(collateralBalance.mul(subjectLeverageRatio), spotPrice);
        baseTradeQuantityUnit = preciseDiv(baseTradeQuantityNotional, totalSupply);

        const estimatedQuoteQuantityNotional =  preciseMul(baseTradeQuantityNotional, spotPrice);
        const allowedSlippage = preciseMul(estimatedQuoteQuantityNotional, ether(.02));
        const quoteReceiveQuantityUnit = preciseDiv(
          estimatedQuoteQuantityNotional.add(allowedSlippage),
          totalSupply
        );

        await perpLeverageModule.connect(owner.wallet).lever(
          setToken.address,
          vETH.address,
          baseTradeQuantityUnit,
          quoteReceiveQuantityUnit
        );
      });

      async function subject(): Promise<any> {
        await perpLeverageModule
          .connect(subjectCaller.wallet)
          .moduleIssueHook(subjectSetToken, subjectSetQuantity);
      }

      describe("when issuing a single set", async () => {
        it("should set the expected USDC externalPositionUnit", async () => {
          const spotPrice = await perpSetup.getSpotPrice(vETH.address);
          const positionInfo = (await perpLeverageModule.getPositionInfo(subjectSetToken))[0];
          const { collateralBalance } = await perpLeverageModule.getAccountInfo(subjectSetToken);

          const currentLeverage = await perpSetup.getCurrentLeverage(
            subjectSetToken,
            positionInfo,
            collateralBalance
          );

          const { deltaBase, deltaQuote } = await perpSetup.getSwapQuote(
            vETH.address,
            preciseMul(baseTradeQuantityUnit, subjectSetQuantity),
            true
          );

          const idealQuote = preciseMul(deltaBase, spotPrice);
          const expectedSlippage = idealQuote.sub(deltaQuote).mul(-1);
          const usdcTransferInQuantity = preciseDiv(idealQuote, currentLeverage).add(expectedSlippage);
          const expectedExternalPositionUnit = preciseDiv(usdcTransferInQuantity, subjectSetQuantity);

          await subject();

          const externalPositionUnit = await setToken.getExternalPositionRealUnit(
            usdc.address,
            perpLeverageModule.address
          );

          // Not perfect... needs investigation. Not even consistent??? e.g off by one occasionally
          // 10008085936690386266 vs 10008085658829252928
          expect(toUSDCDecimals(externalPositionUnit))
            .to.be
            .closeTo(toUSDCDecimals(expectedExternalPositionUnit), 1);
        });
      });

      describe("when there is pending funding", async () => {
        it("should set the expected USDC externalPositionUnit", async () => {
        });
      });

      describe("when there is owedRealizedPnl", async () => {
        it("should set the expected USDC externalPositionUnit", async () => {
        });
      });

      describe("when issuing multiple sets", async () => {
        it("should set the expected USDC externalPositionUnit", async () => {
        });
      });
    });

    describe("when long, multiple positions", async () => {

    });

    describe("when short", async () => {
      describe("when issuing a single set", async () => {
        it("should set the expected USDC externalPositionUnit", async () => {
        });
      });

      describe("when there is pending funding", async () => {
        it("should set the expected USDC externalPositionUnit", async () => {
        });
      });

      describe("when there is owedRealizedPnl", async () => {
        it("should set the expected USDC externalPositionUnit", async () => {
        });
      });

      describe("when issuing multiple sets", async () => {
        it("should set the expected USDC externalPositionUnit", async () => {
        });
      });

      describe("when there are multiple positions", async () => {});
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
    let subjectSetToken: Address;
    let subjectSetQuantity: BigNumber;
    let subjectCaller: Account;
    let subjectLeverageRatio: number;

    const initializeContracts = async () => {
      // Add mock module to controller
      await setup.controller.addModule(mockModule.address);

      setToken = await setup.createSetToken(
        [usdc.address],
        [usdcUnits(100)],
        [perpLeverageModule.address, debtIssuanceMock.address, setup.issuanceModule.address]
      );

      await debtIssuanceMock.initialize(setToken.address);
      await perpLeverageModule.updateAllowedSetToken(setToken.address, true);

      await perpLeverageModule.connect(owner.wallet).initialize(
        setToken.address,
        usdc.address
      );

      // Initialize mock module
      await setToken.addModule(mockModule.address);
      await setToken.connect(mockModule.wallet).initializeModule();

      const issueQuantity = ether(1);
      await usdc.approve(setup.issuanceModule.address, usdcUnits(1000));
      await setup.issuanceModule.initialize(setToken.address, ADDRESS_ZERO);
      await setup.issuanceModule.issue(setToken.address, issueQuantity, owner.address);

      // Deposit 10 USDC (in 10**18)
      await perpLeverageModule.deposit(setToken.address, ether(10));
    };

    const initializeSubjectVariables = () => {
      subjectSetToken = setToken.address;
      subjectCaller = mockModule;
      subjectSetQuantity = ether(1);
      subjectLeverageRatio = 2;
    };

    cacheBeforeEach(initializeContracts);
    beforeEach(initializeSubjectVariables);

    async function subject(): Promise<any> {
      return await perpLeverageModule
        .connect(subjectCaller.wallet)
        .moduleRedeemHook(subjectSetToken, subjectSetQuantity);
    }

    describe("when long", async () => {
      let totalSupply: BigNumber;
      let baseTradeQuantityUnit: BigNumber;

      cacheBeforeEach(async () => {
        const spotPrice = await perpSetup.getSpotPrice(vETH.address);
        totalSupply = await setToken.totalSupply();

        const { collateralBalance } = await perpLeverageModule.getAccountInfo(subjectSetToken);
        const baseTradeQuantityNotional = preciseDiv(collateralBalance.mul(subjectLeverageRatio), spotPrice);
        baseTradeQuantityUnit = preciseDiv(baseTradeQuantityNotional, totalSupply);

        const estimatedQuoteQuantityNotional =  preciseMul(baseTradeQuantityNotional, spotPrice);
        const allowedSlippage = preciseMul(estimatedQuoteQuantityNotional, ether(.02));
        const quoteReceiveQuantityUnit = preciseDiv(
          estimatedQuoteQuantityNotional.add(allowedSlippage),
          totalSupply
        );

        await perpLeverageModule.connect(owner.wallet).lever(
          setToken.address,
          vETH.address,
          baseTradeQuantityUnit,
          quoteReceiveQuantityUnit
        );
      });

      it("sells expected amount of vBase", async () => {
        const {
          baseBalance: initialBaseBalance
        } = (await perpLeverageModule.getPositionInfo(subjectSetToken))[0];

        await subject();

        const {
          baseBalance: finalBaseBalance
        } = (await perpLeverageModule.getPositionInfo(subjectSetToken))[0];

        const basePositionUnit = preciseDiv(initialBaseBalance, totalSupply);
        const baseTokenSoldNotional = preciseMul(basePositionUnit, subjectSetQuantity);
        const expectedBaseBalance = initialBaseBalance.sub(baseTokenSoldNotional);

        expect(finalBaseBalance).eq(expectedBaseBalance);
      });

      it("set the expected externalPositionUnit", async () => {

      });
    });

    describe("when short", async () => {
      let totalSupply: BigNumber;
      let baseTradeQuantityUnit: BigNumber;

      cacheBeforeEach(async () => {
        const spotPrice = await perpSetup.getSpotPrice(vETH.address);
        totalSupply = await setToken.totalSupply();

        const { collateralBalance } = await perpLeverageModule.getAccountInfo(subjectSetToken);
        const baseTradeQuantityNotional = preciseDiv(collateralBalance.mul(subjectLeverageRatio), spotPrice);

        // Change sign to short on lever
        baseTradeQuantityUnit = preciseDiv(baseTradeQuantityNotional, totalSupply).mul(-1);

        const estimatedQuoteQuantityNotional =  preciseMul(baseTradeQuantityNotional, spotPrice);
        const allowedSlippage = preciseMul(estimatedQuoteQuantityNotional, ether(.02));
        const quoteReceiveQuantityUnit = preciseDiv(
          estimatedQuoteQuantityNotional.sub(allowedSlippage),
          totalSupply
        );

        await perpLeverageModule.connect(owner.wallet).lever(
          setToken.address,
          vETH.address,
          baseTradeQuantityUnit,
          quoteReceiveQuantityUnit
        );
      });

      it("buys expected amount of vBase", async () => {
        const {
          baseBalance: initialBaseBalance
        } = (await perpLeverageModule.getPositionInfo(subjectSetToken))[0];

        await subject();

        const {
          baseBalance: finalBaseBalance
        } = (await perpLeverageModule.getPositionInfo(subjectSetToken))[0];

        const basePositionUnit = preciseDiv(initialBaseBalance, totalSupply);
        const baseTokenSoldNotional = preciseMul(basePositionUnit, subjectSetQuantity);
        const expectedBaseBalance = initialBaseBalance.sub(baseTokenSoldNotional);

        expect(finalBaseBalance).eq(expectedBaseBalance);
      });

      it("set the expected externalPositionUnit", async () => {

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
    let subjectSetToken: Address;
    let subjectSetQuantity: BigNumber;
    let subjectCaller: Account;
    let subjectLeverageRatio: number;

    const initializeContracts = async () => {
      // Add mock module to controller
      await setup.controller.addModule(mockModule.address);

      setToken = await setup.createSetToken(
        [usdc.address],
        [usdcUnits(100)],
        [perpLeverageModule.address, debtIssuanceMock.address, setup.issuanceModule.address]
      );

      await debtIssuanceMock.initialize(setToken.address);
      await perpLeverageModule.updateAllowedSetToken(setToken.address, true);

      await perpLeverageModule.connect(owner.wallet).initialize(
        setToken.address,
        usdc.address
      );

      // Initialize mock module
      await setToken.addModule(mockModule.address);
      await setToken.connect(mockModule.wallet).initializeModule();

      const issueQuantity = ether(1);
      await usdc.approve(setup.issuanceModule.address, usdcUnits(1000));
      await setup.issuanceModule.initialize(setToken.address, ADDRESS_ZERO);
      await setup.issuanceModule.issue(setToken.address, issueQuantity, owner.address);

      // Deposit 10 USDC (in 10**18)
      await perpLeverageModule.deposit(setToken.address, ether(10));
    };

    const initializeSubjectVariables = () => {
      subjectSetToken = setToken.address;
      subjectCaller = mockModule;
      subjectSetQuantity = ether(1);
      subjectLeverageRatio = 2;
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
      let totalSupply: BigNumber;
      let baseTradeQuantityUnit: BigNumber;

      cacheBeforeEach(async () => {
        const spotPrice = await perpSetup.getSpotPrice(vETH.address);
        totalSupply = await setToken.totalSupply();

        const { collateralBalance } = await perpLeverageModule.getAccountInfo(subjectSetToken);
        const baseTradeQuantityNotional = preciseDiv(collateralBalance.mul(subjectLeverageRatio), spotPrice);
        baseTradeQuantityUnit = preciseDiv(baseTradeQuantityNotional, totalSupply);

        const estimatedQuoteQuantityNotional =  preciseMul(baseTradeQuantityNotional, spotPrice);
        const allowedSlippage = preciseMul(estimatedQuoteQuantityNotional, ether(.02));
        const quoteReceiveQuantityUnit = preciseDiv(
          estimatedQuoteQuantityNotional.add(allowedSlippage),
          totalSupply
        );

        await perpLeverageModule.connect(owner.wallet).lever(
          setToken.address,
          vETH.address,
          baseTradeQuantityUnit,
          quoteReceiveQuantityUnit
        );

        await perpLeverageModule
          .connect(subjectCaller.wallet)
          .moduleIssueHook(subjectSetToken, subjectSetQuantity);
      });

      it("should open the correct position in Perp", async () => {
        const { baseBalance: initialBaseBalance } = (await perpLeverageModule.getPositionInfo(subjectSetToken))[0];
        await subject();
        const { baseBalance: finalBaseBalance } = (await perpLeverageModule.getPositionInfo(subjectSetToken))[0];

        const basePositionUnit = preciseDiv(initialBaseBalance, totalSupply);
        const baseTokenBoughtNotional = preciseMul(basePositionUnit, subjectSetQuantity);
        const expectedBaseBalance = initialBaseBalance.add(baseTokenBoughtNotional);

        expect(finalBaseBalance).eq(expectedBaseBalance);
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
    let subjectSetToken: Address;
    let subjectSetQuantity: BigNumber;
    let subjectCaller: Account;
    let subjectLeverageRatio: number;

    const initializeContracts = async () => {
      // Add mock module to controller
      await setup.controller.addModule(mockModule.address);

      setToken = await setup.createSetToken(
        [usdc.address],
        [usdcUnits(100)],
        [perpLeverageModule.address, debtIssuanceMock.address, setup.issuanceModule.address]
      );

      await debtIssuanceMock.initialize(setToken.address);
      await perpLeverageModule.updateAllowedSetToken(setToken.address, true);

      await perpLeverageModule.connect(owner.wallet).initialize(
        setToken.address,
        usdc.address
      );

      // Initialize mock module
      await setToken.addModule(mockModule.address);
      await setToken.connect(mockModule.wallet).initializeModule();

      const issueQuantity = ether(1);
      await usdc.approve(setup.issuanceModule.address, usdcUnits(1000));
      await setup.issuanceModule.initialize(setToken.address, ADDRESS_ZERO);
      await setup.issuanceModule.issue(setToken.address, issueQuantity, owner.address);

      // Deposit 10 USDC (in 10**18)
      await perpLeverageModule.deposit(setToken.address, ether(10));
    };

    const initializeSubjectVariables = () => {
      subjectSetToken = setToken.address;
      subjectCaller = mockModule;
      subjectSetQuantity = ether(.5); // Sell half
      subjectLeverageRatio = 2;
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
      let totalSupply: BigNumber;
      let baseTradeQuantityUnit: BigNumber;

      cacheBeforeEach(async () => {
        const spotPrice = await perpSetup.getSpotPrice(vETH.address);
        totalSupply = await setToken.totalSupply();

        const { collateralBalance } = await perpLeverageModule.getAccountInfo(subjectSetToken);
        const baseTradeQuantityNotional = preciseDiv(collateralBalance.mul(subjectLeverageRatio), spotPrice);
        baseTradeQuantityUnit = preciseDiv(baseTradeQuantityNotional, totalSupply);

        const estimatedQuoteQuantityNotional =  preciseMul(baseTradeQuantityNotional, spotPrice);
        const allowedSlippage = preciseMul(estimatedQuoteQuantityNotional, ether(.02));
        const quoteReceiveQuantityUnit = preciseDiv(
          estimatedQuoteQuantityNotional.add(allowedSlippage),
          totalSupply
        );

        await perpLeverageModule.connect(owner.wallet).lever(
          setToken.address,
          vETH.address,
          baseTradeQuantityUnit,
          quoteReceiveQuantityUnit
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
        const expectedSetTokenUSDCBalance = initialSetTokenUSDCBalance.add(toUSDCDecimals(usdcToTransferOut));

        expect(finalSetTokenUSDCBalance).eq(expectedSetTokenUSDCBalance);
      });

      it("should not update the USDC defaultPositionUnit", async () => {
        const initialSetTokenUSDCDefaultPositionUnit = await setToken.getDefaultPositionRealUnit(subjectSetToken);
        await subject();
        const finalSetTokenUSDCDefaultPositionUnit = await setToken.getDefaultPositionRealUnit(subjectSetToken);

        expect(initialSetTokenUSDCDefaultPositionUnit).eq(finalSetTokenUSDCDefaultPositionUnit);
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
        await perpLeverageModule.initialize(
          setToken.address,
          usdc.address
        );
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
      await perpLeverageModule.initialize(
        setToken.address,
        usdc.address
      );
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

    it("should delete the collateralToken mapping", async () => {
      const initialCollateralToken = await perpLeverageModule.collateralToken(setToken.address);

      await subject();

      const finalCollateralToken = await perpLeverageModule.collateralToken(setToken.address);

      expect(initialCollateralToken).to.eq(usdc.address);
      expect(finalCollateralToken).to.eq(ADDRESS_ZERO);
    });

    it("should unregister on the debt issuance module", async () => {
      await subject();
      const isRegistered = await debtIssuanceMock.isRegistered(setToken.address);
      expect(isRegistered).to.be.false;
    });

    describe("when collateral balance exists", async () => {
      beforeEach(async () => {
        await perpLeverageModule.deposit(setToken.address, ether(10));
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

  describe("#setCollateralToken", async () => {
    let setToken: SetToken;
    let subjectSetToken: Address;
    let subjectCollateralToken: Address;
    let subjectCaller: Account;

    cacheBeforeEach(async function () {
      setToken = await setup.createSetToken(
        [usdc.address],
        [ether(100)],
        [perpLeverageModule.address, setup.issuanceModule.address, debtIssuanceMock.address]
      );
      await debtIssuanceMock.initialize(setToken.address);
      await perpLeverageModule.updateAllowedSetToken(setToken.address, true);

      await perpLeverageModule.initialize(
        setToken.address,
        usdc.address
      );

      await setup.issuanceModule.initialize(setToken.address, ADDRESS_ZERO);

      // Approve tokens to issuance module and call issue
      await usdc.approve(setup.issuanceModule.address, ether(100));
      await setup.issuanceModule.issue(setToken.address, ether(1), owner.address);
    });

    beforeEach(async () => {
      subjectSetToken = setToken.address;
      subjectCollateralToken = await getRandomAddress();
      subjectCaller = owner;
    });

    async function subject(): Promise<any> {
      return perpLeverageModule
        .connect(subjectCaller.wallet)
        .setCollateralToken(subjectSetToken, subjectCollateralToken);
    }

    it("should update the collateral token", async () => {
      const initialCollateralToken = await perpLeverageModule.collateralToken(subjectSetToken);
      await subject();
      const finalCollateralToken = await perpLeverageModule.collateralToken(subjectSetToken);

      expect(initialCollateralToken).to.not.eq(finalCollateralToken);
      expect(finalCollateralToken).to.eq(subjectCollateralToken);
    });

    describe("when the perp account has a collateral balance", async () => {
      beforeEach(async () => {
        await perpLeverageModule.deposit(subjectSetToken, ether(10));
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Existing collateral balance");
      });
    });

    describe("when not called by the SetToken manager", async () => {
      beforeEach(async () => {
        subjectCaller = await getRandomAccount();
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Must be the SetToken manager");
      });
    });
  });

  describe("#getPositionInfo", () => {
    let setToken: SetToken;
    let subjectSetToken: Address;
    let subjectCaller: Account;
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
      setToken = await setup.createSetToken(
        [usdc.address],
        [usdcUnits(100)],
        [perpLeverageModule.address, debtIssuanceMock.address, setup.issuanceModule.address]
      );

      subjectSetToken = setToken.address;
      expectedVETHToken = vETH.address;
      expectedVBTCToken = vBTC.address;
      expectedDepositQuantity = ether(100);
      expectedVETHTradeQuantityUnits = ether(1);
      expectedVBTCTradeQuantityUnits = ether(1);
      expectedVETHQuoteReceiveQuantityUnits = ether(10.15);
      expectedVBTCQuoteReceiveQuantityUnits = ether(50.575);
      subjectCaller = owner;

      await debtIssuanceMock.initialize(setToken.address);
      await perpLeverageModule.updateAllowedSetToken(setToken.address, true);

      await perpLeverageModule.connect(owner.wallet).initialize(
        setToken.address,
        usdc.address
      );

      const issueQuantity = ether(1);
      await usdc.approve(setup.issuanceModule.address, usdcUnits(1000));
      await setup.issuanceModule.initialize(setToken.address, ADDRESS_ZERO);
      await setup.issuanceModule.issue(setToken.address, issueQuantity, owner.address);

      await perpLeverageModule.deposit(subjectSetToken, expectedDepositQuantity);

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

      await perpLeverageModule.connect(subjectCaller.wallet).lever(
        subjectSetToken,
        expectedVETHToken,
        expectedVETHTradeQuantityUnits,
        expectedVETHQuoteReceiveQuantityUnits
      );

      await perpLeverageModule.connect(subjectCaller.wallet).lever(
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
      expect(positionInfo[0].quoteBalance).eq(expectedVETHDeltaQuote.add(1).mul(-1)); // Rounding error
      expect(positionInfo[1].quoteBalance).eq(expectedVBTCDeltaQuote.add(1).mul(-1));
    });
  });

  describe("#getAccountInfo", () => {
    let setToken: SetToken;
    let subjectSetToken: Address;
    let expectedDepositQuantity: BigNumber;

    beforeEach(async () => {
      setToken = await setup.createSetToken(
        [usdc.address],
        [usdcUnits(100)],
        [perpLeverageModule.address, debtIssuanceMock.address, setup.issuanceModule.address]
      );

      await debtIssuanceMock.initialize(setToken.address);
      await perpLeverageModule.updateAllowedSetToken(setToken.address, true);

      await perpLeverageModule.connect(owner.wallet).initialize(
        setToken.address,
        usdc.address
      );

      const issueQuantity = ether(1);
      await usdc.approve(setup.issuanceModule.address, usdcUnits(1000));
      await setup.issuanceModule.initialize(setToken.address, ADDRESS_ZERO);
      await setup.issuanceModule.issue(setToken.address, issueQuantity, owner.address);

      subjectSetToken = setToken.address;
      expectedDepositQuantity = ether(10);
      await perpLeverageModule.deposit(subjectSetToken, expectedDepositQuantity);
    });

    async function subject(): Promise<any> {
      return perpLeverageModule.getAccountInfo(subjectSetToken);
    }

    it("should return account info", async () => {
      const accountInfo = await subject();

      expect(accountInfo.collateralBalance).eq(expectedDepositQuantity);
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
