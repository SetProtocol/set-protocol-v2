import "module-alias/register";

import { Address } from "@utils/types";
import { Account } from "@utils/test/types";
import {
  PositionV2,
  PerpV2LibraryV2,
  PerpV2Positions,
  PerpV2LeverageModuleV2,
  DebtIssuanceMock,
  PerpV2LeverageModuleViewer,
  StandardTokenMock,
  SetToken,
} from "@utils/contracts";

import { PerpV2BaseToken } from "@utils/contracts/perpV2";

import DeployHelper from "@utils/deploys";
import {
  ether,
  bitcoin,
  usdc as usdcUnits,
  preciseDiv,
} from "@utils/index";

import {
  calculateLeverageRatios,
  leverUp,
  calculateMaxIssueQuantity,
} from "@utils/common";

import {
  cacheBeforeEach,
  getAccounts,
  getWaffleExpect,
  getSystemFixture,
  getPerpV2Fixture,
} from "@utils/test/index";

import { PerpV2Fixture, SystemFixture } from "@utils/fixtures";
import { ADDRESS_ZERO, ZERO, MAX_UINT_256 } from "@utils/constants";
import { BigNumber } from "ethers";

const expect = getWaffleExpect();

describe("PerpV2LeverageModuleViewer", () => {
  let owner: Account;
  let maker: Account;
  let otherTrader: Account;
  let mockModule: Account;
  let deployer: DeployHelper;

  let positionLib: PositionV2;
  let perpLib: PerpV2LibraryV2;
  let perpPositionsLib: PerpV2Positions;
  let perpLeverageModule: PerpV2LeverageModuleV2;
  let perpViewer: PerpV2LeverageModuleViewer;
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

    // Deploy libraries
    positionLib = await deployer.libraries.deployPositionV2();
    perpLib = await deployer.libraries.deployPerpV2LibraryV2();
    perpPositionsLib = await deployer.libraries.deployPerpV2Positions();

    perpLeverageModule = await deployer.modules.deployPerpV2LeverageModuleV2(
      setup.controller.address,
      perpSetup.vault.address,
      perpSetup.quoter.address,
      perpSetup.marketRegistry.address,
      BigNumber.from(3),
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

  // Creates SetToken, issues sets (default: 1), initializes PerpV2LeverageModule and deposits to Perp
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

      await usdc.approve(setup.issuanceModule.address, usdcUnits(1000));
      await setup.issuanceModule.initialize(setToken.address, ADDRESS_ZERO);
      await setup.issuanceModule.issue(setToken.address, issueQuantity, owner.address);

      await perpLeverageModule.deposit(setToken.address, depositQuantityUnit);
    }

    return setToken;
  }

  describe("#constructor", () => {
    let subjectPerpModule: Address;
    let subjectPerpAccountBalance: Address;
    let subjectPerpClearingHouseConfig: Address;
    let subjectVQuoteToken: Address;

    const initializeSubjectVariables = () => {
      subjectPerpModule = perpLeverageModule.address;
      subjectPerpAccountBalance = perpSetup.accountBalance.address;
      subjectPerpClearingHouseConfig = perpSetup.clearingHouseConfig.address;
      subjectVQuoteToken = perpSetup.vQuote.address;
    };

    beforeEach(initializeSubjectVariables);

    async function subject(): Promise<PerpV2LeverageModuleViewer> {
      return await deployer.viewers.deployPerpV2LeverageModuleViewer(
        subjectPerpModule,
        subjectPerpAccountBalance,
        subjectPerpClearingHouseConfig,
        subjectVQuoteToken
      );
    }

    it("should set the correct public variables", async () => {
      const perpViewer = await subject();

      const actualPerpModule = await perpViewer.perpModule();
      const actualPerpAccountBalance = await perpViewer.perpAccountBalance();
      const actualPerpClearingHouseConfig = await perpViewer.perpClearingHouseConfig();

      expect(actualPerpModule).eq(subjectPerpModule);
      expect(actualPerpAccountBalance).eq(subjectPerpAccountBalance);
      expect(actualPerpClearingHouseConfig).eq(subjectPerpClearingHouseConfig);
    });
  });

  describe("#getMaximumSetTokenIssueAmount", () => {
    let setToken: SetToken;
    let collateralQuantity: BigNumber;

    let subjectSetToken: Address;
    let subjectSlippage: BigNumber;

    const initializeContracts = async () => {
      collateralQuantity = usdcUnits(10);
      setToken = await issueSetsAndDepositToPerp(collateralQuantity);

      perpViewer = await deployer.viewers.deployPerpV2LeverageModuleViewer(
        perpLeverageModule.address,
        perpSetup.accountBalance.address,
        perpSetup.clearingHouseConfig.address,
        perpSetup.vQuote.address
      );
    };

    const initializeSubjectVariables = async () => {
      subjectSetToken = setToken.address;
      subjectSlippage = ether(0.01);
    };

    cacheBeforeEach(initializeContracts);
    beforeEach(initializeSubjectVariables);

    async function subject(): Promise<any> {
      return await perpViewer.getMaximumSetTokenIssueAmount(subjectSetToken, subjectSlippage);
    }

    describe("when long", async () => {
      let baseToken: Address;

      // Set up as 2X Long, allow 2% slippage
      beforeEach(async () => {
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

      it("should return the correct max issue amount", async () => {
        const actualIssuanceMax = await subject();

        const expectedIssuanceMax = await calculateMaxIssueQuantity(
          setToken,
          subjectSlippage,
          perpLeverageModule,
          perpSetup
        );

        expect(actualIssuanceMax).eq(expectedIssuanceMax);
      });
    });

    describe("when short", async () => {
      let baseToken: Address;

      // Set up as 2X Short, allow 2% slippage
      beforeEach(async () => {
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

      it("should return the correct max issue amount", async () => {
        const actualIssuanceMax = await subject();

        const expectedIssuanceMax = await calculateMaxIssueQuantity(
          setToken,
          subjectSlippage,
          perpLeverageModule,
          perpSetup
        );

        expect(actualIssuanceMax).eq(expectedIssuanceMax);
      });
    });

    describe("when no position is open", async () => {
      it("should return the correct max issue amount (max uint256)", async () => {
        const actualIssuanceMax = await subject();
        expect(actualIssuanceMax).eq(MAX_UINT_256);
      });
    });
  });

  describe("#getVirtualAssetsDisplayInfo", () => {
    let setToken: SetToken;
    let collateralQuantity: BigNumber;

    let subjectSetToken: Address;

    const initializeContracts = async () => {
      collateralQuantity = usdcUnits(10);
      setToken = await issueSetsAndDepositToPerp(collateralQuantity);

      perpViewer = await deployer.viewers.deployPerpV2LeverageModuleViewer(
        perpLeverageModule.address,
        perpSetup.accountBalance.address,
        perpSetup.clearingHouseConfig.address,
        perpSetup.vQuote.address
      );
    };

    const initializeSubjectVariables = () => {
      subjectSetToken = setToken.address;
    };

    cacheBeforeEach(initializeContracts);
    beforeEach(initializeSubjectVariables);

    async function subject(): Promise<any[]> {
      return await perpViewer.getVirtualAssetsDisplayInfo(subjectSetToken);
    }

    describe("when long", async () => {
      // Set up as 2X Long, allow 2% slippage
      cacheBeforeEach(async () => {
        const baseToken = vETH.address;

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

      it("should return the correct base asset info", async () => {
        const assetInfo: any[] = await subject();

        const positionUnitInfo = await perpLeverageModule.getPositionUnitInfo(setToken.address);
        const expectedIndexPrice = await perpSetup.vETH.getIndexPrice(0);
        const expectedSymbol = await perpSetup.vETH.symbol();

        expect(assetInfo[0].symbol).eq(expectedSymbol);
        expect(assetInfo[0].vAssetAddress).eq(perpSetup.vETH.address);
        expect(assetInfo[0].positionUnit).eq(positionUnitInfo[0].baseUnit);
        expect(assetInfo[0].indexPrice).eq(expectedIndexPrice);
      });

      it("should return the correct leverage ratio", async () => {
        const assetInfo: any[] = await subject();

        const [ , expectedLeverageRatios] = await calculateLeverageRatios(
          subjectSetToken,
          perpLeverageModule,
          perpSetup
        );

        expect(assetInfo[0].currentLeverageRatio).eq(expectedLeverageRatios[0]);
      });

      it("should return the correct quote asset info", async () => {
        const assetInfo: any[] = await subject();

        const accountInfo = await perpLeverageModule.getAccountInfo(setToken.address);

        const setTotalSupply = await setToken.totalSupply();
        const expectedPositionUnit = preciseDiv(accountInfo.netQuoteBalance, setTotalSupply);
        const expectedSymbol = await perpSetup.vQuote.symbol();

        expect(assetInfo[1].symbol).eq(expectedSymbol);
        expect(assetInfo[1].vAssetAddress).eq(perpSetup.vQuote.address);
        expect(assetInfo[1].positionUnit).eq(expectedPositionUnit);
        expect(assetInfo[1].indexPrice).eq(ether(1));
        expect(assetInfo[1].currentLeverageRatio).eq(ZERO);
      });
    });

    describe("when short", async () => {
      // Set up as 2X Short, allow 2% slippage
      cacheBeforeEach(async () => {
        const baseToken = vETH.address;

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

      it("should return the correct base asset info", async () => {
        const assetInfo: any[] = await subject();

        const positionUnitInfo = await perpLeverageModule.getPositionUnitInfo(setToken.address);
        const expectedIndexPrice = await perpSetup.vETH.getIndexPrice(0);
        const expectedSymbol = await perpSetup.vETH.symbol();

        expect(assetInfo[0].symbol).eq(expectedSymbol);
        expect(assetInfo[0].vAssetAddress).eq(perpSetup.vETH.address);
        expect(assetInfo[0].positionUnit).eq(positionUnitInfo[0].baseUnit);
        expect(assetInfo[0].indexPrice).eq(expectedIndexPrice);
      });

      it("should return the correct leverage ratio", async () => {
        const assetInfo: any[] = await subject();

        const [ , expectedLeverageRatios] = await calculateLeverageRatios(
          subjectSetToken,
          perpLeverageModule,
          perpSetup
        );

        expect(assetInfo[0].currentLeverageRatio).eq(expectedLeverageRatios[0]);
      });

      it("should return the correct quote asset info", async () => {
        const assetInfo: any[] = await subject();

        const accountInfo = await perpLeverageModule.getAccountInfo(setToken.address);

        const setTotalSupply = await setToken.totalSupply();
        const expectedPositionUnit = preciseDiv(accountInfo.netQuoteBalance, setTotalSupply);
        const expectedSymbol = await perpSetup.vQuote.symbol();

        expect(assetInfo[1].symbol).eq(expectedSymbol);
        expect(assetInfo[1].vAssetAddress).eq(perpSetup.vQuote.address);
        expect(assetInfo[1].positionUnit).eq(expectedPositionUnit);
        expect(assetInfo[1].indexPrice).eq(ether(1));
        expect(assetInfo[1].currentLeverageRatio).eq(ZERO);
      });
    });

    describe("when long and short", async () => {
      // Set up as 2X Long in ETH and short in BTC, allow 2% slippage
      cacheBeforeEach(async () => {
        const longBaseToken = vETH.address;
        const shortBaseToken = vBTC.address;

        await leverUp(
          setToken,
          perpLeverageModule,
          perpSetup,
          owner,
          longBaseToken,
          2,
          ether(.02),
          true
        );

        await leverUp(
          setToken,
          perpLeverageModule,
          perpSetup,
          owner,
          shortBaseToken,
          2,
          ether(.02),
          false
        );
      });

      it("should return the correct base asset info", async () => {
        const assetInfo: any[] = await subject();

        const positionUnitInfo = await perpLeverageModule.getPositionUnitInfo(setToken.address);
        const expectedLongIndexPrice = await perpSetup.vETH.getIndexPrice(0);
        const expectedLongSymbol = await perpSetup.vETH.symbol();
        const expectedShortIndexPrice = await perpSetup.vBTC.getIndexPrice(0);
        const expectedShortSymbol = await perpSetup.vBTC.symbol();

        expect(assetInfo[0].symbol).eq(expectedLongSymbol);
        expect(assetInfo[0].vAssetAddress).eq(perpSetup.vETH.address);
        expect(assetInfo[0].positionUnit).eq(positionUnitInfo[0].baseUnit);
        expect(assetInfo[0].indexPrice).eq(expectedLongIndexPrice);
        expect(assetInfo[1].symbol).eq(expectedShortSymbol);
        expect(assetInfo[1].vAssetAddress).eq(perpSetup.vBTC.address);
        expect(assetInfo[1].positionUnit).eq(positionUnitInfo[1].baseUnit);
        expect(assetInfo[1].indexPrice).eq(expectedShortIndexPrice);
      });

      it("should return the correct leverage ratio", async () => {
        const assetInfo: any[] = await subject();

        const [ , expectedLeverageRatios] = await calculateLeverageRatios(
          subjectSetToken,
          perpLeverageModule,
          perpSetup
        );

        expect(assetInfo[0].currentLeverageRatio).eq(expectedLeverageRatios[0]);
        expect(assetInfo[1].currentLeverageRatio).eq(expectedLeverageRatios[1]);
      });

      it("should return the correct quote asset info", async () => {
        const assetInfo: any[] = await subject();

        const accountInfo = await perpLeverageModule.getAccountInfo(setToken.address);

        const setTotalSupply = await setToken.totalSupply();
        const expectedPositionUnit = preciseDiv(accountInfo.netQuoteBalance, setTotalSupply);
        const expectedSymbol = await perpSetup.vQuote.symbol();

        expect(assetInfo[2].symbol).eq(expectedSymbol);
        expect(assetInfo[2].vAssetAddress).eq(perpSetup.vQuote.address);
        expect(assetInfo[2].positionUnit).eq(expectedPositionUnit);
        expect(assetInfo[2].indexPrice).eq(ether(1));
        expect(assetInfo[2].currentLeverageRatio).eq(ZERO);
      });
    });

    describe("when no position is open", async () => {
      it("should return an array with empty quote asset positions", async () => {
        const assetInfo: any[] = await subject();

        const accountInfo = await perpLeverageModule.getAccountInfo(setToken.address);

        const setTotalSupply = await setToken.totalSupply();
        const expectedPositionUnit = preciseDiv(accountInfo.netQuoteBalance, setTotalSupply);
        const expectedSymbol = await perpSetup.vQuote.symbol();

        expect(assetInfo[0].symbol).eq(expectedSymbol);
        expect(assetInfo[0].vAssetAddress).eq(perpSetup.vQuote.address);
        expect(assetInfo[0].positionUnit).eq(expectedPositionUnit);
        expect(assetInfo[0].indexPrice).eq(ether(1));
        expect(assetInfo[0].currentLeverageRatio).eq(ZERO);
      });
    });
  });

  describe("#getTotalCollateralUnit", () => {
    let setToken: SetToken;
    let collateralQuantity: BigNumber;

    let subjectSetToken: Address;

    const initializeContracts = async () => {
      collateralQuantity = usdcUnits(10);
      setToken = await issueSetsAndDepositToPerp(collateralQuantity);

      perpViewer = await deployer.viewers.deployPerpV2LeverageModuleViewer(
        perpLeverageModule.address,
        perpSetup.accountBalance.address,
        perpSetup.clearingHouseConfig.address,
        perpSetup.vQuote.address
      );
    };

    const initializeSubjectVariables = () => {
      subjectSetToken = setToken.address;
    };

    cacheBeforeEach(initializeContracts);
    beforeEach(initializeSubjectVariables);

    async function subject(): Promise<[string, BigNumber]> {
      return await perpViewer.getTotalCollateralUnit(subjectSetToken);
    }

    it("should return the correct max issue amount", async () => {
      const [ collateralToken, collateralUnit ] = await subject();

      const totalSupply = await setToken.totalSupply();
      const accountInfo = await perpLeverageModule.getAccountInfo(setToken.address);
      const totalCollateral = accountInfo.collateralBalance
        .add(accountInfo.owedRealizedPnl)
        .add(accountInfo.pendingFundingPayments);

      const expectedCollateralUnit = preciseDiv(totalCollateral, totalSupply);

      expect(collateralToken).eq(perpSetup.usdc.address);
      expect(collateralUnit).eq(expectedCollateralUnit);
    });
  });
});