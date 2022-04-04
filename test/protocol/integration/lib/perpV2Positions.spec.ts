import "module-alias/register";

import { Address } from "@utils/types";
import { Account } from "@utils/test/types";
import {
  PositionV2,
  PerpV2LibraryV2,
  PerpV2Positions,
  PerpV2LeverageModuleV2,
  DebtIssuanceMock,
  PerpV2PositionsMock,
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
  preciseMul
} from "@utils/index";

import {
  cacheBeforeEach,
  getAccounts,
  getWaffleExpect,
  getSystemFixture,
  getPerpV2Fixture,
} from "@utils/test/index";

import { PerpV2Fixture, SystemFixture } from "@utils/fixtures";
import { ADDRESS_ZERO, ZERO } from "@utils/constants";
import { BigNumber } from "ethers";

const expect = getWaffleExpect();

describe("PerpV2Positions", () => {
  let owner: Account;
  let maker: Account;
  let otherTrader: Account;
  let mockModule: Account;
  let deployer: DeployHelper;
  let maxPerpPositionsPerSet: BigNumber;

  let positionLib: PositionV2;
  let perpLib: PerpV2LibraryV2;
  let perpPositionsLib: PerpV2Positions;
  let perpLeverageModule: PerpV2LeverageModuleV2;
  let perpPositionsMock: PerpV2PositionsMock;
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

    maxPerpPositionsPerSet = BigNumber.from(2);
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

    perpPositionsLib = await deployer.libraries.deployPerpV2Positions();
    perpPositionsMock = await deployer.mocks.deployPerpV2PositionsMock(
      "contracts/protocol/integration/lib/PerpV2Positions.sol:PerpV2Positions",
      perpPositionsLib.address
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

      await usdc.approve(setup.issuanceModule.address, preciseMul(usdcUnits(100), issueQuantity));
      await setup.issuanceModule.initialize(setToken.address, ADDRESS_ZERO);
      await setup.issuanceModule.issue(setToken.address, issueQuantity, owner.address);

      await perpLeverageModule.deposit(setToken.address, depositQuantityUnit);
    }

    return setToken;
  }

  describe("#getNetQuoteBalance", () => {
    let setToken: SetToken;

    let subjectSetToken: Address;
    let subjectBaseTokens: Address[];
    let subjectPerpAccountBalance: Address;

    beforeEach(async () => {
      // Issue 2 sets
      const issueQuantity = ether(2);
      setToken = await issueSetsAndDepositToPerp(usdcUnits(100), true, issueQuantity);

      await perpLeverageModule.connect(owner.wallet).trade(
        setToken.address,
        vETH.address,
        preciseDiv(ether(1), issueQuantity),
        preciseDiv(ether(10.15), issueQuantity)
      );

      await perpLeverageModule.connect(owner.wallet).trade(
        setToken.address,
        vBTC.address,
        preciseDiv(ether(1), issueQuantity),
        preciseDiv(ether(50.575), issueQuantity)
      );

      subjectSetToken = setToken.address;
      subjectBaseTokens = [vETH.address, vBTC.address];
      subjectPerpAccountBalance = perpSetup.accountBalance.address;
    });

    async function subject(): Promise<any> {
      return perpPositionsMock.testGetNetQuoteBalance(
        subjectSetToken,
        subjectBaseTokens,
        subjectPerpAccountBalance
      );
    }

    it("should return correct net quote balance", async () => {
      const vETHQuoteBalance = await perpSetup.accountBalance.getQuote(subjectSetToken, vETH.address);
      const vBTCQuoteBalance = await perpSetup.accountBalance.getQuote(subjectSetToken, vBTC.address);
      const expectedNetQuoteBalance = vETHQuoteBalance.add(vBTCQuoteBalance);

      const netQuoteBalance = await subject();

      expect(netQuoteBalance).to.be.eq(expectedNetQuoteBalance);
    });
  });

  describe("#getPositionNotionalInfo", () => {
    let setToken: SetToken;
    let issueQuantity: BigNumber;
    let expectedVETHToken: Address;
    let expectedVBTCToken: Address;
    let vethTradeQuantityUnits: BigNumber;
    let vbtcTradeQuantityUnits: BigNumber;
    let expectedDepositQuantity: BigNumber;
    let expectedVETHDeltaQuote: BigNumber;
    let expectedVBTCDeltaQuote: BigNumber;

    let subjectSetToken: Address;
    let subjectBaseTokens: Address[];
    let subjectPerpAccountBalance: Address;

    beforeEach(async () => {
      expectedDepositQuantity = usdcUnits(100);
      issueQuantity = ether(2);

      setToken = await issueSetsAndDepositToPerp(expectedDepositQuantity, true, issueQuantity);

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
        setToken.address,
        expectedVETHToken,
        vethTradeQuantityUnits,
        vETHQuoteBoundQuantityUnits
      );

      await perpLeverageModule.connect(owner.wallet).trade(
        setToken.address,
        expectedVBTCToken,
        vbtcTradeQuantityUnits,
        vBTCQuoteBoundQuantityUnits
      );

      subjectSetToken = setToken.address;
      subjectBaseTokens = [vETH.address, vBTC.address];
      subjectPerpAccountBalance = perpSetup.accountBalance.address;
    });

    async function subject(): Promise<any> {
      return perpPositionsMock.testGetPositionNotionalInfo(
        subjectSetToken,
        subjectBaseTokens,
        subjectPerpAccountBalance
      );
    }

    it("should return correct notional info for multiple positions", async () => {
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
    let expectedVETHToken: Address;
    let expectedVBTCToken: Address;
    let vethTradeQuantityUnits: BigNumber;
    let vbtcTradeQuantityUnits: BigNumber;
    let expectedDepositQuantity: BigNumber;
    let expectedVETHQuoteUnits: BigNumber;
    let expectedVBTCQuoteUnits: BigNumber;

    let subjectSetToken: Address;
    let subjectBaseTokens: Address[];
    let subjectPerpAccountBalance: Address;

    beforeEach(async () => {
      issueQuantity = ether(2);
      expectedDepositQuantity = usdcUnits(100);

      // Issue 2 sets
      setToken = await issueSetsAndDepositToPerp(expectedDepositQuantity, true, issueQuantity);

      expectedVETHToken = vETH.address;
      expectedVBTCToken = vBTC.address;
      vethTradeQuantityUnits = preciseDiv(ether(1), issueQuantity);
      vbtcTradeQuantityUnits = preciseDiv(ether(1), issueQuantity);

      const vETHQuoteBoundQuantityUnits = preciseDiv(ether(10.15), issueQuantity);
      const vBTCQuoteBoundQuantityUnits = preciseDiv(ether(50.575), issueQuantity);

      await perpLeverageModule.connect(owner.wallet).trade(
        setToken.address,
        expectedVETHToken,
        vethTradeQuantityUnits,
        vETHQuoteBoundQuantityUnits
      );

      await perpLeverageModule.connect(owner.wallet).trade(
        setToken.address,
        expectedVBTCToken,
        vbtcTradeQuantityUnits,
        vBTCQuoteBoundQuantityUnits
      );

      subjectSetToken = setToken.address;
      subjectBaseTokens = [vETH.address, vBTC.address];
      subjectPerpAccountBalance = perpSetup.accountBalance.address;
    });

    async function subject(): Promise<any> {
      return perpPositionsMock.testGetPositionUnitInfo(
        subjectSetToken,
        subjectBaseTokens,
        subjectPerpAccountBalance
      );
    }

    it("should return correct unit info for multiple positions", async () => {
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

  describe("#formatAdjustments", () => {
    let setToken: SetToken;

    let subjectSetToken: Address;
    let subjectAdjustmentComponent: Address;
    let subjectCurrentExternalPositionUnit: BigNumber;
    let subjectNewExternalPositionUnit: BigNumber;

    beforeEach(async () => {
      // Issue 2 sets
      const issueQuantity = ether(2);
      setToken = await issueSetsAndDepositToPerp(usdcUnits(100), true, issueQuantity);

      subjectSetToken = setToken.address;
      subjectAdjustmentComponent = perpSetup.usdc.address;
      subjectCurrentExternalPositionUnit = usdcUnits(50);
      subjectNewExternalPositionUnit = usdcUnits(100);
    });

    async function subject(): Promise<any> {
      return perpPositionsMock.testFormatAdjustments(
        subjectSetToken,
        subjectAdjustmentComponent,
        subjectCurrentExternalPositionUnit,
        subjectNewExternalPositionUnit
      );
    }

    it("should return correct equity and debt adjustments", async () => {
      const components = await setToken.getComponents();
      const expectedEquityAdjustments = await Promise.all(
        components.map(async (value): Promise<BigNumber> => {
          if (value === subjectAdjustmentComponent) {
            return subjectNewExternalPositionUnit.sub(subjectCurrentExternalPositionUnit);
          }
          return ZERO;
        })
      );
      const expectedDebtAdjustments = components.map(() => ZERO);

      const [equityAdjustments, debtAdjustments] = await subject();

      equityAdjustments.map((value: BigNumber, index: number) =>
        expect(value).to.be.eq(expectedEquityAdjustments[index])
      );
      debtAdjustments.map((value: BigNumber, index: number) =>
        expect(value).to.be.eq(expectedDebtAdjustments[index])
      );
    });
  });
});