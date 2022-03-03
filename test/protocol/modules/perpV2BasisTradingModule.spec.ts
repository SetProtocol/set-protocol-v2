import "module-alias/register";

import { Address } from "@utils/types";
import { Account } from "@utils/test/types";
import {
  PerpV2,
  PerpV2BasisTradingModule,
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
import { ADDRESS_ZERO, ZERO, ZERO_BYTES, MAX_UINT_256, ONE_DAY_IN_SECONDS, ONE, TWO, THREE } from "@utils/constants";
import { BigNumber } from "ethers";

const expect = getWaffleExpect();

interface FeeSettings {
  feeRecipient: Address,
  maxPerformanceFeePercentage: BigNumber,
  performanceFeePercentage: BigNumber
}

describe("PerpV2BasisTradingModule", () => {
  let owner: Account;
  let maker: Account;
  let otherTrader: Account;
  let mockModule: Account;
  let deployer: DeployHelper;

  let perpLib: PerpV2;
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
    perpLib = await deployer.libraries.deployPerpV2();
    perpBasisTradingModule = await deployer.modules.deployPerpV2BasisTradingModule(
      setup.controller.address,
      perpSetup.vault.address,
      perpSetup.quoter.address,
      perpSetup.marketRegistry.address,
      maxPerpPositionsPerSet,
      "contracts/protocol/integration/lib/PerpV2.sol:PerpV2",
      perpLib.address,
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

      await perpBasisTradingModule.deposit(setToken.address, depositQuantityUnit);
    }

    return setToken;
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
        "contracts/protocol/integration/lib/PerpV2.sol:PerpV2",
        perpLib.address,
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

  describe("#initialize", async () => {
    let setToken: SetToken;
    let isAllowListed: boolean;
    let subjectSetToken: Address;
    let subjectFeeSettings: FeeSettings;
    let subjectCaller: Account;

    let feeRecipient: Address;
    let maxPerformanceFeePercentage: BigNumber;
    let performanceFeePercentage: BigNumber;

    const initializeContracts = async () => {
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
      subjectFeeSettings = {
        feeRecipient,
        maxPerformanceFeePercentage,
        performanceFeePercentage
      }
      subjectCaller = owner;
    };

    async function subject(): Promise<any> {
      return perpBasisTradingModule.connect(subjectCaller.wallet)['initialize(address,(address,uint256,uint256))'](
        subjectSetToken,
        subjectFeeSettings
      );
    }

    describe("when SetToken is added to allowed Sets list", () => {
      before(async () => {
        isAllowListed = true;

        feeRecipient = owner.address;
        maxPerformanceFeePercentage = ether(.2);
        performanceFeePercentage = ether(.1);
      });

      cacheBeforeEach(initializeContracts);
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
        const feeSettings = await perpBasisTradingModule.feeStates(subjectSetToken);

        expect(feeSettings.feeRecipient).to.be.eq(owner.address);
        expect(feeSettings.maxPerformanceFeePercentage).to.be.eq(ether(.2));
        expect(feeSettings.performanceFeePercentage).to.be.eq(ether(.1));
      });
    
      describe("when the fee is greater than max fee", async () => {
        before(async () => {
          performanceFeePercentage = ether(.21);
        });

        after(async () => {
          performanceFeePercentage = ether(.1);
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("Fee must be <= max");
        });
      });

      describe("when the max performance fee is greater than 100%", async () => {
        before(async () => {
          maxPerformanceFeePercentage = ether(1.01);
        });

        after(async () => {
          maxPerformanceFeePercentage = ether(.2);
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("Max fee must be < 100%");
        });
      });

      describe("when the fee recipient is the ZERO_ADDRESS", async () => {
        before(async () => {
          feeRecipient = ADDRESS_ZERO;
        });

        after(async () => {
          feeRecipient = owner.address;
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

  describe("#trade", () => {
    let setToken: SetToken;
    let isInitialized: boolean = true;
    let depositQuantity: BigNumber;

    let subjectSetToken: Address;
    let subjectCaller: Account;
    let subjectBaseToken: Address;
    let subjectBaseTradeQuantityUnits: BigNumber;
    let subjectQuoteBoundQuantityUnits: BigNumber;
    let subjectTrackSettledFunding: boolean;

    const initializeContracts = async () => {
      depositQuantity = usdcUnits(10);
      setToken = await issueSetsAndDepositToPerp(depositQuantity, isInitialized);
    };

    const initializeSubjectVariables = async () => {
      subjectSetToken = setToken.address;
      subjectCaller = owner;
      subjectBaseToken = vETH.address;
      subjectTrackSettledFunding = true;
      subjectBaseTradeQuantityUnits = ether(1);
      subjectQuoteBoundQuantityUnits = ether(10.15);

      await perpBasisTradingModule.connect(subjectCaller.wallet).trade(
        subjectSetToken,
        subjectBaseToken,
        subjectBaseTradeQuantityUnits,
        subjectQuoteBoundQuantityUnits
      );
    };

    cacheBeforeEach(initializeContracts);
    beforeEach(initializeSubjectVariables);

    async function subject(): Promise<any> {
      return await perpBasisTradingModule.connect(subjectCaller.wallet).tradeAndTrackFunding(
        subjectSetToken,
        subjectBaseToken,
        subjectBaseTradeQuantityUnits,
        subjectQuoteBoundQuantityUnits,
        subjectTrackSettledFunding
      );
    }

    describe("when module is initialized", async () => {
      describe("when track settled funding is true", async () => {
        describe("when pending funding payment is positive", async () => {
          beforeEach(async () => {
            // Move oracle price down and wait one day
            await perpSetup.setBaseTokenOraclePrice(vETH, usdcUnits(10.5));
            await increaseTimeAsync(ONE_DAY_IN_SECONDS);
          });

          it("should update tracked settled funding", async () => {
            const settledFundingBefore = await perpBasisTradingModule.settledFunding(subjectSetToken);
            const pendingFundingBefore = await perpSetup.exchange.getAllPendingFundingPayment(subjectSetToken);
            const [owedRealizedPnlBefore, ] = await perpSetup.accountBalance.getPnlAndPendingFee(subjectSetToken);

            await subject();

            const settledFundingAfter = await perpBasisTradingModule.settledFunding(subjectSetToken);
            const [owedRealizedPnlAfter, ] = await perpSetup.accountBalance.getPnlAndPendingFee(subjectSetToken);
            const exactPendingFunding = owedRealizedPnlAfter.abs().sub(owedRealizedPnlBefore.abs());

            expect(settledFundingAfter).to.be.gt(settledFundingBefore.add(pendingFundingBefore));
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
              // set funding rate to non-zero value
              await perpSetup.clearingHouseConfig.setMaxFundingRate(usdcUnits(0.1));       // 10% in 6 decimals
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
              // Move oracle price down and wait one day
              await perpSetup.setBaseTokenOraclePrice(vETH, usdcUnits(11));
              await increaseTimeAsync(ONE_DAY_IN_SECONDS);

              await perpBasisTradingModule.connect(subjectCaller.wallet).tradeAndTrackFunding(
                subjectSetToken,
                subjectBaseToken,
                subjectBaseTradeQuantityUnits,
                subjectQuoteBoundQuantityUnits,
                true
              );
              
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
              const pendingFundingBefore = await perpSetup.exchange.getAllPendingFundingPayment(subjectSetToken);
              const [owedRealizedPnlBefore, ] = await perpSetup.accountBalance.getPnlAndPendingFee(subjectSetToken);
  
              await subject();
  
              const settledFundingAfter = await perpBasisTradingModule.settledFunding(subjectSetToken);
              const [owedRealizedPnlAfter, ] = await perpSetup.accountBalance.getPnlAndPendingFee(subjectSetToken);
              const exactPendingFunding = owedRealizedPnlAfter.abs().sub(owedRealizedPnlBefore.abs());
              
              expect(settledFundingAfter).to.be.lt(settledFundingBefore.sub(pendingFundingBefore));
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

      describe("when track settled funding is false", async () => {
        beforeEach(async () => {
          subjectTrackSettledFunding = false;
        });

        it("should not update tracked settled funding", async () => {

          const settledFundingBefore = await perpBasisTradingModule.settledFunding(subjectSetToken);

          await subject();

          const settledFundingAfter = await perpBasisTradingModule.settledFunding(subjectSetToken);

          expect(settledFundingBefore).to.eq(settledFundingAfter);
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

    describe.skip("when module is not initialized", async () => {
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

    let subjectSetToken: Address;
    let subjectCaller: Account;
    let subjectAmount: BigNumber;
    let subjectTrackSettledFunding: boolean;
    let performanceFeePercentage: BigNumber;

    const initializeContracts = async () => {
      depositQuantity = usdcUnits(10);
      performanceFeePercentage = ZERO;
      setToken = await issueSetsAndDepositToPerp(depositQuantity, isInitialized, 
        ether(1),
        false,
        {
          feeRecipient: owner.address,
          maxPerformanceFeePercentage: ether(.2),
          performanceFeePercentage
        }
      );
    };

    const initializeSubjectVariables = async () => {
      subjectSetToken = setToken.address;
      subjectCaller = owner;
      subjectAmount = usdcUnits(0.1);
      subjectTrackSettledFunding = true;

      await perpBasisTradingModule.connect(owner.wallet).trade(
        setToken.address,
        vETH.address,
        ether(1),
        ether(10.15)
      );

      // Move index price up and wait one day
      await perpSetup.setBaseTokenOraclePrice(vETH, usdcUnits(10.5));
      await increaseTimeAsync(ONE_DAY_IN_SECONDS);
    };

    cacheBeforeEach(initializeContracts);
    beforeEach(initializeSubjectVariables);

    async function subject(): Promise<any> {
      return await perpBasisTradingModule.connect(subjectCaller.wallet).withdrawFundingAndAccrueFees(
        subjectSetToken,
        subjectAmount,
        subjectTrackSettledFunding
      );
    }

    it("should update tracked settled funding", async () => {
      const settledFundingBefore = await perpBasisTradingModule.settledFunding(subjectSetToken);
      // const pendingFundingBefore = await perpSetup.exchange.getAllPendingFundingPayment(subjectSetToken);
      // const [owedRealizedPnlBefore, ] = await perpSetup.accountBalance.getPnlAndPendingFee(subjectSetToken);

      await subject();

      const settledFundingAfter = await perpBasisTradingModule.settledFunding(subjectSetToken);
      // const [owedRealizedPnlAfter, ] = await perpSetup.accountBalance.getPnlAndPendingFee(subjectSetToken);
      // const exactPendingFunding = owedRealizedPnlAfter.abs().sub(owedRealizedPnlBefore.abs());
      
      // Can't rely on owedReazliedPnl because that is settled to collateral and reset to zero.
      const netFundingGrowth = await getNetFundingGrowth(vETH.address, ether(1), perpSetup);
      
      expect(settledFundingAfter).to.be.eq(settledFundingBefore.add(netFundingGrowth).sub(ether(0.1)));
    });

    it("should update default position unit", async () => {
      const usdcDefaultPositionUnit = await setToken.getDefaultPositionRealUnit(usdc.address);
      const totalSupply = await setToken.totalSupply();
      const usdcBalance = preciseMul(usdcDefaultPositionUnit, totalSupply);
      
      
      await subject();
      
      const expectedUsdcDefaultPositionUnit = preciseDiv(usdcBalance.add(usdcUnits(0.1)), totalSupply);
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

    describe("when manager performance fee is non-zero", async () => {

      before(async () => {
        performanceFeePercentage = ether(.1); // 10%
      });

      cacheBeforeEach(async () => {
        depositQuantity = usdcUnits(10);
        performanceFeePercentage = ZERO;
        setToken = await issueSetsAndDepositToPerp(depositQuantity, isInitialized, 
          ether(1),
          true,
          {
            feeRecipient: owner.address,
            maxPerformanceFeePercentage: ether(.2),
            performanceFeePercentage
          }
        );
      });
      beforeEach(initializeSubjectVariables);
  
      it("should update default position unit", async () => {
        const usdcDefaultPositionUnit = await setToken.getDefaultPositionRealUnit(usdc.address);
        const totalSupply = await setToken.totalSupply();
        const usdcBalance = preciseMul(usdcDefaultPositionUnit, totalSupply);
        console.log(usdcBalance.toString());
        
        await subject();
        const usdcBAlanceAfter = await usdc.balanceOf(setToken.address);
        console.log(usdcBAlanceAfter.toString());
        const managerFees = preciseMul(usdcUnits(0.1), performanceFeePercentage);
        const expectedUsdcDefaultPositionUnit = preciseDiv(
          usdcBalance.add(usdcUnits(0.1)).sub(managerFees),
          totalSupply
        );
        const newUsdcDefaultPositionUnit = await setToken.getDefaultPositionRealUnit(usdc.address);
        console.log(newUsdcDefaultPositionUnit.toString());
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

    describe.skip("when manager and protocol performance fees are non-zero", async () => {
      let protocolFeePercentage: BigNumber;
      before(async () => {
        performanceFeePercentage = ether(.1); // 10%
        protocolFeePercentage = ether(0.05); // 5%
      });

      cacheBeforeEach(initializeContracts);
      beforeEach(async () => {
        await initializeSubjectVariables();
        console.log(setup.controller.address);
        await setup.controller.addFee(perpBasisTradingModule.address, ONE, protocolFeePercentage);
      });

      it("should update default position unit", async () => {
        const usdcDefaultPositionUnit = await setToken.getDefaultPositionRealUnit(usdc.address);
        const totalSupply = await setToken.totalSupply();
        const usdcBalance = preciseMul(usdcDefaultPositionUnit, totalSupply);
        console.log(usdcBalance.toString());
        
        await subject();
        const usdcBAlanceAfter = await usdc.balanceOf(setToken.address);
        console.log(usdcBAlanceAfter.toString());
        const managerFees = preciseMul(usdcUnits(0.1), performanceFeePercentage);
        const protocolFees = preciseMul(usdcUnits(0.1), protocolFeePercentage);
        const expectedUsdcDefaultPositionUnit = preciseDiv(
          usdcBalance.add(usdcUnits(0.1)).sub(managerFees).sub(protocolFees),
          totalSupply
        );
        const newUsdcDefaultPositionUnit = await setToken.getDefaultPositionRealUnit(usdc.address);
        console.log(newUsdcDefaultPositionUnit.toString());
        expect(newUsdcDefaultPositionUnit).to.be.eq(expectedUsdcDefaultPositionUnit); 
      });
  
      it("should emit FundingWithdrawn event", async () => {
        const managerFees = preciseMul(usdcUnits(0.1), performanceFeePercentage);
        const protocolFees = preciseMul(usdcUnits(0.1), protocolFeePercentage);
        await expect(subject()).to.emit(perpBasisTradingModule, "FundingWithdrawn").withArgs(
          subjectSetToken,
          usdc.address,
          usdcUnits(0.1),
          managerFees,
          protocolFees
        );
      });
    });

    describe.skip("when track settled funding is false", async () => {
      it("should update track settled funding", async () => {
        it("should update tracked settled funding", async () => {
          const settledFundingBefore = await perpBasisTradingModule.settledFunding(subjectSetToken);
        
          await subject();
    
          const settledFundingAfter = await perpBasisTradingModule.settledFunding(subjectSetToken);
          expect(settledFundingAfter).to.be.eq(settledFundingBefore.sub(ether(0.1)));
        });
      });  
    });

    describe("when amount is greater than track settled funding", async () => {
      beforeEach(async () => {
        const trackedSettledFunding = await perpBasisTradingModule.settledFunding(setToken.address);
        subjectAmount = trackedSettledFunding.add(ONE);
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Withdraw amount too high");
      })
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

    describe.skip("when module is not initialized", async () => {
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
      setToken = await setup.createSetToken(
        [usdc.address],
        [ether(100)],
        [perpBasisTradingModule.address, debtIssuanceMock.address, setup.issuanceModule.address]
      );
      await debtIssuanceMock.initialize(setToken.address);
      // Add SetToken to allow list
      await perpBasisTradingModule.updateAllowedSetToken(setToken.address, true);
      await perpBasisTradingModule["initialize(address,(address,uint256,uint256))"](setToken.address, {
        feeRecipient: owner.address,
        maxPerformanceFeePercentage: ether(.2),
        performanceFeePercentage: ether(.1)
      });
      await setup.issuanceModule.initialize(setToken.address, ADDRESS_ZERO);

      // Approve tokens to issuance module and call issue
      await usdc.approve(setup.issuanceModule.address, ether(100));
      await setup.issuanceModule.issue(setToken.address, ether(1), owner.address);
    });

    beforeEach(() => {
      subjectModule = perpBasisTradingModule.address;
    });

    async function subject(): Promise<any> {
      return setToken.removeModule(subjectModule);
    }

    it("should delete the fee settings", async () => {
      await subject();
      const feeSettings = await perpBasisTradingModule.feeStates(setToken.address);
      
      expect(feeSettings.feeRecipient).to.eq(ADDRESS_ZERO);
      expect(feeSettings.maxPerformanceFeePercentage).to.eq(ZERO);
      expect(feeSettings.performanceFeePercentage).to.eq(ZERO);
    });
    
    it("should set settled funding to zero", async () => {
      await subject();
      
      const settledFunding = await perpBasisTradingModule.settledFunding(setToken.address);
      
      expect(settledFunding).to.eq(ZERO);
    });
  });

  describe("#moduleIssueHook", () => {
    let setToken: SetToken;
    let isInitialized: boolean = true;
    let depositQuantity: BigNumber;

    let subjectSetToken: Address;
    let subjectCaller: Account;
    let subjectSetQuantity: BigNumber;

    const initializeContracts = async () => {
      depositQuantity = usdcUnits(10);
      setToken = await issueSetsAndDepositToPerp(depositQuantity, isInitialized);
    };

    const initializeSubjectVariables = async () => {
      subjectSetToken = setToken.address;
      subjectCaller = mockModule;
      subjectSetQuantity = ether(1);

      await perpBasisTradingModule.connect(owner.wallet).trade(
        setToken.address,
        vETH.address,
        ether(1),
        ether(10.15)
      );
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
          const pendingFundingBefore = await perpSetup.exchange.getAllPendingFundingPayment(subjectSetToken);
          const [owedRealizedPnlBefore, ] = await perpSetup.accountBalance.getPnlAndPendingFee(subjectSetToken);

          await subject();

          const settledFundingAfter = await perpBasisTradingModule.settledFunding(subjectSetToken);
          const [owedRealizedPnlAfter, ] = await perpSetup.accountBalance.getPnlAndPendingFee(subjectSetToken);
          const exactPendingFunding = owedRealizedPnlAfter.abs().sub(owedRealizedPnlBefore.abs());

          expect(settledFundingAfter).to.be.gt(settledFundingBefore.add(pendingFundingBefore));
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
            // set funding rate to non-zero value
            await perpSetup.clearingHouseConfig.setMaxFundingRate(usdcUnits(0.1));       // 10% in 6 decimals
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

        describe.skip("when absolute settled funding is greater then absolute negative pending funding", async () => {
          beforeEach(async () => {
            // Move oracle price down and wait one day
            await perpSetup.setBaseTokenOraclePrice(vETH, usdcUnits(11));
            await increaseTimeAsync(ONE_DAY_IN_SECONDS);

            await perpBasisTradingModule.connect(subjectCaller.wallet).tradeAndTrackFunding(
              setToken.address,
              vETH.address,
              ether(1),
              ether(10.15),
              true
            );
            
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
            const pendingFundingBefore = await perpSetup.exchange.getAllPendingFundingPayment(subjectSetToken);
            const [owedRealizedPnlBefore, ] = await perpSetup.accountBalance.getPnlAndPendingFee(subjectSetToken);

            await subject();

            const settledFundingAfter = await perpBasisTradingModule.settledFunding(subjectSetToken);
            const [owedRealizedPnlAfter, ] = await perpSetup.accountBalance.getPnlAndPendingFee(subjectSetToken);
            const exactPendingFunding = owedRealizedPnlAfter.abs().sub(owedRealizedPnlBefore.abs());
            
            expect(settledFundingAfter).to.be.lt(settledFundingBefore.sub(pendingFundingBefore));
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

    describe.skip("when module is not initialized", async () => {
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

      const feeSettings = await perpBasisTradingModule.feeStates(setToken.address);
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

    describe.skip("when module is not initialized", async () => {
      before(async () => {
        isInitialized = false;
      });

      after(async () => {
        isInitialized = true;
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Must be a valid and initialized SetToken");
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

      const feeSettings = await perpBasisTradingModule.feeStates(setToken.address);
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
          ether(10.15),
          true
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

    describe.skip("when module is not initialized", async () => {
      before(async () => {
        isInitialized = false;
      });

      after(async () => {
        isInitialized = true;
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Must be a valid and initialized SetToken");
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

    // WIP
    describe.skip("when tracked settled funding is greater than zero", async () => {
      beforeEach(async () => {
        await perpBasisTradingModule.connect(owner.wallet).trade(
          setToken.address,
          vETH.address,
          ether(1),
          ether(10.15)
        );

        // Move oracle price down and wait one day
        await perpSetup.setBaseTokenOraclePrice(vETH, usdcUnits(10.5));
        await increaseTimeAsync(ONE_DAY_IN_SECONDS);
      });

      it("should update tracked settled funding", async () => {
        const settledFundingBefore = await perpBasisTradingModule.settledFunding(subjectSetToken);
        const pendingFundingBefore = await perpSetup.exchange.getAllPendingFundingPayment(subjectSetToken);
        const [owedRealizedPnlBefore, ] = await perpSetup.accountBalance.getPnlAndPendingFee(subjectSetToken);
        
        await subject();

        const settledFundingAfter = await perpBasisTradingModule.settledFunding(subjectSetToken);
        const [owedRealizedPnlAfter, ] = await perpSetup.accountBalance.getPnlAndPendingFee(subjectSetToken);
        const exactPendingFunding = owedRealizedPnlAfter.abs().sub(owedRealizedPnlBefore.abs());
        // can't use owed realized pnl because it also contains realized pnl
        const netFundingGrowth = await getNetFundingGrowth(vETH.address, ether(1), perpSetup);
        console.log(netFundingGrowth.toString());

        const takerOpenNotional = await perpSetup.accountBalance.getTakerOpenNotional(setToken.address, vETH.address);
        const swapOutput = await perpSetup.quoter.callStatic.swap(
          {
           baseToken: vETH.address,
           isBaseToQuote: true,
           isExactInput: true,
           amount: ether(.5),
           sqrtPriceLimitX96: ZERO
          }
        );
        
        const reducedOpenNotional = takerOpenNotional.div(TWO);
        const pnlToBeRealized = swapOutput.deltaAvailableQuote.add(reducedOpenNotional);
        console.log(pnlToBeRealized.toString())

        // uint256 closedRatio = FullMath.mulDiv(params.base.abs(), _FULLY_CLOSED_RATIO, params.takerPositionSize.abs());

        // int256 pnlToBeRealized;
        // // if closedRatio <= 1, it's reducing or closing a position; else, it's opening a larger reverse position
        // if (closedRatio <= _FULLY_CLOSED_RATIO) {
        //     // https://docs.google.com/spreadsheets/d/1QwN_UZOiASv3dPBP7bNVdLR_GTaZGUrHW3-29ttMbLs/edit#gid=148137350
        //     // taker:
        //     // step 1: long 20 base
        //     // openNotionalFraction = 252.53
        //     // openNotional = -252.53
        //     // step 2: short 10 base (reduce half of the position)
        //     // quote = 137.5
        //     // closeRatio = 10/20 = 0.5
        //     // reducedOpenNotional = openNotional * closedRatio = -252.53 * 0.5 = -126.265
        //     // realizedPnl = quote + reducedOpenNotional = 137.5 + -126.265 = 11.235
        //     // openNotionalFraction = openNotionalFraction - quote + realizedPnl
        //     //                      = 252.53 - 137.5 + 11.235 = 126.265
        //     // openNotional = -openNotionalFraction = 126.265

        //     // overflow inspection:
        //     // max closedRatio = 1e18; range of oldOpenNotional = (-2 ^ 255, 2 ^ 255)
        //     // only overflow when oldOpenNotional < -2 ^ 255 / 1e18 or oldOpenNotional > 2 ^ 255 / 1e18
        //     int256 reducedOpenNotional = params.takerOpenNotional.mulDiv(closedRatio.toInt256(), _FULLY_CLOSED_RATIO);
        //     pnlToBeRealized = params.quote.add(reducedOpenNotional);

        expect(settledFundingAfter).to.be.gt(settledFundingBefore.add(pendingFundingBefore));
        expect(settledFundingAfter).to.be.eq(settledFundingBefore.add(exactPendingFunding));
      });

      it("should set the expected USDC externalPositionUnit", async () => {
        const usdcTransferOutQuantity = await calculateUSDCTransferOutPreciseUnits(
          setToken,
          subjectSetQuantity,
          perpBasisTradingModule,
          perpSetup
        );
        const settledFundingBefore = await perpBasisTradingModule.settledFunding(subjectSetToken);
        const [owedRealizedPnlBefore, ] = await perpSetup.accountBalance.getPnlAndPendingFee(subjectSetToken);
        const performanceFeePercentage = (await perpBasisTradingModule.feeStates(subjectSetToken)).performanceFeePercentage;

        await subject();
        
        const [owedRealizedPnlAfter, ] = await perpSetup.accountBalance.getPnlAndPendingFee(subjectSetToken);
        const exactPendingFunding = owedRealizedPnlAfter.abs().sub(owedRealizedPnlBefore.abs());
        
        const performanceFeeUnit = toUSDCDecimals(
          preciseMul(
            preciseDivCeil(settledFundingBefore.add(exactPendingFunding), subjectSetQuantity),
            performanceFeePercentage
          )
        );
        console.log(settledFundingBefore.toString())
        console.log(settledFundingBefore.add(exactPendingFunding).toString());
        console.log(performanceFeePercentage.toString());
        console.log(performanceFeeUnit.toString());

        const expectedExternalPositionUnit = toUSDCDecimals(
          preciseDiv(usdcTransferOutQuantity, subjectSetQuantity)
        );
        console.log(expectedExternalPositionUnit.toString());
        console.log(expectedExternalPositionUnit.sub(performanceFeeUnit).toString());

        const externalPositionUnit = await setToken.getExternalPositionRealUnit(
          usdc.address,
          perpBasisTradingModule.address
        );

        expect(externalPositionUnit).to.eq(expectedExternalPositionUnit.sub(performanceFeeUnit));
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
        await perpSetup.setBaseTokenOraclePrice(vETH, usdcUnits(10.5));
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
});