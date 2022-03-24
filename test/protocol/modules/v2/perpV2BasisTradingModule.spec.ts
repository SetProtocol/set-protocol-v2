import "module-alias/register";

import { Address } from "@utils/types";
import { Account } from "@utils/test/types";
import {
  PerpV2,
  PerpV2Positions,
  PerpV2BasisTradingModule,
  PositionV2,
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
  preciseMul,
  preciseDivCeil
} from "@utils/index";

import {
  calculateUSDCTransferOutPreciseUnits,
  toUSDCDecimals,
  getNetFundingGrowth
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
import { ADDRESS_ZERO, ZERO, ONE_DAY_IN_SECONDS, ONE, TWO } from "@utils/constants";
import { BigNumber } from "ethers";

const expect = getWaffleExpect();

interface FeeSettings {
  feeRecipient: Address;
  maxPerformanceFeePercentage: BigNumber;
  performanceFeePercentage: BigNumber;
}

// TODO:
// 1. Remove closeTo in moduleRedeemHook test

describe("PerpV2BasisTradingModule", () => {
  let owner: Account;
  let maker: Account;
  let otherTrader: Account;
  let mockModule: Account;
  let deployer: DeployHelper;

  let positionLib: PositionV2;
  let perpLib: PerpV2;
  let perpPositionsLib: PerpV2Positions;
  let perpBasisTradingModule: PerpV2BasisTradingModule;
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

    // set funding rate to non-zero value
    await perpSetup.clearingHouseConfig.setMaxFundingRate(usdcUnits(0.1));       // 10% in 6 decimals

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

    perpBasisTradingModule = await deployer.modules.deployPerpV2BasisTradingModule(
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
      perpPositionsLib.address
    );
    await setup.controller.addModule(perpBasisTradingModule.address);

    await setup.integrationRegistry.addIntegration(
      perpBasisTradingModule.address,
      "DefaultIssuanceModule",
      debtIssuanceMock.address
    );
  });

  /**
   * HELPERS
   */

  // Creates SetToken, issues sets (default: 1), initializes PerpV2BasisTradingModule and deposits to Perp
  async function issueSetsAndDepositToPerp(
    depositQuantityUnit: BigNumber,
    isInitialized: boolean = true,
    issueQuantity: BigNumber = ether(1),
    skipMockModuleInitialization = false,
    feeSettings: FeeSettings = {
      feeRecipient: owner.address,
      maxPerformanceFeePercentage: ether(.2),
      performanceFeePercentage: ether(.1)
    }
  ): Promise<SetToken> {
    const setToken = await setup.createSetToken(
      [setup.wbtc.address, usdc.address, setup.weth.address],
      [bitcoin(10), usdcUnits(100), ether(10)],
      [perpBasisTradingModule.address, debtIssuanceMock.address, setup.issuanceModule.address]
    );

    if (isInitialized) {
      await debtIssuanceMock.initialize(setToken.address);
      await perpBasisTradingModule.updateAllowedSetToken(setToken.address, true);

      await perpBasisTradingModule.connect(owner.wallet)["initialize(address,(address,uint256,uint256))"](
        setToken.address,
        feeSettings
      );

      // Initialize mock module
      if (!skipMockModuleInitialization) {
        await setup.controller.addModule(mockModule.address);
        await setToken.addModule(mockModule.address);
        await setToken.connect(mockModule.wallet).initializeModule();
      }

      await usdc.approve(setup.issuanceModule.address, preciseMul(usdcUnits(100), issueQuantity));
      await setup.issuanceModule.initialize(setToken.address, ADDRESS_ZERO);
      await setup.issuanceModule.issue(setToken.address, issueQuantity, owner.address);

      if (depositQuantityUnit.gt(ZERO)) {
        await perpBasisTradingModule.deposit(setToken.address, depositQuantityUnit);
      }
    }

    return setToken;
  }

  function fromPreciseUnitsToDecimals(amount: BigNumber, decimals: number): BigNumber {
    return amount.div(BigNumber.from(10).pow(18 - decimals));
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

    async function subject(): Promise<PerpV2BasisTradingModule> {
      return deployer.modules.deployPerpV2BasisTradingModule(
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
      const perpBasisTradingModule = await subject();

      const controller = await perpBasisTradingModule.controller();
      expect(controller).to.eq(subjectController);
    });

    it("should set the correct PerpV2 contracts and collateralToken", async () => {
      const perpBasisTradingModule = await subject();

      const perpAccountBalance = await perpBasisTradingModule.perpAccountBalance();
      const perpClearingHouse = await perpBasisTradingModule.perpClearingHouse();
      const perpExchange = await perpBasisTradingModule.perpExchange();
      const perpVault = await perpBasisTradingModule.perpVault();
      const perpQuoter = await perpBasisTradingModule.perpQuoter();
      const perpMarketRegistry = await perpBasisTradingModule.perpMarketRegistry();
      const collateralToken = await perpBasisTradingModule.collateralToken();

      expect(perpAccountBalance).to.eq(perpSetup.accountBalance.address);
      expect(perpClearingHouse).to.eq(perpSetup.clearingHouse.address);
      expect(perpExchange).to.eq(perpSetup.exchange.address);
      expect(perpVault).to.eq(perpSetup.vault.address);
      expect(perpQuoter).to.eq(perpSetup.quoter.address);
      expect(perpMarketRegistry).to.eq(perpSetup.marketRegistry.address);
      expect(collateralToken).to.eq(perpSetup.usdc.address);
    });

    it("should set the correct max perp positions per Set", async () => {
      const perpBasisTradingModule = await subject();

      const maxPerpPositionsPerSet = await perpBasisTradingModule.maxPerpPositionsPerSet();

      expect(maxPerpPositionsPerSet).to.eq(ONE);
    });
  });

  describe("#initialize (old)", async () => {
    let subjectSetToken: Address;
    let subjectCaller: Account;

    beforeEach(async () => {
      subjectSetToken = await getRandomAddress();
      subjectCaller = owner;
    });

    async function subject(): Promise<any> {
      return perpBasisTradingModule.connect(subjectCaller.wallet)["initialize(address)"](
        subjectSetToken
      );
    }

    it("should revert", async () => {
      await expect(subject()).to.be.revertedWith("Use intialize(_setToken, _settings) instead");
    });
  });

  describe("#initialize", async () => {
    let setToken: SetToken;
    let subjectSetToken: Address;
    let subjectFeeRecipient: Address;
    let subjectMaxPerformanceFeePercentage: BigNumber;
    let subjectPerformanceFeePercentage: BigNumber;
    let subjectCaller: Account;

    const initializeContracts = async (isAllowListed: boolean) => {
      setToken = await setup.createSetToken(
        [usdc.address],
        [ether(100)],
        [perpBasisTradingModule.address, debtIssuanceMock.address]
      );
      await debtIssuanceMock.initialize(setToken.address);

      if (isAllowListed) {
        // Add SetToken to allow list
        await perpBasisTradingModule.updateAllowedSetToken(setToken.address, true);
      }
    };

    const initializeSubjectVariables = () => {
      subjectSetToken = setToken.address;
      subjectFeeRecipient = owner.address;
      subjectMaxPerformanceFeePercentage = ether(.2);
      subjectPerformanceFeePercentage = ether(.1);
      subjectCaller = owner;
    };

    async function subject(): Promise<any> {
      return perpBasisTradingModule.connect(subjectCaller.wallet)["initialize(address,(address,uint256,uint256))"](
        subjectSetToken,
        {
          feeRecipient: subjectFeeRecipient,
          maxPerformanceFeePercentage: subjectMaxPerformanceFeePercentage,
          performanceFeePercentage: subjectPerformanceFeePercentage
        }
      );
    }

    describe("when SetToken is added to allowed Sets list", () => {
      cacheBeforeEach(async () => {
        await initializeContracts(true);
      });

      beforeEach(initializeSubjectVariables);

      it("should enable the Module on the SetToken", async () => {
        await subject();
        const isModuleEnabled = await setToken.isInitializedModule(perpBasisTradingModule.address);
        expect(isModuleEnabled).to.eq(true);
      });

      it("should register on the debt issuance module", async () => {
        await subject();
        const isRegistered = await debtIssuanceMock.isRegistered(setToken.address);
        expect(isRegistered).to.be.true;
      });

      it("should set the fee settings", async () => {
        await subject();
        const feeSettings = await perpBasisTradingModule.feeSettings(subjectSetToken);

        expect(feeSettings.feeRecipient).to.be.eq(owner.address);
        expect(feeSettings.maxPerformanceFeePercentage).to.be.eq(ether(.2));
        expect(feeSettings.performanceFeePercentage).to.be.eq(ether(.1));
      });

      describe("when the fee is greater than max fee", async () => {
        beforeEach(async () => {
          subjectPerformanceFeePercentage = ether(.21);
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("Fee must be <= max");
        });
      });

      describe("when the max performance fee is greater than 100%", async () => {
        beforeEach(async () => {
          subjectMaxPerformanceFeePercentage = ether(1.01);
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("Max fee must be <= 100%");
        });
      });

      describe("when the fee recipient is the ZERO_ADDRESS", async () => {
        beforeEach(async () => {
          subjectFeeRecipient = ADDRESS_ZERO;
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("Fee Recipient must be non-zero address");
        });
      });

      describe("when debt issuance module is not added to integration registry", async () => {
        beforeEach(async () => {
          await setup.integrationRegistry.removeIntegration(perpBasisTradingModule.address, "DefaultIssuanceModule");
        });

        afterEach(async () => {
          // Add debt issuance address to integration
          await setup.integrationRegistry.addIntegration(
            perpBasisTradingModule.address,
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

          const perpBasisTradingModuleNotPendingSetToken = await setup.createSetToken(
            [usdc.address],
            [usdcUnits(100)],
            [newModule]
          );

          subjectSetToken = perpBasisTradingModuleNotPendingSetToken.address;
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
            [perpBasisTradingModule.address]
          );

          subjectSetToken = nonEnabledSetToken.address;
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("Must be controller-enabled SetToken");
        });
      });
    });

    describe("when SetToken is not added to allowed Sets list", async () => {
      cacheBeforeEach(async () => {
        await initializeContracts(false);
      });
      beforeEach(initializeSubjectVariables);

      describe("when SetToken is not allowlisted", async () => {
        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("Not allowed SetToken");
        });
      });

      describe("when any Set can initialize this module", async () => {
        beforeEach(async () => {
          await perpBasisTradingModule.updateAnySetAllowed(true);
        });

        it("should enable the Module on the SetToken", async () => {
          await subject();
          const isModuleEnabled = await setToken.isInitializedModule(perpBasisTradingModule.address);
          expect(isModuleEnabled).to.eq(true);
        });
      });
    });
  });

  describe("#tradeAndTrackFunding", () => {
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
      if (isInitialized) {
        await perpBasisTradingModule.connect(owner.wallet).trade(
          setToken.address,
          vETH.address,
          ether(1),
          ether(10.15)
        );
      }
    };

    const initializeSubjectVariables = async () => {
      subjectSetToken = setToken.address;
      subjectCaller = owner;
      subjectBaseToken = vETH.address;
      subjectBaseTradeQuantityUnits = ether(1);
      subjectQuoteBoundQuantityUnits = ether(10.15);
    };

    cacheBeforeEach(initializeContracts);
    beforeEach(initializeSubjectVariables);

    async function subject(): Promise<any> {
      return await perpBasisTradingModule.connect(subjectCaller.wallet).tradeAndTrackFunding(
        subjectSetToken,
        subjectBaseToken,
        subjectBaseTradeQuantityUnits,
        subjectQuoteBoundQuantityUnits
      );
    }

    describe("when module is initialized", async () => {
      describe("when pending funding payment is positive", async () => {
        beforeEach(async () => {
          // Move oracle price up and wait one day
          await perpSetup.setBaseTokenOraclePrice(vETH, usdcUnits(10.5));
          await increaseTimeAsync(ONE_DAY_IN_SECONDS);
        });

        it("should update tracked settled funding", async () => {
          const settledFundingBefore = await perpBasisTradingModule.settledFunding(subjectSetToken);
          const [owedRealizedPnlBefore ] = await perpSetup.accountBalance.getPnlAndPendingFee(subjectSetToken);

          await subject();

          const settledFundingAfter = await perpBasisTradingModule.settledFunding(subjectSetToken);
          const [owedRealizedPnlAfter ] = await perpSetup.accountBalance.getPnlAndPendingFee(subjectSetToken);
          const exactPendingFunding = owedRealizedPnlAfter.abs().sub(owedRealizedPnlBefore.abs());

          expect(settledFundingAfter).to.be.eq(settledFundingBefore.add(exactPendingFunding));
        });

        it("should set pending funding on PerpV2 to zero", async () => {
          await subject();
          const pendingFunding = await perpSetup.exchange.getAllPendingFundingPayment(subjectSetToken);
          expect(pendingFunding).to.be.eq(ZERO);
        });
      });

      describe("when pending funding payment is negative", async () => {
        describe("when absolute settled funding is less than absoluate negative funding", async () => {
          beforeEach(async () => {
            // Move oracle price down and wait one day
            await perpSetup.setBaseTokenOraclePrice(vETH, usdcUnits(9.5));
            await increaseTimeAsync(ONE_DAY_IN_SECONDS);
          });

          it("verify testing conditions", async () => {
            const settledFundingBefore = await perpBasisTradingModule.settledFunding(subjectSetToken);
            const pendingFundingBefore = await perpSetup.exchange.getAllPendingFundingPayment(subjectSetToken);

            expect(pendingFundingBefore.abs()).to.be.gt(settledFundingBefore);
          });

          it("should set tracked settled funding to zero", async () => {
            await subject();

            const settledFundingAfter = await perpBasisTradingModule.settledFunding(subjectSetToken);

            expect(settledFundingAfter).to.be.eq(ZERO);
          });

          it("should set pending funding on PerpV2 to zero", async () => {
            await subject();
            const pendingFunding = await perpSetup.exchange.getAllPendingFundingPayment(subjectSetToken);
            expect(pendingFunding).to.be.eq(ZERO);
          });
        });

        describe("when absolute settled funding is greater then absolute negative pending funding", async () => {
          beforeEach(async () => {
            // Move oracle price up and wait one day
            await perpSetup.setBaseTokenOraclePrice(vETH, usdcUnits(11));
            await increaseTimeAsync(ONE_DAY_IN_SECONDS);

            // Trade to accrue pending funding to tracked settled funding
            await perpBasisTradingModule.connect(subjectCaller.wallet).tradeAndTrackFunding(
              subjectSetToken,
              subjectBaseToken,
              subjectBaseTradeQuantityUnits,
              subjectQuoteBoundQuantityUnits
            );

            // Move oracle price down and wait one day
            await perpSetup.setBaseTokenOraclePrice(vETH, usdcUnits(9.8));
            await increaseTimeAsync(ONE_DAY_IN_SECONDS);
          });

          it("verify testing conditions", async () => {
            const settledFundingBefore = await perpBasisTradingModule.settledFunding(subjectSetToken);
            const pendingFundingBefore = await perpSetup.exchange.getAllPendingFundingPayment(subjectSetToken);

            expect(settledFundingBefore.abs()).to.be.gt(pendingFundingBefore.abs());
          });

          it("should update tracked settled funding", async () => {
            const settledFundingBefore = await perpBasisTradingModule.settledFunding(subjectSetToken);
            const [owedRealizedPnlBefore ] = await perpSetup.accountBalance.getPnlAndPendingFee(subjectSetToken);

            await subject();

            const settledFundingAfter = await perpBasisTradingModule.settledFunding(subjectSetToken);
            const [owedRealizedPnlAfter ] = await perpSetup.accountBalance.getPnlAndPendingFee(subjectSetToken);
            const exactPendingFunding = owedRealizedPnlAfter.abs().sub(owedRealizedPnlBefore.abs());

            expect(settledFundingAfter).to.be.eq(settledFundingBefore.add(exactPendingFunding));
          });

          it("should set pending funding on PerpV2 to zero", async () => {
            await subject();
            const pendingFunding = await perpSetup.exchange.getAllPendingFundingPayment(subjectSetToken);
            expect(pendingFunding).to.be.eq(ZERO);
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
          [perpBasisTradingModule.address],
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

  describe("#withdrawFundingAndAccrueFees", () => {
    let setToken: SetToken;
    let isInitialized: boolean = true;
    let depositQuantity: BigNumber;
    let performanceFeePercentage: BigNumber = ZERO;
    let skipMockModuleInitialization: boolean = false;

    let subjectSetToken: Address;
    let subjectCaller: Account;
    let subjectNotionalFunding: BigNumber;

    const initializeContracts = async () => {
      depositQuantity = usdcUnits(10);
      // Issue 1 set
      setToken = await issueSetsAndDepositToPerp(depositQuantity, isInitialized,
        ether(1),
        skipMockModuleInitialization,
        {
          feeRecipient: owner.address,
          maxPerformanceFeePercentage: ether(.2),
          performanceFeePercentage
        }
      );
      if (isInitialized) {
        await perpBasisTradingModule.connect(owner.wallet).trade(
          setToken.address,
          vETH.address,
          ether(1),
          ether(10.15)
        );
        // Move index price up and wait one day to accrue positive funding
        await perpSetup.setBaseTokenOraclePrice(vETH, usdcUnits(11.5));
        await increaseTimeAsync(ONE_DAY_IN_SECONDS);
      }
    };

    const initializeSubjectVariables = async () => {
      subjectSetToken = setToken.address;
      subjectCaller = owner;
      subjectNotionalFunding = usdcUnits(0.1);
    };

    cacheBeforeEach(initializeContracts);
    beforeEach(initializeSubjectVariables);

    async function subject(): Promise<any> {
      return await perpBasisTradingModule.connect(subjectCaller.wallet).withdrawFundingAndAccrueFees(
        subjectSetToken,
        subjectNotionalFunding
      );
    }

    it("should update tracked settled funding", async () => {
      const settledFundingBefore = await perpBasisTradingModule.settledFunding(subjectSetToken);
      const baseBalance = await perpSetup.accountBalance.getBase(setToken.address, vETH.address);

      await subject();

      const settledFundingAfter = await perpBasisTradingModule.settledFunding(subjectSetToken);

      // Can't rely on owedReazliedPnl because that is settled to collateral and reset to zero.
      const netFundingGrowth = await getNetFundingGrowth(vETH.address, baseBalance, perpSetup);

      expect(settledFundingAfter).to.be.eq(settledFundingBefore.add(netFundingGrowth).sub(ether(0.1)));
    });

    it("should update default position unit", async () => {
      const usdcDefaultPositionUnit = await setToken.getDefaultPositionRealUnit(usdc.address);
      const totalSupply = await setToken.totalSupply();
      const usdcBalanceBefore = preciseMul(usdcDefaultPositionUnit, totalSupply);

      await subject();

      const expectedUsdcDefaultPositionUnit = preciseDiv(
        usdcBalanceBefore.add(subjectNotionalFunding),
        totalSupply
      );
      const newUsdcDefaultPositionUnit = await setToken.getDefaultPositionRealUnit(usdc.address);

      expect(newUsdcDefaultPositionUnit).to.be.eq(expectedUsdcDefaultPositionUnit);
    });

    it("should emit FundingWithdrawn event", async () => {
      await expect(subject()).to.emit(perpBasisTradingModule, "FundingWithdrawn").withArgs(
        subjectSetToken,
        usdc.address,
        usdcUnits(0.1),
        ZERO,
        ZERO
      );
    });

    describe("when amount is greater than track settled funding", async () => {
      beforeEach(async () => {
        const trackedSettledFunding = await perpBasisTradingModule.settledFunding(setToken.address);
        const pendingFunding = await perpSetup.exchange.getAllPendingFundingPayment(setToken.address);

        subjectNotionalFunding = fromPreciseUnitsToDecimals(trackedSettledFunding.add(pendingFunding.mul(-1)).mul(2), 6);
      });

      it("should update tracked settled funding", async () => {
        await subject();

        const settledFundingAfter = await perpBasisTradingModule.settledFunding(subjectSetToken);
        const settledFundingAfterInUsdc = settledFundingAfter.div(BigNumber.from(10).pow(12));
        expect(settledFundingAfterInUsdc).to.be.eq(ZERO);
      });

      it("should update default position unit", async () => {
        const usdcDefaultPositionUnit = await setToken.getDefaultPositionRealUnit(usdc.address);
        const totalSupply = await setToken.totalSupply();
        const baseBalance = await perpSetup.accountBalance.getBase(setToken.address, vETH.address);
        const usdcBalanceBefore = preciseMul(usdcDefaultPositionUnit, totalSupply);
        const settledFundingBefore = await perpBasisTradingModule.settledFunding(subjectSetToken);

        await subject();

        // Can't rely on owedReazliedPnl because that is settled to collateral and reset to zero.
        const netFundingGrowth = await getNetFundingGrowth(vETH.address, baseBalance, perpSetup);

        const withdrawAmountInUsdc = fromPreciseUnitsToDecimals(settledFundingBefore.add(netFundingGrowth), 6);
        const expectedUsdcDefaultPositionUnit = preciseDiv(
          usdcBalanceBefore.add(withdrawAmountInUsdc),
          totalSupply
        );
        const newUsdcDefaultPositionUnit = await setToken.getDefaultPositionRealUnit(usdc.address);

        expect(newUsdcDefaultPositionUnit).to.be.eq(expectedUsdcDefaultPositionUnit);
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

    describe("when manager performance fee is non-zero and protocol fee split is zero", async () => {

      cacheBeforeEach(async () => {
        performanceFeePercentage = ether(.1); // 10%
        skipMockModuleInitialization = true;
        await initializeContracts();
      });
      beforeEach(initializeSubjectVariables);

      it("should update default position unit", async () => {
        const usdcDefaultPositionUnit = await setToken.getDefaultPositionRealUnit(usdc.address);
        const totalSupply = await setToken.totalSupply();
        const usdcBalanceBefore = preciseMul(usdcDefaultPositionUnit, totalSupply);
        const managerFees = preciseMul(usdcUnits(0.1), performanceFeePercentage);
        const expectedUsdcDefaultPositionUnit = preciseDiv(
          usdcBalanceBefore.add(usdcUnits(0.1)).sub(managerFees),
          totalSupply
        );

        await subject();

        const newUsdcDefaultPositionUnit = await setToken.getDefaultPositionRealUnit(usdc.address);

        expect(newUsdcDefaultPositionUnit).to.be.eq(expectedUsdcDefaultPositionUnit);
      });

      it("should emit FundingWithdrawn event", async () => {
        const managerFees = preciseMul(usdcUnits(0.1), performanceFeePercentage);
        await expect(subject()).to.emit(perpBasisTradingModule, "FundingWithdrawn").withArgs(
          subjectSetToken,
          usdc.address,
          usdcUnits(0.1),
          managerFees,
          ZERO
        );
      });
    });

    describe("when manager and protocol performance fees are non-zero", async () => {
      let protocolFeePercentage: BigNumber;

      cacheBeforeEach(async () => {
        protocolFeePercentage = ether(0.05); // 50%
        await setup.controller.addFee(perpBasisTradingModule.address, ONE, protocolFeePercentage);

        performanceFeePercentage = ether(.1); // 10%
        skipMockModuleInitialization = true;

        await initializeContracts();
      });

      beforeEach(initializeSubjectVariables);

      it("should update default position unit", async () => {
        const usdcDefaultPositionUnit = await setToken.getDefaultPositionRealUnit(usdc.address);
        const totalSupply = await setToken.totalSupply();
        const usdcBalance = preciseMul(usdcDefaultPositionUnit, totalSupply);
        const totalFees = preciseMul(usdcUnits(0.1), performanceFeePercentage);

        const expectedUsdcDefaultPositionUnit = preciseDiv(
          usdcBalance.add(usdcUnits(0.1)).sub(totalFees),
          totalSupply
        );

        await subject();

        const newUsdcDefaultPositionUnit = await setToken.getDefaultPositionRealUnit(usdc.address);

        expect(newUsdcDefaultPositionUnit).to.be.eq(expectedUsdcDefaultPositionUnit);
      });

      it("should emit FundingWithdrawn event", async () => {
        const totalFees = preciseMul(usdcUnits(0.1), performanceFeePercentage);
        const protocolFees = preciseMul(totalFees, protocolFeePercentage);
        const managerFees = totalFees.sub(protocolFees);
        await expect(subject()).to.emit(perpBasisTradingModule, "FundingWithdrawn").withArgs(
          subjectSetToken,
          usdc.address,
          usdcUnits(0.1),
          managerFees,
          protocolFees
        );
      });
    });

    describe("when SetToken is not valid", async () => {
      beforeEach(async () => {
        const nonEnabledSetToken = await setup.createNonControllerEnabledSetToken(
          [perpSetup.usdc.address],
          [usdcUnits(100)],
          [perpBasisTradingModule.address],
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

  describe("#removeModule", async () => {
    let setToken: SetToken;
    let subjectModule: Address;

    cacheBeforeEach(async () => {
      // Note: solved `function call to a non-contract account`
      setToken = await issueSetsAndDepositToPerp(ZERO, true, ether(1), true);
    });

    beforeEach(() => {
      subjectModule = perpBasisTradingModule.address;
    });

    async function subject(): Promise<any> {
      return setToken.removeModule(subjectModule);
    }

    it("should delete the fee settings", async () => {
      await subject();
      const feeSettings = await perpBasisTradingModule.feeSettings(setToken.address);

      expect(feeSettings.feeRecipient).to.eq(ADDRESS_ZERO);
      expect(feeSettings.maxPerformanceFeePercentage).to.eq(ZERO);
      expect(feeSettings.performanceFeePercentage).to.eq(ZERO);
    });

    it("should set settled funding to zero", async () => {
      await subject();

      const settledFunding = await perpBasisTradingModule.settledFunding(setToken.address);

      expect(settledFunding).to.eq(ZERO);
    });

    it("should remove the Module on the SetToken", async () => {
      await subject();
      const isModuleEnabled = await setToken.isInitializedModule(perpBasisTradingModule.address);
      expect(isModuleEnabled).to.be.false;
    });

    it("should unregister on the debt issuance module", async () => {
      await subject();
      const isRegistered = await debtIssuanceMock.isRegistered(setToken.address);
      expect(isRegistered).to.be.false;
    });
  });

  describe("#moduleIssueHook", () => {
    let setToken: SetToken;
    const isInitialized: boolean = true;
    let depositQuantity: BigNumber;

    let subjectSetToken: Address;
    let subjectCaller: Account;
    let subjectSetQuantity: BigNumber;

    const initializeContracts = async () => {
      depositQuantity = usdcUnits(10);
      setToken = await issueSetsAndDepositToPerp(depositQuantity, isInitialized);
      if (isInitialized) {
        await perpBasisTradingModule.connect(owner.wallet).trade(
          setToken.address,
          vETH.address,
          ether(1),
          ether(10.15)
        );
      }
    };

    const initializeSubjectVariables = async () => {
      subjectSetToken = setToken.address;
      subjectCaller = mockModule;
      subjectSetQuantity = ether(1);
    };

    cacheBeforeEach(initializeContracts);
    beforeEach(initializeSubjectVariables);

    async function subject(): Promise<any> {
      return await perpBasisTradingModule.connect(subjectCaller.wallet).moduleIssueHook(
        subjectSetToken,
        subjectSetQuantity
      );
    }

    describe("when module is initialized", async () => {
      describe("when pending funding payment is positive", async () => {
        beforeEach(async () => {
          // Move oracle price down and wait one day
          await perpSetup.setBaseTokenOraclePrice(vETH, usdcUnits(10.5));
          await increaseTimeAsync(ONE_DAY_IN_SECONDS);
        });

        it("should update tracked settled funding", async () => {
          const settledFundingBefore = await perpBasisTradingModule.settledFunding(subjectSetToken);
          const [owedRealizedPnlBefore ] = await perpSetup.accountBalance.getPnlAndPendingFee(subjectSetToken);

          await subject();

          const settledFundingAfter = await perpBasisTradingModule.settledFunding(subjectSetToken);
          const [owedRealizedPnlAfter ] = await perpSetup.accountBalance.getPnlAndPendingFee(subjectSetToken);
          const exactPendingFunding = owedRealizedPnlAfter.abs().sub(owedRealizedPnlBefore.abs());

          expect(settledFundingAfter).to.be.eq(settledFundingBefore.add(exactPendingFunding));
        });

        it("should set pending funding on PerpV2 to zero", async () => {
          await subject();
          const pendingFunding = await perpSetup.exchange.getAllPendingFundingPayment(subjectSetToken);
          expect(pendingFunding).to.be.eq(ZERO);
        });
      });

      describe("when pending funding payment is negative", async () => {
        describe("when absolute settled funding is less than absolute negative funding", async () => {
          beforeEach(async () => {
            // Move oracle price down and wait one day
            await perpSetup.setBaseTokenOraclePrice(vETH, usdcUnits(9.5));
            await increaseTimeAsync(ONE_DAY_IN_SECONDS);
          });

          it("verify testing conditions", async () => {
            const settledFundingBefore = await perpBasisTradingModule.settledFunding(subjectSetToken);
            const pendingFundingBefore = await perpSetup.exchange.getAllPendingFundingPayment(subjectSetToken);

            expect(pendingFundingBefore.abs()).to.be.gt(settledFundingBefore);
          });

          it("should set tracked settled funding to zero", async () => {
            await subject();

            const settledFundingAfter = await perpBasisTradingModule.settledFunding(subjectSetToken);

            expect(settledFundingAfter).to.be.eq(ZERO);
          });

          it("should set pending funding on PerpV2 to zero", async () => {
            await subject();
            const pendingFunding = await perpSetup.exchange.getAllPendingFundingPayment(subjectSetToken);
            expect(pendingFunding).to.be.eq(ZERO);
          });
        });

        describe("when absolute settled funding is greater then absolute negative pending funding", async () => {
          beforeEach(async () => {
            // Move oracle price up and wait one day
            await perpSetup.setBaseTokenOraclePrice(vETH, usdcUnits(11));
            await increaseTimeAsync(ONE_DAY_IN_SECONDS);

            // Accrue pending funding to tracked settled funding
            await perpBasisTradingModule.connect(owner.wallet).tradeAndTrackFunding(
              setToken.address,
              vETH.address,
              ether(1),
              ether(10.15)
            );

            // Move oracle price down and wait one day
            await perpSetup.setBaseTokenOraclePrice(vETH, usdcUnits(9.8));
            await increaseTimeAsync(ONE_DAY_IN_SECONDS);
          });

          it("verify testing conditions", async () => {
            const settledFundingBefore = await perpBasisTradingModule.settledFunding(subjectSetToken);
            const pendingFundingBefore = await perpSetup.exchange.getAllPendingFundingPayment(subjectSetToken);

            expect(settledFundingBefore.abs()).to.be.gt(pendingFundingBefore.abs());
          });

          it("should update tracked settled funding", async () => {
            const settledFundingBefore = await perpBasisTradingModule.settledFunding(subjectSetToken);
            const [owedRealizedPnlBefore ] = await perpSetup.accountBalance.getPnlAndPendingFee(subjectSetToken);

            await subject();

            const settledFundingAfter = await perpBasisTradingModule.settledFunding(subjectSetToken);
            const [owedRealizedPnlAfter ] = await perpSetup.accountBalance.getPnlAndPendingFee(subjectSetToken);
            const exactPendingFunding = owedRealizedPnlAfter.abs().sub(owedRealizedPnlBefore.abs());

            expect(settledFundingAfter).to.be.eq(settledFundingBefore.add(exactPendingFunding));
          });

          it("should set pending funding on PerpV2 to zero", async () => {
            await subject();
            const pendingFunding = await perpSetup.exchange.getAllPendingFundingPayment(subjectSetToken);
            expect(pendingFunding).to.be.eq(ZERO);
          });
        });
      });
    });

    describe("when the caller is not module", async () => {
      beforeEach(async () => {
        subjectCaller = await getRandomAccount();
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

    let collateralQuantity: BigNumber;

    // Start with initial total supply (2)
    const initializeContracts = async () => {
      collateralQuantity = usdcUnits(10);
      setToken = await issueSetsAndDepositToPerp(collateralQuantity, true, ether(2));
    };

    const initializeSubjectVariables = async () => {
      subjectSetToken = setToken.address;
      subjectCaller = mockModule;
      subjectSetQuantity = ether(1);
    };

    cacheBeforeEach(initializeContracts);
    beforeEach(initializeSubjectVariables);

    async function subject(): Promise<any> {
      return await perpBasisTradingModule
        .connect(subjectCaller.wallet)
        .moduleRedeemHook(subjectSetToken, subjectSetQuantity);
    }

    describe("when tracked settled funding is greater than zero", async () => {
      beforeEach(async () => {
        await perpBasisTradingModule.connect(owner.wallet).trade(
          setToken.address,
          vETH.address,
          ether(1),
          ether(10.15)
        );

        // Move oracle price up and wait one day to accrue positive funding
        await perpSetup.setBaseTokenOraclePrice(vETH, usdcUnits(10.5));
        await increaseTimeAsync(ONE_DAY_IN_SECONDS);
      });

      it("should update tracked settled funding", async () => {
        const settledFundingBefore = await perpBasisTradingModule.settledFunding(subjectSetToken);
        const baseBalance = await perpSetup.accountBalance.getBase(setToken.address, vETH.address);

        await subject();

        const settledFundingAfter = await perpBasisTradingModule.settledFunding(subjectSetToken);

        // Can't rely on owed realized pnl because realized Pnl upon closing positions is also settled to it.
        const netFundingGrowth = await getNetFundingGrowth(vETH.address, baseBalance, perpSetup);

        expect(settledFundingAfter).to.be.closeTo(settledFundingBefore.add(netFundingGrowth), 1);
      });

      it("should set the expected USDC externalPositionUnit", async () => {
        const baseBalance = await perpSetup.accountBalance.getBase(setToken.address, vETH.address);
        const usdcTransferOutQuantity = await calculateUSDCTransferOutPreciseUnits(
          setToken,
          subjectSetQuantity,
          perpBasisTradingModule,
          perpSetup
        );
        const totalSupplyBeforeRedeem = await setToken.totalSupply();
        const settledFundingBefore = await perpBasisTradingModule.settledFunding(subjectSetToken);
        const performanceFeePercentage = (await perpBasisTradingModule.feeSettings(subjectSetToken)).performanceFeePercentage;

        await subject();

        const netFundingGrowth = await getNetFundingGrowth(vETH.address, baseBalance, perpSetup);
        const performanceFeeUnit = toUSDCDecimals(
          preciseMul(
            preciseDivCeil(settledFundingBefore.add(netFundingGrowth), totalSupplyBeforeRedeem),
            performanceFeePercentage
          )
        );
        const expectedExternalPositionUnit = toUSDCDecimals(
          preciseDiv(usdcTransferOutQuantity, subjectSetQuantity)
        );
        const externalPositionUnit = await setToken.getExternalPositionRealUnit(
          usdc.address,
          perpBasisTradingModule.address
        );

        expect(externalPositionUnit).to.closeTo(expectedExternalPositionUnit.sub(performanceFeeUnit), 100);
      });

    });

    describe("when tracked settled funding is zero", async () => {
      beforeEach(async() => {
        await perpSetup.clearingHouseConfig.setMaxFundingRate(ZERO);

        await perpBasisTradingModule.connect(owner.wallet).trade(
          setToken.address,
          vETH.address,
          ether(1),
          ether(10.15)
        );

        // Move oracle price down and wait one day
        await perpSetup.setBaseTokenOraclePrice(vETH, usdcUnits(9.5));
        await increaseTimeAsync(ONE_DAY_IN_SECONDS);
      });

      it("should set the expected USDC externalPositionUnit", async () => {
        const usdcTransferOutQuantity = await calculateUSDCTransferOutPreciseUnits(
          setToken,
          subjectSetQuantity,
          perpBasisTradingModule,
          perpSetup
        );

        await subject();

        const expectedExternalPositionUnit = toUSDCDecimals(
          preciseDiv(usdcTransferOutQuantity, subjectSetQuantity)
        );

        const externalPositionUnit = await setToken.getExternalPositionRealUnit(
          usdc.address,
          perpBasisTradingModule.address
        );

        expect(externalPositionUnit).to.eq(expectedExternalPositionUnit);
      });

    });

    describe("when total supply is 0", async () => {
      let otherSetToken: SetToken;

      beforeEach(async () => {
        otherSetToken = await setup.createSetToken(
          [usdc.address],
          [usdcUnits(10)],
          [perpBasisTradingModule.address, debtIssuanceMock.address]
        );
        await debtIssuanceMock.initialize(otherSetToken.address);
        await perpBasisTradingModule.updateAllowedSetToken(otherSetToken.address, true);
        await perpBasisTradingModule.connect(owner.wallet)["initialize(address,(address,uint256,uint256))"](
          otherSetToken.address,
          {
            feeRecipient: owner.address,
            maxPerformanceFeePercentage: ether(.2),
            performanceFeePercentage: ether(.1)
          }
        );

        // Initialize mock module
        await otherSetToken.addModule(mockModule.address);
        await otherSetToken.connect(mockModule.wallet).initializeModule();

        subjectSetToken = otherSetToken.address;
      });

      it("should not update the USDC externalPositionUnit", async () => {
        const initialExternalPositionUnit = await otherSetToken.getExternalPositionRealUnit(usdc.address, perpBasisTradingModule.address);
        await subject();
        const finalExternalPositionUnit = await otherSetToken.getExternalPositionRealUnit(usdc.address, perpBasisTradingModule.address);

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
          [perpBasisTradingModule.address, debtIssuanceMock.address, setup.issuanceModule.address]
        );

        await debtIssuanceMock.initialize(otherSetToken.address);
        await perpBasisTradingModule.updateAllowedSetToken(otherSetToken.address, true);

        await perpBasisTradingModule.connect(owner.wallet)["initialize(address,(address,uint256,uint256))"](
          otherSetToken.address,
          {
            feeRecipient: owner.address,
            maxPerformanceFeePercentage: ether(.2),
            performanceFeePercentage: ether(.1)
          }
        );

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
          perpBasisTradingModule.address
        );

        await subject();

        const finalExternalPositionUnit = await otherSetToken.getExternalPositionRealUnit(
          usdc.address,
          perpBasisTradingModule.address
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

  describe("#getRedemptionAdjustments", () => {
    let setToken: SetToken;
    let collateralQuantity: BigNumber;
    let subjectSetToken: Address;
    let subjectSetQuantity: BigNumber;
    let subjectCaller: Account;

    let maxFundingRate: BigNumber = ZERO;
    const initializeContracts = async () => {
      collateralQuantity = usdcUnits(10);
      setToken = await issueSetsAndDepositToPerp(collateralQuantity);
    };

    const initializeSubjectVariables = async () => {
      await perpSetup.clearingHouseConfig.setMaxFundingRate(maxFundingRate);       // In 6 decimals

      subjectSetToken = setToken.address;
      subjectCaller = mockModule;
      subjectSetQuantity = ether(1);
    };

    cacheBeforeEach(initializeContracts);
    beforeEach(initializeSubjectVariables);

    async function subject(): Promise<any> {
      return await perpBasisTradingModule
        .connect(subjectCaller.wallet)
        .callStatic
        .getRedemptionAdjustments(subjectSetToken, subjectSetQuantity);
    }

    describe("when long", async () => {
      // Set up as 2X Long, allow 2% slippage
      cacheBeforeEach(async () => {
        await perpBasisTradingModule.connect(owner.wallet).trade(
          setToken.address,
          vETH.address,
          ether(1),
          ether(10.15)
        );
      });

      describe("when redeeming a single set", async () => {
        it("should *not* alter the vBase balance", async () => {
          const initialBaseBalance = (await perpBasisTradingModule.getPositionNotionalInfo(subjectSetToken))[0].baseBalance;
          await subject();
          const finalBaseBalance = (await perpBasisTradingModule.getPositionNotionalInfo(subjectSetToken))[0].baseBalance;

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

        describe("when performance fee unit is zero", async () => {
          it("should return the expected USDC adjustment unit", async () => {
            const oldExternalPositionUnit = await setToken.getExternalPositionRealUnit(usdc.address, perpBasisTradingModule.address);
            const usdcTransferOutQuantity = await calculateUSDCTransferOutPreciseUnits(
              setToken,
              subjectSetQuantity,
              perpBasisTradingModule,
              perpSetup
            );

            const actualAdjustmentUnit = (await subject())[0][1];     // call subject

            const newExternalPositionUnit = toUSDCDecimals(preciseDiv(usdcTransferOutQuantity, subjectSetQuantity));
            const expectedAdjustmentUnit = newExternalPositionUnit.sub(oldExternalPositionUnit);

            expect(actualAdjustmentUnit).to.be.eq(expectedAdjustmentUnit);
          });
        });

        describe("when performance fee unit is greater than zero", async () => {
          beforeEach(async () => {
            maxFundingRate = usdcUnits(0.1);  // 10%
            await initializeSubjectVariables();

            // Move oracle price up and wait one day to accrue positive funding
            await perpSetup.setBaseTokenOraclePrice(vETH, usdcUnits(10.5));
            await increaseTimeAsync(ONE_DAY_IN_SECONDS);
          });

          it("should return the expected USDC adjustment unit", async () => {
            const totalSupply = await setToken.totalSupply();
            const baseBalance = await perpSetup.accountBalance.getBase(setToken.address, vETH.address);
            const performanceFeePercentage = (await perpBasisTradingModule.feeSettings(subjectSetToken)).performanceFeePercentage;

            const settledFundingBefore = await perpBasisTradingModule.settledFunding(subjectSetToken);
            const oldExternalPositionUnit = await setToken.getExternalPositionRealUnit(usdc.address, perpBasisTradingModule.address);

            const usdcTransferOutQuantity = await calculateUSDCTransferOutPreciseUnits(
              setToken,
              subjectSetQuantity,
              perpBasisTradingModule,
              perpSetup
            );

            const actualAdjustmentUnit = (await subject())[0][1];     // call subject

            const netFundingGrowth = await getNetFundingGrowth(vETH.address, baseBalance, perpSetup);
            const performanceFeeUnit = toUSDCDecimals(
              preciseMul(
                preciseDivCeil(settledFundingBefore.add(netFundingGrowth), totalSupply),
                performanceFeePercentage
              )
            );
            const newExternalPositionUnit = toUSDCDecimals(
              preciseDiv(usdcTransferOutQuantity, subjectSetQuantity)
            ).sub(performanceFeeUnit);

            const expectedAdjustmentUnit = newExternalPositionUnit.sub(oldExternalPositionUnit);
            expect(actualAdjustmentUnit).to.be.eq(expectedAdjustmentUnit);
          });
        });

        describe("when the set token doesn't contain the collateral token", async () => {
          let otherSetToken: SetToken;

          beforeEach(async () => {
            otherSetToken = await setup.createSetToken(
              [setup.wbtc.address],
              [bitcoin(10)],
              [perpBasisTradingModule.address, debtIssuanceMock.address, setup.issuanceModule.address]
            );
            await debtIssuanceMock.initialize(otherSetToken.address);
            await perpBasisTradingModule.updateAllowedSetToken(otherSetToken.address, true);
            await perpBasisTradingModule.connect(owner.wallet)["initialize(address,(address,uint256,uint256))"](
              otherSetToken.address,
              {
                feeRecipient: owner.address,
                maxPerformanceFeePercentage: ether(.2),
                performanceFeePercentage: ether(.1)
              }
            );

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

  describe("#updateFeeRecipient", async () => {
    let setToken: SetToken;
    let isInitialized: boolean;

    let subjectSetToken: Address;
    let subjectNewFeeRecipient: Address;
    let subjectCaller: Account;
    let depositQuantity: BigNumber;
    let newFeeRecipient: Address;

    before(async () => {
      isInitialized = true;
      newFeeRecipient = await getRandomAddress();
    });

    const initializeContracts = async () => {
      depositQuantity = usdcUnits(10);
      setToken = await issueSetsAndDepositToPerp(depositQuantity, isInitialized);
    };

    const initializeSubjectVariables = async () => {
      subjectSetToken = setToken.address;
      subjectCaller = owner;
      subjectNewFeeRecipient = newFeeRecipient;
    };

    cacheBeforeEach(initializeContracts);
    beforeEach(initializeSubjectVariables);

    async function subject(): Promise<any> {
      return perpBasisTradingModule.connect(subjectCaller.wallet).updateFeeRecipient(subjectSetToken, subjectNewFeeRecipient);
    }

    it("should change the fee recipient to the new address", async () => {
      await subject();

      const feeSettings = await perpBasisTradingModule.feeSettings(setToken.address);
      expect(feeSettings.feeRecipient).to.eq(subjectNewFeeRecipient);
    });

    it("should emit the correct FeeRecipientUpdated event", async () => {
      await expect(subject()).to.emit(perpBasisTradingModule, "FeeRecipientUpdated").withArgs(
        subjectSetToken,
        subjectNewFeeRecipient
      );
    });

    describe("when passed address is zero", async () => {
      beforeEach(async () => {
        subjectNewFeeRecipient = ADDRESS_ZERO;
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Fee Recipient must be non-zero address");
      });
    });

    describe("when SetToken is not valid", async () => {
      beforeEach(async () => {
        const nonEnabledSetToken = await setup.createNonControllerEnabledSetToken(
          [setup.weth.address],
          [ether(1)],
          [perpBasisTradingModule.address]
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

  describe("#updatePerformanceFee", async () => {
    let performanceFee: BigNumber;
    let setToken: SetToken;
    let depositQuantity: BigNumber;
    let isInitialized: boolean;

    let subjectSetToken: Address;
    let subjectCaller: Account;
    let subjectNewFee: BigNumber;

    before(async () => {
      isInitialized = true;
      performanceFee = ether(.12); // 12%
    });

    const initializeContracts = async () => {
      depositQuantity = usdcUnits(10);
      setToken = await issueSetsAndDepositToPerp(depositQuantity, isInitialized);
    };

    const initializeSubjectVariables = async () => {
      subjectSetToken = setToken.address;
      subjectCaller = owner;
      subjectNewFee = performanceFee;
    };

    cacheBeforeEach(initializeContracts);
    beforeEach(initializeSubjectVariables);

    async function subject(): Promise<any> {
      return perpBasisTradingModule.connect(subjectCaller.wallet).updatePerformanceFee(subjectSetToken, subjectNewFee);
    }

    it("should set the new fee", async () => {
      await subject();

      const feeSettings = await perpBasisTradingModule.feeSettings(setToken.address);
      expect(feeSettings.performanceFeePercentage).to.eq(subjectNewFee);
    });

    it("should emit the correct PerformanceFeeUpdated event", async () => {
      await expect(subject()).to.emit(perpBasisTradingModule, "PerformanceFeeUpdated").withArgs(
        subjectSetToken,
        subjectNewFee
      );
    });

    describe("when settled funding is not zero", async () => {
      beforeEach(async () => {
        await perpBasisTradingModule.connect(owner.wallet).trade(
          setToken.address,
          vETH.address,
          ether(1),
          ether(10.15)
        );
        await perpSetup.setBaseTokenOraclePrice(vETH, usdcUnits(10.5));
        await increaseTimeAsync(ONE_DAY_IN_SECONDS);
        await perpBasisTradingModule.connect(owner.wallet).tradeAndTrackFunding(
          setToken.address,
          vETH.address,
          ether(1),
          ether(10.15)
        );
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Non-zero settled funding remains");
      });
    });

    describe("when new fee exceeds max performance fee", async () => {
      beforeEach(async () => {
        subjectNewFee = ether(.21);
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Fee must be less than max");
      });
    });

    describe("when SetToken is not valid", async () => {
      beforeEach(async () => {
        const nonEnabledSetToken = await setup.createNonControllerEnabledSetToken(
          [setup.weth.address],
          [ether(1)],
          [perpBasisTradingModule.address]
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
});