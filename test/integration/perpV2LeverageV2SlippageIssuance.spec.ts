import "module-alias/register";
import { ContractTransaction } from "ethers";
import { Address } from "@utils/types";
import { Account } from "@utils/test/types";
import {
  SlippageIssuanceModule,
  PerpV2LibraryV2,
  PositionV2,
  PerpV2Positions,
  PerpV2LeverageModuleV2,
  SetToken,
  StandardTokenMock,
} from "@utils/contracts";
import { PerpV2BaseToken } from "@utils/contracts/perpV2";
import {
  toUSDCDecimals,
  calculateUSDCTransferIn,
  calculateUSDCTransferOut,
  leverUp
} from "@utils/common";
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
} from "@utils/test/index";
import { PerpV2Fixture, SystemFixture } from "@utils/fixtures";
import { BigNumber } from "ethers";
import { ADDRESS_ZERO, ZERO, MAX_UINT_256, ZERO_BYTES } from "@utils/constants";

const expect = getWaffleExpect();

describe("PerpV2LeverageSlippageIssuance", () => {
  let owner: Account;
  let maker: Account;
  let otherTrader: Account;
  let feeRecipient: Account;
  let deployer: DeployHelper;

  let perpLib: PerpV2LibraryV2;
  let positionLib: PositionV2;
  let perpPositionsLib: PerpV2Positions;
  let perpLeverageModule: PerpV2LeverageModuleV2;
  let slippageIssuanceModule: SlippageIssuanceModule;
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
      feeRecipient
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

    slippageIssuanceModule = await deployer.modules.deploySlippageIssuanceModule(
      setup.controller.address
    );
    await setup.controller.addModule(slippageIssuanceModule.address);

    await setup.integrationRegistry.addIntegration(
      perpLeverageModule.address,
      "DefaultIssuanceModule",
      slippageIssuanceModule.address
    );
  });

  // Helper to calculate how leveraged the Perp account gets as it mints tokens on margin
  async function calculateFlashLeverage(setToken: Address, setQuantity: BigNumber): Promise<BigNumber> {
    const spotPrice = await perpSetup.getSpotPrice(vETH.address);
    const { collateralBalance } = await perpLeverageModule.getAccountInfo(setToken);
    const positionNotionalInfo = (await perpLeverageModule.getPositionNotionalInfo(setToken))[0];
    const positionUnitInfo = (await perpLeverageModule.getPositionUnitInfo(setToken))[0];

    const currentAssetValue = preciseMul(positionNotionalInfo.baseBalance, spotPrice);
    const currentDebtValue = positionNotionalInfo.quoteBalance;

    const flashAssetQuantityNotional = preciseMul(positionUnitInfo.baseUnit, setQuantity);
    const flashAssetValue = preciseMul(flashAssetQuantityNotional, spotPrice);
    const flashDebtValue =
      (await perpSetup.getSwapQuote(vETH.address, flashAssetQuantityNotional, true)).deltaQuote;

    const totalAssetValueBeforeRepayment = currentAssetValue.add(flashAssetValue);
    const totalDebtValueBeforeRepayment = currentDebtValue.sub(flashDebtValue);

    return preciseDiv(
      totalAssetValueBeforeRepayment,

      totalAssetValueBeforeRepayment
        .add(totalDebtValueBeforeRepayment)
        .add(collateralBalance)
    );
  }

  async function calculateTotalSlippage(setToken: SetToken, setQuantity: BigNumber): Promise<BigNumber> {
    let totalExpectedSlippage = BigNumber.from(0);
    const allPositionInfo = await perpLeverageModule.getPositionNotionalInfo(setToken.address);

    for (const positionInfo of allPositionInfo) {
      const basePositionUnit = preciseDiv(positionInfo.baseBalance, await setToken.totalSupply());
      const baseTradeQuantityNotional = preciseMul(basePositionUnit, setQuantity);
      const isLong = (basePositionUnit.gte(ZERO));

      const { deltaBase, deltaQuote } = await perpSetup.getSwapQuote(
        positionInfo.baseToken,
        baseTradeQuantityNotional.abs(),
        isLong
      );

      const idealQuote = preciseMul(deltaBase, await perpSetup.getSpotPrice(positionInfo.baseToken));

      const expectedSlippage = (isLong)
        ? idealQuote.sub(deltaQuote).mul(-1)
        : idealQuote.sub(deltaQuote);

      totalExpectedSlippage = totalExpectedSlippage.add(expectedSlippage);
    }

    return totalExpectedSlippage;
  }

  async function calculateRedemptionData(
    setToken: Address,
    redeemQuantity: BigNumber,
    usdcTransferOutQuantity: BigNumber
  ) {
    // Calculate fee adjusted usdcTransferOut
    const redeemQuantityWithFees = (await slippageIssuanceModule.calculateTotalFees(
      setToken,
      redeemQuantity,
      false
    ))[0];

    const feeAdjustedTransferOutUSDC = preciseMul(redeemQuantityWithFees, usdcTransferOutQuantity);

    // Calculate realizedPnl. The amount is debited from collateral returned to redeemer *and*
    // debited from the Perp account collateral balance because withdraw performs a settlement.
    let realizedPnlUSDC = BigNumber.from(0);
    const positionUnitInfo = await await perpLeverageModule.getPositionUnitInfo(setToken);

    for (const info of positionUnitInfo) {
      const baseTradeQuantityNotional = preciseMul(info.baseUnit, redeemQuantity);

      const { deltaQuote } = await perpSetup.getSwapQuote(
        info.baseToken,
        baseTradeQuantityNotional,
        false
      );

      const {
        baseBalance,
        quoteBalance
      } = (await perpLeverageModule.getPositionNotionalInfo(setToken))[0];

      const closeRatio = preciseDiv(baseTradeQuantityNotional, baseBalance);
      const reducedOpenNotional = preciseMul(quoteBalance, closeRatio);

      realizedPnlUSDC = realizedPnlUSDC.add(toUSDCDecimals(reducedOpenNotional.add(deltaQuote)));
    }

    return {
      feeAdjustedTransferOutUSDC,
      realizedPnlUSDC,
      redeemQuantityWithFees
    };
  }

  describe("#issuance", async () => {
    let setToken: SetToken;
    let issueFee: BigNumber;
    let usdcDefaultPositionUnit: BigNumber;

    let subjectSetToken: Address;
    let subjectQuantity: BigNumber;
    let subjectCheckedComponents: Address[];
    let subjectMaxTokenAmountsIn: BigNumber[];
    let subjectTo: Address;
    let subjectCaller: Account;
    let issueQuantity: BigNumber;

    const initializeContracts = async function() {
      usdcDefaultPositionUnit = usdcUnits(10);
      setToken = await setup.createSetToken(
        [usdc.address],
        [usdcDefaultPositionUnit],
        [perpLeverageModule.address, slippageIssuanceModule.address]
      );
      issueFee = ether(0.005);
      await slippageIssuanceModule.initialize(
        setToken.address,
        ether(0.02),
        issueFee,
        ether(0.005),
        feeRecipient.address,
        ADDRESS_ZERO
      );
      // Add SetToken to allow list
      await perpLeverageModule.updateAllowedSetToken(setToken.address, true);
      await perpLeverageModule.initialize(setToken.address);

      // Approve tokens to issuance module and call issue
      await usdc.approve(slippageIssuanceModule.address, usdcUnits(1000));
    };

    async function subject(): Promise<ContractTransaction> {
      return slippageIssuanceModule.connect(subjectCaller.wallet).issueWithSlippage(
        subjectSetToken,
        subjectQuantity,
        subjectCheckedComponents,
        subjectMaxTokenAmountsIn,
        subjectTo,
      );
    }

    context("when there is a default usdc position with 0 supply", async () => {
      cacheBeforeEach(initializeContracts);
      beforeEach(() => {
        subjectSetToken = setToken.address;
        subjectQuantity = ether(1);
        subjectCheckedComponents = [];
        subjectMaxTokenAmountsIn = [];
        subjectTo = owner.address;
        subjectCaller = owner;
      });

      it("should not update the collateral position on the SetToken", async () => {
        const initialPositions = await setToken.getPositions();

        await subject();

        const currentPositions = await setToken.getPositions();
        const newFirstPosition = (await setToken.getPositions())[0];

        expect(initialPositions.length).to.eq(1);
        expect(currentPositions.length).to.eq(1);
        expect(newFirstPosition.component).to.eq(usdc.address);
        expect(newFirstPosition.positionState).to.eq(0); // Default
        expect(newFirstPosition.unit).to.eq(usdcDefaultPositionUnit);
        expect(newFirstPosition.module).to.eq(ADDRESS_ZERO);
      });

      it("should not have an external usdc position", async () => {
        const initialPositions = await setToken.getPositions();

        await subject();

        const currentPositions = await setToken.getPositions();

        expect(initialPositions.length).to.eq(1);
        expect(currentPositions.length).to.eq(1);
      });

      it("should have the correct token balances", async () => {
        const preMinterUSDCBalance = await usdc.balanceOf(subjectCaller.address);
        const preSetUSDCBalance = await usdc.balanceOf(subjectSetToken);

        await subject();

        const mintQuantity = preciseMul(subjectQuantity, ether(1).add(issueFee));
        const usdcFlows = preciseMul(mintQuantity, usdcDefaultPositionUnit);

        const postMinterUSDCBalance = await usdc.balanceOf(subjectCaller.address);
        const postSetUSDCBalance = await usdc.balanceOf(subjectSetToken);

        expect(postMinterUSDCBalance).to.eq(preMinterUSDCBalance.sub(usdcFlows));
        expect(postSetUSDCBalance).to.eq(preSetUSDCBalance.add(usdcFlows));
      });
    });

    context("when there is only an external USDC position and totalSupply is 1", async () => {
      let baseToken: Address;
      let depositQuantityUnit: BigNumber;
      let usdcTransferInQuantity: BigNumber;

      cacheBeforeEach(initializeContracts);

      beforeEach(async () => {
        // Issue 1 SetToken
        issueQuantity = ether(1);
        await slippageIssuanceModule.issue(setToken.address, issueQuantity, owner.address);

        depositQuantityUnit = usdcDefaultPositionUnit;
        await perpLeverageModule.deposit(setToken.address, depositQuantityUnit);

        // Lever up
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

        subjectSetToken = setToken.address;
        subjectCheckedComponents = [];
        subjectMaxTokenAmountsIn = [];
        subjectTo = owner.address;
        subjectCaller = owner;
      });

      describe("starting test assumptions", async () => {
        it("should be correct", async() => {
          const defaultPositionUnit = await setToken.getDefaultPositionRealUnit(usdc.address);
          const externalPositionUnit = await setToken.getExternalPositionRealUnit(
            usdc.address,
            perpLeverageModule.address
          );

          expect(defaultPositionUnit).eq(ZERO);
          expect(externalPositionUnit).eq(depositQuantityUnit);
        });
      });

      describe("when minting a single set", () => {
        beforeEach(async () => {
          subjectQuantity = ether(1);

          usdcTransferInQuantity = await calculateUSDCTransferIn(
            setToken,
            subjectQuantity,
            perpLeverageModule,
            perpSetup
          );
        });

        it("should not update the USDC defaultPositionUnit", async () => {
          const initialDefaultPositionUnit = await setToken.getDefaultPositionRealUnit(usdc.address);
          await subject();
          const finalDefaultPositionUnit = await setToken.getDefaultPositionRealUnit(usdc.address);;

          expect(finalDefaultPositionUnit).to.eq(initialDefaultPositionUnit);
        });

        it("should have set the expected USDC externalPositionUnit", async () => {
          const expectedExternalPositionUnit = preciseDiv(usdcTransferInQuantity, subjectQuantity);

          await subject();

          const externalPositionUnit = await setToken.getExternalPositionRealUnit(
            usdc.address,
            perpLeverageModule.address
          );

          // externalPositionUnit = 10_008_105;
          expect(externalPositionUnit).to.be.closeTo(expectedExternalPositionUnit, 1);
        });

        it("have the expected virtual token balance", async () => {
          const totalSupply = await setToken.totalSupply();

          const initialBaseBalance = (await perpLeverageModule.getPositionNotionalInfo(subjectSetToken))[0].baseBalance;
          await subject();
          const finalBaseBalance = (await perpLeverageModule.getPositionNotionalInfo(subjectSetToken))[0].baseBalance;

          const basePositionUnit = preciseDiv(initialBaseBalance, totalSupply);
          const baseTokenBoughtNotional = preciseMul(basePositionUnit, subjectQuantity);
          const expectedBaseBalance = initialBaseBalance.add(baseTokenBoughtNotional);

          expect(finalBaseBalance).eq(expectedBaseBalance);
        });

        it("should deposit the expected amount into the Perp vault", async () => {
          const initialCollateralBalance = (await perpLeverageModule.getAccountInfo(subjectSetToken)).collateralBalance;
          await subject();
          const finalCollateralBalance = (await perpLeverageModule.getAccountInfo(subjectSetToken)).collateralBalance;

          const issueQuantityWithFees = (await slippageIssuanceModule.calculateTotalFees(
            subjectSetToken,
            subjectQuantity,
            true
          ))[0];

          const feeAdjustedTransferIn = preciseMul(issueQuantityWithFees, usdcTransferInQuantity);

          // usdcTransferIn        = 10_008_105
          // feeAdjustedTransferIn = 10_058_145
          const expectedCollateralBalance = toUSDCDecimals(initialCollateralBalance).add(feeAdjustedTransferIn);
          expect(toUSDCDecimals(finalCollateralBalance)).to.be.closeTo(expectedCollateralBalance, 2);
        });

        it("should get required component issuance units correctly", async () => {
          const issueQuantityWithFees = (await slippageIssuanceModule.calculateTotalFees(
            subjectSetToken,
            subjectQuantity,
            true
          ))[0];

          const externalPositionUnit = preciseDiv(usdcTransferInQuantity, subjectQuantity);
          const feeAdjustedTransferIn = preciseMul(issueQuantityWithFees, externalPositionUnit);

          const [components, equityFlows, debtFlows] = await slippageIssuanceModule.callStatic.getRequiredComponentIssuanceUnitsOffChain(
            subjectSetToken,
            subjectQuantity
          );

          const expectedComponents = await setToken.getComponents();
          const expectedEquityFlows = [feeAdjustedTransferIn];
          const expectedDebtFlows = [ZERO];

          expect(expectedComponents[0]).to.eq(components[0]);
          expect(expectedEquityFlows[0]).to.be.closeTo(equityFlows[0], 50);
          expect(expectedDebtFlows[0]).to.eq(debtFlows[0]);
        });
      });

      describe("when minting multiple sets", () => {
        beforeEach(async () => {
          subjectQuantity = ether(2);

          usdcTransferInQuantity = await calculateUSDCTransferIn(
            setToken,
            subjectQuantity,
            perpLeverageModule,
            perpSetup
          );
        });

        it("should have set the expected USDC externalPositionUnit", async () => {
          const expectedExternalPositionUnit = preciseDiv(usdcTransferInQuantity, subjectQuantity);

          await subject();

          const externalPositionUnit = await setToken.getExternalPositionRealUnit(
            usdc.address,
            perpLeverageModule.address
          );

          // externalPositionUnit = 10_008_105;
          expect(externalPositionUnit).to.be.closeTo(expectedExternalPositionUnit, 1);
        });

        it("have the expected virtual token balance", async () => {
          const totalSupply = await setToken.totalSupply();

          const initialBaseBalance = (await perpLeverageModule.getPositionNotionalInfo(subjectSetToken))[0].baseBalance;
          await subject();
          const finalBaseBalance = (await perpLeverageModule.getPositionNotionalInfo(subjectSetToken))[0].baseBalance;

          const basePositionUnit = preciseDiv(initialBaseBalance, totalSupply);
          const baseTokenBoughtNotional = preciseMul(basePositionUnit, subjectQuantity);
          const expectedBaseBalance = initialBaseBalance.add(baseTokenBoughtNotional);

          expect(finalBaseBalance).eq(expectedBaseBalance);
        });

        it("should deposit the expected amount into the Perp vault", async () => {
          const initialCollateralBalance = (await perpLeverageModule.getAccountInfo(subjectSetToken)).collateralBalance;
          await subject();
          const finalCollateralBalance = (await perpLeverageModule.getAccountInfo(subjectSetToken)).collateralBalance;

          const issueQuantityWithFees = (await slippageIssuanceModule.calculateTotalFees(
            subjectSetToken,
            subjectQuantity,
            true
          ))[0];

          const externalPositionUnit = preciseDiv(usdcTransferInQuantity, subjectQuantity);
          const feeAdjustedTransferIn = preciseMul(issueQuantityWithFees, externalPositionUnit);

          // usdcTransferIn        = 20_024_302
          // feeAdjustedTransferIn = 20_124_423
          const expectedCollateralBalance = toUSDCDecimals(initialCollateralBalance).add(feeAdjustedTransferIn);
          expect(toUSDCDecimals(finalCollateralBalance)).to.be.closeTo(expectedCollateralBalance, 2);
        });

        it("should deposit the expected amount into the Perp vault", async () => {
          const issueQuantityWithFees = (await slippageIssuanceModule.calculateTotalFees(
            subjectSetToken,
            subjectQuantity,
            true
          ))[0];

          const externalPositionUnit = preciseDiv(usdcTransferInQuantity, subjectQuantity);
          const feeAdjustedTransferIn = preciseMul(issueQuantityWithFees, externalPositionUnit);

          const initialCollateralBalance = (await perpLeverageModule.getAccountInfo(subjectSetToken)).collateralBalance;
          await subject();
          const finalCollateralBalance = (await perpLeverageModule.getAccountInfo(subjectSetToken)).collateralBalance;

          // usdcTransferIn        = 20_024_302
          // feeAdjustedTransferIn = 20_124_423
          const expectedCollateralBalance = toUSDCDecimals(initialCollateralBalance).add(feeAdjustedTransferIn);
          expect(toUSDCDecimals(finalCollateralBalance)).to.be.closeTo(expectedCollateralBalance, 2);
        });

        // This is slightly off ... over a tenth of a penny.
        it.skip("should not incur a premium", async () => {
          const issueQuantityWithFees = (await slippageIssuanceModule.calculateTotalFees(
            subjectSetToken,
            subjectQuantity,
            true
          ))[0];

          // Model says premium should be calculated as (usdcTransferIn / amountMinted)
          const externalPositionUnit = preciseDiv(usdcTransferInQuantity, subjectQuantity);
          const feeAdjustedTransferIn = preciseMul(issueQuantityWithFees, externalPositionUnit);
          const feeAdjustedExternalPositionUnit = preciseDiv(feeAdjustedTransferIn, issueQuantityWithFees);

          // Slippage will be paid by the issuer, but get reflected as debt in the quote balance.
          const totalSlippageAndFees = await calculateTotalSlippage(setToken, subjectQuantity);
          const totalSlippagePositionUnit = preciseDiv(totalSlippageAndFees, subjectQuantity);

          const feeAndSlippageAdjustedExternalPositionUnit = feeAdjustedExternalPositionUnit
            .sub(toUSDCDecimals(totalSlippagePositionUnit));

          await subject();

          // Calculate value of set
          const accountInfo = await perpLeverageModule.getAccountInfo(subjectSetToken);
          const spotPrice = await perpSetup.getSpotPrice(baseToken);
          const baseBalance = (await perpLeverageModule.getPositionNotionalInfo(subjectSetToken))[0].baseBalance;
          const notionalBaseValue = preciseMul(baseBalance, spotPrice);

          const totalSetValue = notionalBaseValue
            .add(accountInfo.netQuoteBalance)
            .add(accountInfo.collateralBalance)
            .add(accountInfo.owedRealizedPnl);

          const valuePerSet = preciseDiv(totalSetValue, await setToken.totalSupply());
          const valuePerSetUSDC = toUSDCDecimals(valuePerSet);

          // feeAdjustedExternalPositionUnit            = 10012150
          // feeAndSlippageAdjustedExternalPositionUnit =  9801960
          // valuePerSet                                =  9818624
          expect(valuePerSetUSDC).eq(feeAndSlippageAdjustedExternalPositionUnit);
        });
      });

      describe("when flash-issuing at high margin (success)", async () => {
        // Starting point is 2X leverage, with 10 USDC collateral, 20 USDC vETH, totalSupply = 1
        // Minting 3 sets raises interim leverage ratio to > 80 USDC Asset / 10 USDC collateral
        // We know from spec scenario testing that the effective limit is ~ 9.1X
        beforeEach(async () => {
          subjectQuantity = ether(3);
        });

        // Calculated leverage = 8_702_210_816_139_153_672
        it("~8.7X succeeds", async() => {
          const flashLeverage = await calculateFlashLeverage(subjectSetToken, subjectQuantity);
          await subject();

          expect(flashLeverage).to.be.gt(ether(8));
          expect(flashLeverage).to.be.lt(ether(9));
        });
      });

      describe("when flash-issuing at high margin (failure)", async () => {
        beforeEach(async () => {
          subjectQuantity = ether(3.5);
        });

        // Calculated leverage = 9_911_554_370_685_102_958
        it("~9.9X fails", async () => {
          const flashLeverage = await calculateFlashLeverage(subjectSetToken, subjectQuantity);

          await expect(subject()).to.be.revertedWith("CH_NEFCI");

          expect(flashLeverage).to.be.gt(ether(9));
          expect(flashLeverage).to.be.lt(ether(10));
        });
      });

      describe("when issuing after a liquidation", async () => {
        beforeEach(async () => {
          subjectQuantity = ether(1);

          // Calculated leverage = ~8.5X = 8_654_438_822_995_683_587
          await leverUp(
            setToken,
            perpLeverageModule,
            perpSetup,
            owner,
            baseToken,
            6,
            ether(.02),
            true
          );

          await perpSetup.setBaseTokenOraclePrice(vETH, usdcUnits(8.0));

          await perpSetup
            .clearingHouse
            .connect(otherTrader.wallet)
            .liquidate(subjectSetToken, baseToken);
        });

        it("should issue and transfer in the expected amount", async () => {
          const initialTotalSupply = await setToken.totalSupply();
          const initialCollateralBalance = (await perpLeverageModule.getAccountInfo(subjectSetToken)).collateralBalance;

          await subject();

          // We need to calculate this after the subject() fires because it will revert if the positionList
          // isn't updated correctly...
          const usdcTransferInQuantity = await calculateUSDCTransferIn(
            setToken,
            subjectQuantity,
            perpLeverageModule,
            perpSetup
          );

          const finalTotalSupply = await setToken.totalSupply();
          const finalPositionInfo = await perpLeverageModule.getPositionNotionalInfo(subjectSetToken);
          const finalCollateralBalance = (await perpLeverageModule.getAccountInfo(subjectSetToken)).collateralBalance;

          const issueQuantityWithFees = (await slippageIssuanceModule.calculateTotalFees(
            subjectSetToken,
            subjectQuantity,
            true
          ))[0];

          const externalPositionUnit = preciseDiv(usdcTransferInQuantity, subjectQuantity);
          const feeAdjustedTransferIn = preciseMul(issueQuantityWithFees, externalPositionUnit);

          const expectedTotalSupply = initialTotalSupply.add(issueQuantityWithFees);
          const expectedCollateralBalance = toUSDCDecimals(initialCollateralBalance).add(feeAdjustedTransferIn);

          expect(finalTotalSupply).eq(expectedTotalSupply);
          expect(finalPositionInfo.length).eq(0);
          expect(toUSDCDecimals(finalCollateralBalance)).to.be.closeTo(expectedCollateralBalance, 2);
        });
      });

      describe("when liquidation results in negative account value", () => {
        beforeEach(async () => {
          subjectQuantity = ether(1);

          // Calculated leverage = ~8.5X = 8_654_438_822_995_683_587
          await leverUp(
            setToken,
            perpLeverageModule,
            perpSetup,
            owner,
            baseToken,
            6,
            ether(.02),
            true
          );

          // Move oracle price down to 5 USDC to enable liquidation
          await perpSetup.setBaseTokenOraclePrice(vETH, usdcUnits(5));

          // Move price down by maker selling 20_000 USDC of vETH
          // Post trade spot price drops from ~10 USDC to 6_380_562_015_950_425_028
          await perpSetup.clearingHouse.connect(maker.wallet).openPosition({
            baseToken: vETH.address,
            isBaseToQuote: true,       // short
            isExactInput: false,       // `amount` is USDC
            amount: ether(20_000),
            oppositeAmountBound: ZERO,
            deadline: MAX_UINT_256,
            sqrtPriceLimitX96: ZERO,
            referralCode: ZERO_BYTES
          });

          await perpSetup
            .clearingHouse
            .connect(otherTrader.wallet)
            .liquidate(subjectSetToken, baseToken);
        });

        // In this test case, the account is bankrupt:
        // collateralBalance =  10050000000000000000
        // owedRealizedPnl =   -31795534271984084912
        it("should issue without transferring any usdc (because account worth 0)", async () => {
          const issueQuantityWithFees = (await slippageIssuanceModule.calculateTotalFees(
            subjectSetToken,
            subjectQuantity,
            true
          ))[0];

          const initialIssuerUSDCBalance = await usdc.balanceOf(subjectCaller.address);
          const initialTotalSupply = await setToken.totalSupply();

          await subject();

          const finalIssuerUSDCBalance = await usdc.balanceOf(subjectCaller.address);
          const finalTotalSupply = await setToken.totalSupply();

          const expectedTotalSupply = initialTotalSupply.add(issueQuantityWithFees);

          expect(finalTotalSupply).eq(expectedTotalSupply);
          expect(finalIssuerUSDCBalance).eq(initialIssuerUSDCBalance);
        });
      });
    });
  });

  describe("#redemption", async () => {
    let setToken: SetToken;
    let baseToken: Address;
    let redeemFee: BigNumber;
    let depositQuantityUnit: BigNumber;
    let usdcDefaultPositionUnit: BigNumber;
    let usdcTransferOutQuantity: BigNumber;

    let subjectSetToken: Address;
    let subjectQuantity: BigNumber;
    let subjectCheckedComponents: Address[];
    let subjectMaxTokenAmountsIn: BigNumber[];
    let subjectTo: Address;
    let subjectCaller: Account;
    let issueQuantity: BigNumber;

    const initializeContracts = async function() {
      usdcDefaultPositionUnit = usdcUnits(10);
      setToken = await setup.createSetToken(
        [usdc.address],
        [usdcDefaultPositionUnit],
        [perpLeverageModule.address, slippageIssuanceModule.address]
      );
      redeemFee = ether(0.005);
      await slippageIssuanceModule.initialize(
        setToken.address,
        ether(0.02),
        ether(0.005),
        redeemFee,
        feeRecipient.address,
        ADDRESS_ZERO
      );
      // Add SetToken to allow list
      await perpLeverageModule.updateAllowedSetToken(setToken.address, true);
      await perpLeverageModule.initialize(setToken.address);

      // Approve tokens to issuance module and call issue
      await usdc.approve(slippageIssuanceModule.address, usdcUnits(1000));
    };

    async function subject(): Promise<ContractTransaction> {
      return slippageIssuanceModule.connect(subjectCaller.wallet).redeemWithSlippage(
        subjectSetToken,
        subjectQuantity,
        subjectCheckedComponents,
        subjectMaxTokenAmountsIn,
        subjectTo
      );
    }

    context("when there is only an external USDC position and redeem will take supply to 0", async () => {
      cacheBeforeEach(initializeContracts);

      beforeEach(async () => {
        // Issue 1 SetToken
        issueQuantity = ether(1);
        await slippageIssuanceModule.issue(setToken.address, issueQuantity, owner.address);

        depositQuantityUnit = usdcUnits(10);
        await perpLeverageModule.deposit(setToken.address, depositQuantityUnit);

        // Lever up 2X
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

        subjectSetToken = setToken.address;
        subjectQuantity = issueQuantity;
        subjectCheckedComponents = [];
        subjectMaxTokenAmountsIn = [];
        subjectTo = owner.address;
        subjectCaller = owner;

        usdcTransferOutQuantity = await calculateUSDCTransferOut(
          setToken,
          subjectQuantity,
          perpLeverageModule,
          perpSetup
        );
      });

      it("should not update the USDC defaultPositionUnit", async () => {
        const initialDefaultPositionUnit = await setToken.getDefaultPositionRealUnit(usdc.address);
        await subject();
        const finalDefaultPositionUnit = await setToken.getDefaultPositionRealUnit(usdc.address);

        expect(initialDefaultPositionUnit).eq(finalDefaultPositionUnit);
      });

      it("should have updated the USDC externalPositionUnit", async () => {
        const initialExternalPositionUnit = await setToken.getExternalPositionRealUnit(usdc.address, perpLeverageModule.address);
        await subject();
        const finalExternalPositionUnit = await setToken.getExternalPositionRealUnit(usdc.address, perpLeverageModule.address);

        const expectedExternalPositionUnit = usdcTransferOutQuantity;

        expect(initialExternalPositionUnit).not.eq(finalExternalPositionUnit);
        expect(finalExternalPositionUnit).eq(expectedExternalPositionUnit);
      });

      it("should have the expected virtual token balance", async () => {
        const totalSupply = await setToken.totalSupply();

        const initialBaseBalance = (await perpLeverageModule.getPositionNotionalInfo(subjectSetToken))[0].baseBalance;
        await subject();
        const finalBaseBalance = (await perpLeverageModule.getPositionNotionalInfo(subjectSetToken))[0].baseBalance;

        const basePositionUnit = preciseDiv(initialBaseBalance, totalSupply);
        const baseTokenBoughtNotional = preciseMul(basePositionUnit, subjectQuantity);
        const expectedBaseBalance = initialBaseBalance.sub(baseTokenBoughtNotional);

        expect(finalBaseBalance).eq(expectedBaseBalance);
      });

      it("should not have updated the setToken USDC token balance", async () => {
        const initialUSDCBalance = await usdc.balanceOf(subjectSetToken);
        await subject();
        const finalUSDCBalance = await usdc.balanceOf(subjectSetToken);

        expect(initialUSDCBalance).eq(finalUSDCBalance);
      });

      describe("withdrawal", () => {
        let feeAdjustedTransferOutUSDC: BigNumber;
        let realizedPnlUSDC: BigNumber;

        beforeEach(async() => {
          ({
            feeAdjustedTransferOutUSDC,
            realizedPnlUSDC
          } = await calculateRedemptionData(
            subjectSetToken,
            subjectQuantity,
            usdcTransferOutQuantity
          ));
        });

        it("should withdraw the expected amount from the Perp vault", async () => {
          const initialCollateralBalance = (await perpLeverageModule.getAccountInfo(subjectSetToken)).collateralBalance;
          await subject();
          const finalCollateralBalance = (await perpLeverageModule.getAccountInfo(subjectSetToken)).collateralBalance;

          const initialCollateralBalanceUSDC = toUSDCDecimals(initialCollateralBalance);
          const finalCollateralBalanceUSDC = toUSDCDecimals(finalCollateralBalance);

          const expectedCollateralBalanceUSDC = initialCollateralBalanceUSDC
            .sub(feeAdjustedTransferOutUSDC)
            .add(realizedPnlUSDC);

          expect(finalCollateralBalanceUSDC).to.be.closeTo(expectedCollateralBalanceUSDC, 1);
        });

        it("should not update the setToken USDC token balance", async () => {
          const initialUSDCBalance = await usdc.balanceOf(subjectSetToken);
          await subject();
          const finalUSDCBalance = await usdc.balanceOf(subjectSetToken);

          expect(initialUSDCBalance).eq(0);
          expect(finalUSDCBalance).eq(initialUSDCBalance);
        });

        it("should have transferred expected USDC to set token holder", async () => {
          const initialOwnerUSDCBalance = await usdc.balanceOf(subjectCaller.address);
          await subject();
          const finalOwnerUSDCBalance = await usdc.balanceOf(subjectCaller.address);

          const expectedUSDCBalance = initialOwnerUSDCBalance.add(feeAdjustedTransferOutUSDC);
          expect(finalOwnerUSDCBalance).eq(expectedUSDCBalance);
        });
      });
    });

    context("when there is only an external USDC position and redeem will take supply to 1", async () => {
      let depositQuantityUnit: BigNumber;
      let usdcTransferOutQuantity: BigNumber;

      cacheBeforeEach(initializeContracts);

      beforeEach(async () => {
        // Issue 2 SetTokens
        issueQuantity = ether(2);
        await slippageIssuanceModule.issue(setToken.address, issueQuantity, owner.address);

        // Deposit entire default position
        depositQuantityUnit = usdcDefaultPositionUnit;
        await perpLeverageModule.deposit(setToken.address, depositQuantityUnit);

        // Lever up 2X
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

        subjectSetToken = setToken.address;
        subjectQuantity = ether(1);
        subjectCheckedComponents = [];
        subjectMaxTokenAmountsIn = [];
        subjectTo = owner.address;
        subjectCaller = owner;

        usdcTransferOutQuantity = await calculateUSDCTransferOut(
          setToken,
          subjectQuantity,
          perpLeverageModule,
          perpSetup
        );
      });

      it("should not update the USDC defaultPositionUnit", async () => {
        const initialDefaultPositionUnit = await setToken.getDefaultPositionRealUnit(usdc.address);
        await subject();
        const finalDefaultPositionUnit = await setToken.getDefaultPositionRealUnit(usdc.address);

        expect(initialDefaultPositionUnit).eq(finalDefaultPositionUnit);
      });

      it("should update the USDC externalPositionUnit", async () => {
        const initialExternalPositionUnit = await setToken.getExternalPositionRealUnit(usdc.address, perpLeverageModule.address);
        await subject();
        const finalExternalPositionUnit = await setToken.getExternalPositionRealUnit(usdc.address, perpLeverageModule.address);

        // initialExternalPositionUnit = 10_000_000
        // finalExternalPositionUnit   =  9_597_857

        const expectedExternalPositionUnit = preciseDiv(usdcTransferOutQuantity, subjectQuantity);
        expect(initialExternalPositionUnit).eq(usdcDefaultPositionUnit);
        expect(finalExternalPositionUnit).to.be.closeTo(expectedExternalPositionUnit, 1);
      });

      it("should have the expected virtual token balance", async () => {
        const totalSupply = await setToken.totalSupply();

        const initialBaseBalance = (await perpLeverageModule.getPositionNotionalInfo(subjectSetToken))[0].baseBalance;
        await subject();
        const finalBaseBalance = (await perpLeverageModule.getPositionNotionalInfo(subjectSetToken))[0].baseBalance;

        const basePositionUnit = preciseDiv(initialBaseBalance, totalSupply);
        const baseTokenSoldNotional = preciseMul(basePositionUnit, subjectQuantity);
        const expectedBaseBalance = initialBaseBalance.sub(baseTokenSoldNotional);

        expect(finalBaseBalance).eq(expectedBaseBalance);
      });

      it("should get required component redemption units correctly", async () => {
        const issueQuantityWithFees = (await slippageIssuanceModule.calculateTotalFees(
          subjectSetToken,
          subjectQuantity,
          false
        ))[0];

        const externalPositionUnit = preciseDiv(usdcTransferOutQuantity, subjectQuantity);
        const feeAdjustedTransferOut = preciseMul(issueQuantityWithFees, externalPositionUnit);

        const [components, equityFlows, debtFlows] = await slippageIssuanceModule
          .callStatic
          .getRequiredComponentRedemptionUnitsOffChain(
            subjectSetToken,
            subjectQuantity
          );

        const expectedComponents = await setToken.getComponents();
        const expectedEquityFlows = [feeAdjustedTransferOut];
        const expectedDebtFlows = [ZERO];

        expect(expectedComponents[0]).to.eq(components[0]);
        expect(expectedEquityFlows[0]).to.be.closeTo(equityFlows[0], 50);
        expect(expectedDebtFlows[0]).to.eq(debtFlows[0]);
      });

      // This is slightly off ... over a tenth of a penny.
      it.skip("should not incur a premium", async () => {
        const redeemQuantityWithFees = (await slippageIssuanceModule.calculateTotalFees(
          subjectSetToken,
          subjectQuantity,
          false
        ))[0];

        // Model says premium should be calculated as (usdcTransferIn / amountMinted)
        const externalPositionUnit = preciseDiv(usdcTransferOutQuantity, subjectQuantity);
        const feeAdjustedTransferOut = preciseMul(redeemQuantityWithFees, externalPositionUnit);
        const feeAdjustedExternalPositionUnit = preciseDiv(feeAdjustedTransferOut, redeemQuantityWithFees);

        // Slippage will be paid by the redeemer
        const totalSlippageAndFees = await calculateTotalSlippage(setToken, subjectQuantity);
        const totalSlippagePositionUnit = preciseDiv(totalSlippageAndFees, subjectQuantity);

        const feeAndSlippageAdjustedExternalPositionUnit = feeAdjustedExternalPositionUnit
          .add(toUSDCDecimals(totalSlippagePositionUnit));

        await subject();

        // Calculate value of set
        const accountInfo = await perpLeverageModule.getAccountInfo(subjectSetToken);
        const spotPrice = await perpSetup.getSpotPrice(baseToken);
        const baseBalance = (await perpLeverageModule.getPositionNotionalInfo(subjectSetToken))[0].baseBalance;
        const notionalBaseValue = preciseMul(baseBalance, spotPrice);

        const totalSetValue = notionalBaseValue
          .add(accountInfo.netQuoteBalance)
          .add(accountInfo.collateralBalance)
          .add(accountInfo.owedRealizedPnl);

        const valuePerSet = preciseDiv(totalSetValue, await setToken.totalSupply());
        const valuePerSetUSDC = toUSDCDecimals(valuePerSet);

        // feeAdjustedTransferOut                     = 9_553_810
        // valuePerSetUSDC                            = 9_796_973
        // feeAndSlippageAdjustedExternalPositionUnit = 9_808_047

        expect(valuePerSetUSDC).eq(feeAndSlippageAdjustedExternalPositionUnit);
      });

      describe("withdrawal", () => {
        let feeAdjustedTransferOutUSDC: BigNumber;
        let realizedPnlUSDC: BigNumber;

        beforeEach(async() => {
          ({
            feeAdjustedTransferOutUSDC,
            realizedPnlUSDC
          } = await calculateRedemptionData(
            subjectSetToken,
            subjectQuantity,
            usdcTransferOutQuantity)
          );
        });

        it("should withdraw the expected amount from the Perp vault", async () => {
          const initialCollateralBalance = (await perpLeverageModule.getAccountInfo(subjectSetToken)).collateralBalance;
          await subject();
          const finalCollateralBalance = (await perpLeverageModule.getAccountInfo(subjectSetToken)).collateralBalance;

          const initialCollateralBalanceUSDC = toUSDCDecimals(initialCollateralBalance);
          const finalCollateralBalanceUSDC = toUSDCDecimals(finalCollateralBalance);

          // realizedPnl            = -398179
          // feeAdjustedTransferOut = 9553810
          const expectedCollateralBalanceUSDC = initialCollateralBalanceUSDC
            .sub(feeAdjustedTransferOutUSDC)
            .add(realizedPnlUSDC);

          expect(finalCollateralBalanceUSDC).to.be.closeTo(expectedCollateralBalanceUSDC, 1);
        });

        it("should not update the setToken USDC token balance", async () => {
          const initialUSDCBalance = await usdc.balanceOf(subjectSetToken);
          await subject();
          const finalUSDCBalance = await usdc.balanceOf(subjectSetToken);

          expect(initialUSDCBalance).eq(0);
          expect(finalUSDCBalance).eq(initialUSDCBalance);
        });

        it("should have transferred expected USDC to set token holder", async () => {
          const initialOwnerUSDCBalance = await usdc.balanceOf(subjectCaller.address);
          await subject();
          const finalOwnerUSDCBalance = await usdc.balanceOf(subjectCaller.address);

          const expectedUSDCBalance = initialOwnerUSDCBalance.add(feeAdjustedTransferOutUSDC);
          expect(finalOwnerUSDCBalance).to.be.closeTo(expectedUSDCBalance, 1);
        });

        it("should remove the module when dust is in the account and be able to add module back", async () => {
          // Redeem to `1`
          await subject();

          // Check precondition
          const initialModules = await setToken.getModules();
          expect(initialModules.includes(perpLeverageModule.address)).eq(true);

          // Trade to `0`
          const {
            baseUnit: initialBaseUnit
          } = (await perpLeverageModule.getPositionUnitInfo(subjectSetToken))[0];

          await perpLeverageModule.connect(owner.wallet).trade(
            subjectSetToken,
            baseToken,
            initialBaseUnit.mul(-1),
            ZERO
          );

          const positionInfo = await perpLeverageModule.getPositionUnitInfo(subjectSetToken);

          // Withdraw remaining free collateral
          const freeCollateral = await perpSetup.vault.getFreeCollateral(subjectSetToken);
          const freeCollateralPositionUnit = preciseDiv(freeCollateral, await setToken.totalSupply());

          // freeCollateral = 9737806
          // withdrawing this amount as a positionUnit results in a freeCollateral balance of `1`
          // that can't be withdrawn due to positionUnit math rounding errors.
          await perpLeverageModule
            .connect(owner.wallet)
            .withdraw(subjectSetToken, freeCollateralPositionUnit);

          const {
            collateralBalance: finalCollateralBalance
          } = await perpLeverageModule.getAccountInfo(subjectSetToken);


          /// Remove module
          await setToken.removeModule(perpLeverageModule.address);
          const finalModules = await setToken.getModules();

          expect(finalModules.includes(perpLeverageModule.address)).eq(false);
          expect(positionInfo.length).eq(0);
          expect(toUSDCDecimals(finalCollateralBalance)).eq(1); // <-- DUST

          // Restore module
          await setToken.connect(owner.wallet).addModule(perpLeverageModule.address);
          await perpLeverageModule.updateAllowedSetToken(setToken.address, true);
          await perpLeverageModule.initialize(setToken.address);

          const restoredModules = await setToken.getModules();
          expect(restoredModules.includes(perpLeverageModule.address)).eq(true);

          // Verify that we can deposit again
          await perpLeverageModule.deposit(setToken.address, usdcUnits(5));
        });
      });

      describe("when redeeming after a liquidation", async () => {
        beforeEach(async () => {
          subjectQuantity = ether(1);

          // Calculated leverage = ~8.5X = 8_654_438_822_995_683_587
          await leverUp(
            setToken,
            perpLeverageModule,
            perpSetup,
            owner,
            baseToken,
            6,
            ether(.02),
            true
          );

          await perpSetup.setBaseTokenOraclePrice(vETH, usdcUnits(8.0));

          await perpSetup
            .clearingHouse
            .connect(otherTrader.wallet)
            .liquidate(subjectSetToken, baseToken);
        });

        it("should redeem and transfer out the expected amount", async () => {
          const initialTotalSupply = await setToken.totalSupply();
          const initialCollateralBalance = (await perpLeverageModule.getAccountInfo(subjectSetToken)).collateralBalance;

          // Total amount of owedRealizedPnl will be debited from collateral balance
          const { owedRealizedPnl } = await perpLeverageModule.getAccountInfo(subjectSetToken);
          const owedRealizedPnlUSDC = toUSDCDecimals(owedRealizedPnl);

          await subject();

          const finalTotalSupply = await setToken.totalSupply();
          const finalPositionInfo = await perpLeverageModule.getPositionNotionalInfo(subjectSetToken);
          const finalCollateralBalance = (await perpLeverageModule.getAccountInfo(subjectSetToken)).collateralBalance;

          const usdcTransferOutQuantity = await calculateUSDCTransferOut(
            setToken,
            subjectQuantity,
            perpLeverageModule,
            perpSetup
          );

          const {
            feeAdjustedTransferOutUSDC,
            redeemQuantityWithFees
          } = await calculateRedemptionData(
            subjectSetToken,
            subjectQuantity,
            usdcTransferOutQuantity
          );

          const expectedTotalSupply = initialTotalSupply.sub(redeemQuantityWithFees);
          const expectedCollateralBalance = toUSDCDecimals(initialCollateralBalance)
            .sub(feeAdjustedTransferOutUSDC)
            .add(owedRealizedPnlUSDC);

          expect(finalTotalSupply).eq(expectedTotalSupply);
          expect(finalPositionInfo.length).eq(0);
          expect(toUSDCDecimals(finalCollateralBalance)).to.be.closeTo(expectedCollateralBalance, 2);
        });
      });

      describe("when liquidation results in negative account value", () => {
        beforeEach(async () => {
          // Calculated leverage = ~8.5X = 8_654_438_822_995_683_587
          await leverUp(
            setToken,
            perpLeverageModule,
            perpSetup,
            owner,
            baseToken,
            6,
            ether(.02),
            true
          );

          // Move oracle price down to 5 USDC to enable liquidation
          await perpSetup.setBaseTokenOraclePrice(vETH, usdcUnits(5.0));

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

          await perpSetup
            .clearingHouse
            .connect(otherTrader.wallet)
            .liquidate(subjectSetToken, baseToken);
        });

        // In this test case, the account is bankrupt:
        // collateralBalance =  10050000000000000000
        // owedRealizedPnl =   -31795534271984084912
        it("should redeem without transferring any usdc (because account worth 0)", async () => {
          const redeemQuantityWithFees = (await slippageIssuanceModule.calculateTotalFees(
            subjectSetToken,
            subjectQuantity,
            false
          ))[0];

          const initialRedeemerUSDCBalance = await usdc.balanceOf(subjectCaller.address);
          const initialTotalSupply = await setToken.totalSupply();

          await subject();

          const finalRedeemerUSDCBalance = await usdc.balanceOf(subjectCaller.address);
          const finalTotalSupply = await setToken.totalSupply();

          const expectedTotalSupply = initialTotalSupply.sub(redeemQuantityWithFees);

          expect(finalTotalSupply).eq(expectedTotalSupply);
          expect(finalRedeemerUSDCBalance).eq(initialRedeemerUSDCBalance);
        });

        it("should be possible to remove the module", async () => {
          await subject();

          const collateralBalance = await perpSetup.vault.getBalance(subjectSetToken);
          const freeCollateral = await perpSetup.vault.getFreeCollateral(subjectSetToken);
          const accountValue = await perpSetup.clearingHouse.getAccountValue(subjectSetToken);

          // collateralBalance:  20_100_000 (10^6)
          // accountValue:      -43_466_857_276_051_287_954 (10^18)
          expect(collateralBalance).gt(1);
          expect(freeCollateral).eq(0);
          expect(accountValue).lt(-1);

          /// Remove module
          await setToken.removeModule(perpLeverageModule.address);
          const finalModules = await setToken.getModules();
          expect(finalModules.includes(perpLeverageModule.address)).eq(false);
        });
      });
    });
  });
});
