import "module-alias/register";
import { ContractTransaction } from "ethers";
import { Address } from "@utils/types";
import { Account } from "@utils/test/types";
import {
  SlippageIssuanceModule,
  PerpV2LibraryV2,
  PositionV2,
  PerpV2Positions,
  PerpV2BasisTradingModule,
  SetToken,
  StandardTokenMock,
} from "@utils/contracts";
import { PerpV2BaseToken } from "@utils/contracts/perpV2";
import {
  toUSDCDecimals,
  calculateUSDCTransferOut,
  leverUp,
  getNetFundingGrowth,
  calculateUSDCTransferOutPreciseUnits,
} from "@utils/common";
import DeployHelper from "@utils/deploys";
import {
  ether,
  usdc as usdcUnits,
  preciseDiv,
  preciseMul,
  preciseDivCeil
} from "@utils/index";
import {
  cacheBeforeEach,
  getAccounts,
  getWaffleExpect,
  getSystemFixture,
  getPerpV2Fixture,
  increaseTimeAsync
} from "@utils/test/index";
import { PerpV2Fixture, SystemFixture } from "@utils/fixtures";
import { BigNumber } from "ethers";
import { ADDRESS_ZERO, ZERO, MAX_UINT_256, ZERO_BYTES, ONE_DAY_IN_SECONDS, PRECISE_UNIT } from "@utils/constants";

const expect = getWaffleExpect();

describe("PerpV2BasisTradingSlippageIssuance", () => {
  let owner: Account;
  let maker: Account;
  let otherTrader: Account;
  let feeRecipient: Account;
  let deployer: DeployHelper;

  let perpLib: PerpV2LibraryV2;
  let positionLib: PositionV2;
  let perpPositionsLib: PerpV2Positions;
  let perpBasisTradingModule: PerpV2BasisTradingModule;
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
    // await perpSetup.clearingHouseConfig.setMaxFundingRate(ZERO);

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

    perpBasisTradingModule = await deployer.modules.deployPerpV2BasisTradingModule(
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
    await setup.controller.addModule(perpBasisTradingModule.address);

    slippageIssuanceModule = await deployer.modules.deploySlippageIssuanceModule(
      setup.controller.address
    );
    await setup.controller.addModule(slippageIssuanceModule.address);

    await setup.integrationRegistry.addIntegration(
      perpBasisTradingModule.address,
      "DefaultIssuanceModule",
      slippageIssuanceModule.address
    );
  });

  async function calculateTotalSlippage(setToken: SetToken, setQuantity: BigNumber): Promise<BigNumber> {
    let totalExpectedSlippage = BigNumber.from(0);
    const allPositionInfo = await perpBasisTradingModule.getPositionNotionalInfo(setToken.address);

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
    redeemQuantityNetFees: BigNumber,
    usdcTransferOutQuantity: BigNumber
  ) {
    // Calculate fee adjusted usdcTransferOut
    const externalPositionUnit = preciseDiv(usdcTransferOutQuantity, redeemQuantityNetFees);
    const feeAdjustedTransferOutUSDC = preciseMul(redeemQuantityNetFees, externalPositionUnit);

    // Calculate realizedPnl. The amount is debited from collateral returned to redeemer *and*
    // debited from the Perp account collateral balance because withdraw performs a settlement.
    let realizedPnlUSDC = BigNumber.from(0);
    const positionUnitInfo = await perpBasisTradingModule.getPositionUnitInfo(setToken);

    for (const info of positionUnitInfo) {
      const baseTradeQuantityNotional = preciseMul(info.baseUnit, redeemQuantityNetFees);

      const { deltaQuote } = await perpSetup.getSwapQuote(
        info.baseToken,
        baseTradeQuantityNotional,
        false
      );

      const {
        baseBalance,
        quoteBalance
      } = (await perpBasisTradingModule.getPositionNotionalInfo(setToken))[0];

      const closeRatio = preciseDiv(baseTradeQuantityNotional, baseBalance);
      const reducedOpenNotional = preciseMul(quoteBalance, closeRatio);

      realizedPnlUSDC = realizedPnlUSDC.add(toUSDCDecimals(reducedOpenNotional.add(deltaQuote)));
    }

    return {
      feeAdjustedTransferOutUSDC,
      realizedPnlUSDC
    };
  }

  function calculateQuantityNetFees(
    setQuantity: BigNumber,
    issueFee: BigNumber,
    redeemFee: BigNumber,
    isIssue: boolean,
  ): BigNumber {
    if (isIssue) {
      return preciseMul(setQuantity, PRECISE_UNIT.add(issueFee));
    } else {
      return preciseMul(setQuantity, PRECISE_UNIT.sub(redeemFee));
    }
  }

  // PerpV2BasisTradingModule#moduleIssueHook implementation calls PerpV2LeverageModuleV2#moduleIssueHook to handle issuance
  // after updating tracked settled funding. The functionality to track settled funding when moduleIssueHook is called is
  // tested in the PerpV2BasisTradingModule unit tests (test/protocol/modules/perpV2BasisTradingModule.spec.ts). And the
  // functionality to set external position unit before issuance, has been tested in the PerpV2LeverageModuleV2 <> SlippageIssuanceModule
  // integration tests (test/integration/perpV2LeverageV2SlippageIssuance.spec.ts). Hence we will not restest them here.
  describe("#issuance", () => {});

  // PerpV2BasisTradingModule#moduleRedeemHook does not call PerpV2LeverageModuleV2#moduleRedeemHook. It reimplements the functionality to
  // set external position unit, with the addition of extra logic to handle performance fees on redemption, and to update tracked settled funding.
  // The logic to update tracked settled funding when moduleRedeemHook is called is tested in the PerpV2BasisTradingModule unit tests
  // (test/protocol/modules/perpV2BasisTradingModule.spec.ts). The below tests for redemption are exactly similar to the PerpV2LeverageModuleV2
  // redemption tests, with the additional case for "when funding payment is positive" (for both cases, when supply goes to 0, supply goes to non-zero
  // after redemption) to test the logic to handle performance fees during redemption.
  describe("#redemption", async () => {
    let setToken: SetToken;
    let baseToken: Address;
    let issueFee: BigNumber;
    let redeemFee: BigNumber;
    let depositQuantityUnit: BigNumber;
    let usdcDefaultPositionUnit: BigNumber;
    let usdcTransferOutQuantity: BigNumber;
    let quantityNetFees: BigNumber;

    let subjectSetToken: Address;
    let subjectQuantity: BigNumber;
    let subjectCheckedComponents: Address[];
    let subjectMaxTokenAmountsIn: BigNumber[];
    let subjectTo: Address;
    let subjectCaller: Account;
    let issueQuantity: BigNumber;

    const initializeContracts = async function () {
      usdcDefaultPositionUnit = usdcUnits(10);
      setToken = await setup.createSetToken(
        [usdc.address],
        [usdcDefaultPositionUnit],
        [perpBasisTradingModule.address, slippageIssuanceModule.address]
      );
      issueFee = ether(0.005);
      redeemFee = ether(0.005);
      await slippageIssuanceModule.initialize(
        setToken.address,
        ether(0.02),
        issueFee,
        redeemFee,
        feeRecipient.address,
        ADDRESS_ZERO
      );
      // Add SetToken to allow list
      await perpBasisTradingModule.updateAllowedSetToken(setToken.address, true);
      await perpBasisTradingModule["initialize(address,(address,uint256,uint256))"](
        setToken.address,
        {
          feeRecipient: owner.address,
          performanceFeePercentage: ether(.1),
          maxPerformanceFeePercentage: ether(.2)
        }
      );

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
        await slippageIssuanceModule.issueWithSlippage(setToken.address, issueQuantity, [], [], owner.address);

        depositQuantityUnit = usdcUnits(10);
        await perpBasisTradingModule.deposit(setToken.address, depositQuantityUnit);

        // Lever up 2X
        baseToken = vETH.address;
        await leverUp(
          setToken,
          perpBasisTradingModule,
          perpSetup,
          owner,
          baseToken,
          2,
          ether(.02),
          true,
          true
        );

        subjectSetToken = setToken.address;
        subjectQuantity = issueQuantity;
        subjectCheckedComponents = [];
        subjectMaxTokenAmountsIn = [];
        subjectTo = owner.address;
        subjectCaller = owner;

        quantityNetFees = calculateQuantityNetFees(subjectQuantity, issueFee, redeemFee, false);
        usdcTransferOutQuantity = await calculateUSDCTransferOut(
          setToken,
          quantityNetFees,
          perpBasisTradingModule,
          perpSetup
        );
      });

      it("should NOT update the USDC defaultPositionUnit", async () => {
        const initialDefaultPositionUnit = await setToken.getDefaultPositionRealUnit(usdc.address);
        await subject();
        const finalDefaultPositionUnit = await setToken.getDefaultPositionRealUnit(usdc.address);

        expect(initialDefaultPositionUnit).eq(finalDefaultPositionUnit);
      });

      it("should NOT update the USDC defaultPositionUnit", async () => {
        const initialDefaultPositionUnit = await setToken.getDefaultPositionRealUnit(usdc.address);
        await subject();
        const finalDefaultPositionUnit = await setToken.getDefaultPositionRealUnit(usdc.address);;

        expect(finalDefaultPositionUnit).to.eq(initialDefaultPositionUnit);
      });

      it("should NOT update the virtual quote token position unit", async () => {
        const totalSupply = await setToken.totalSupply();
        const initialBaseBalance = (await perpBasisTradingModule.getPositionNotionalInfo(subjectSetToken))[0].baseBalance;
        const initialBasePositionUnit = preciseDiv(initialBaseBalance, totalSupply);

        await subject();

        const newTotalSupply = await setToken.totalSupply();
        const finalBaseBalance = (await perpBasisTradingModule.getPositionNotionalInfo(subjectSetToken))[0].baseBalance;
        const finalBasePositionUnit = preciseDiv(finalBaseBalance, newTotalSupply);

        expect(initialBasePositionUnit).to.eq(finalBasePositionUnit);
      });

      it("should have updated the USDC externalPositionUnit", async () => {
        const initialExternalPositionUnit = await setToken.getExternalPositionRealUnit(usdc.address, perpBasisTradingModule.address);
        await subject();
        const finalExternalPositionUnit = await setToken.getExternalPositionRealUnit(usdc.address, perpBasisTradingModule.address);

        const expectedExternalPositionUnit = preciseDiv(usdcTransferOutQuantity, quantityNetFees);

        expect(initialExternalPositionUnit).not.eq(finalExternalPositionUnit);
        expect(finalExternalPositionUnit).closeTo(expectedExternalPositionUnit, 1);
      });

      it("should have the expected virtual token balance", async () => {
        const totalSupply = await setToken.totalSupply();

        const initialBaseBalance = (await perpBasisTradingModule.getPositionNotionalInfo(subjectSetToken))[0].baseBalance;
        await subject();
        const finalBaseBalance = (await perpBasisTradingModule.getPositionNotionalInfo(subjectSetToken))[0].baseBalance;

        const basePositionUnit = preciseDiv(initialBaseBalance, totalSupply);
        const baseTokenBoughtNotional = preciseMul(basePositionUnit, quantityNetFees);
        const expectedBaseBalance = initialBaseBalance.sub(baseTokenBoughtNotional);

        expect(finalBaseBalance).eq(expectedBaseBalance);
      });

      it("should not have updated the setToken USDC token balance", async () => {
        const initialUSDCBalance = await usdc.balanceOf(subjectSetToken);
        await subject();
        const finalUSDCBalance = await usdc.balanceOf(subjectSetToken);

        expect(initialUSDCBalance).eq(finalUSDCBalance);
      });

      describe("when pending funding payment is positive", async () => {

        beforeEach(async () => {
          // Move oracle price down and wait one day
          await perpSetup.setBaseTokenOraclePrice(vETH, usdcUnits(10.5));
          await increaseTimeAsync(ONE_DAY_IN_SECONDS);
        });

        it("verify testing condiitons", async () => {
          const accountInfo = await perpBasisTradingModule.getAccountInfo(setToken.address);
          expect(accountInfo.pendingFundingPayments).to.be.gt(ZERO);
        });

        it("should not update the USDC defaultPositionUnit", async () => {
          const initialDefaultPositionUnit = await setToken.getDefaultPositionRealUnit(usdc.address);
          await subject();
          const finalDefaultPositionUnit = await setToken.getDefaultPositionRealUnit(usdc.address);

          expect(initialDefaultPositionUnit).eq(finalDefaultPositionUnit);
        });

        it("should have updated the USDC externalPositionUnit", async () => {
          const baseBalance = await perpSetup.accountBalance.getBase(setToken.address, vETH.address);
          usdcTransferOutQuantity = await calculateUSDCTransferOutPreciseUnits(
            setToken,
            quantityNetFees,
            perpBasisTradingModule,
            perpSetup
          );

          const initialExternalPositionUnit = await setToken.getExternalPositionRealUnit(usdc.address, perpBasisTradingModule.address);
          const totalSupplyBeforeRedeem = await setToken.totalSupply();
          const performanceFeePercentage = (await perpBasisTradingModule.feeSettings(subjectSetToken)).performanceFeePercentage;
          const settledFundingBefore = await perpBasisTradingModule.settledFunding(subjectSetToken);

          await subject();

          const netFundingGrowth = await getNetFundingGrowth(vETH.address, baseBalance, perpSetup);
          const performanceFeeUnit = toUSDCDecimals(
            preciseMul(
              preciseDivCeil(settledFundingBefore.add(netFundingGrowth), totalSupplyBeforeRedeem),
              performanceFeePercentage
            )
          );

          const expectedExternalPositionUnit = toUSDCDecimals(
            preciseDiv(usdcTransferOutQuantity, quantityNetFees)
          ).sub(performanceFeeUnit);

          const finalExternalPositionUnit = await setToken.getExternalPositionRealUnit(usdc.address, perpBasisTradingModule.address);

          expect(initialExternalPositionUnit).not.eq(finalExternalPositionUnit);
          expect(finalExternalPositionUnit).closeTo(expectedExternalPositionUnit, 30);
        });

        it("should have the expected virtual token balance", async () => {
          const totalSupply = await setToken.totalSupply();

          const initialBaseBalance = (await perpBasisTradingModule.getPositionNotionalInfo(subjectSetToken))[0].baseBalance;
          await subject();
          const finalBaseBalance = (await perpBasisTradingModule.getPositionNotionalInfo(subjectSetToken))[0].baseBalance;

          const basePositionUnit = preciseDiv(initialBaseBalance, totalSupply);
          const baseTokenBoughtNotional = preciseMul(basePositionUnit, quantityNetFees);
          const expectedBaseBalance = initialBaseBalance.sub(baseTokenBoughtNotional);

          expect(finalBaseBalance).eq(expectedBaseBalance);
        });

        it("should not have updated the setToken USDC token balance", async () => {
          const initialUSDCBalance = await usdc.balanceOf(subjectSetToken);
          await subject();
          const finalUSDCBalance = await usdc.balanceOf(subjectSetToken);

          expect(initialUSDCBalance).eq(finalUSDCBalance);
        });

      });

      describe("withdrawal", () => {
        let feeAdjustedTransferOutUSDC: BigNumber;
        let realizedPnlUSDC: BigNumber;

        beforeEach(async () => {
          ({
            feeAdjustedTransferOutUSDC,
            realizedPnlUSDC
          } = await calculateRedemptionData(
            subjectSetToken,
            quantityNetFees,
            usdcTransferOutQuantity
          ));
        });

        it("should withdraw the expected amount from the Perp vault", async () => {
          const initialCollateralBalance = (await perpBasisTradingModule.getAccountInfo(subjectSetToken)).collateralBalance;
          await subject();
          const finalCollateralBalance = (await perpBasisTradingModule.getAccountInfo(subjectSetToken)).collateralBalance;

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
          expect(finalOwnerUSDCBalance).closeTo(expectedUSDCBalance, 1);
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
        await slippageIssuanceModule.issueWithSlippage(setToken.address, issueQuantity, [], [], owner.address);

        // Deposit entire default position
        depositQuantityUnit = usdcDefaultPositionUnit;
        await perpBasisTradingModule.deposit(setToken.address, depositQuantityUnit);

        // Lever up 2X
        baseToken = vETH.address;
        await leverUp(
          setToken,
          perpBasisTradingModule,
          perpSetup,
          owner,
          baseToken,
          2,
          ether(.02),
          true,
          true
        );

        subjectSetToken = setToken.address;
        subjectQuantity = ether(1);
        subjectCheckedComponents = [];
        subjectMaxTokenAmountsIn = [];
        subjectTo = owner.address;
        subjectCaller = owner;

        quantityNetFees = calculateQuantityNetFees(subjectQuantity, issueFee, redeemFee, false);
        usdcTransferOutQuantity = await calculateUSDCTransferOut(
          setToken,
          quantityNetFees,
          perpBasisTradingModule,
          perpSetup
        );
      });

      it("should NOT update the USDC defaultPositionUnit", async () => {
        const initialDefaultPositionUnit = await setToken.getDefaultPositionRealUnit(usdc.address);
        await subject();
        const finalDefaultPositionUnit = await setToken.getDefaultPositionRealUnit(usdc.address);

        expect(initialDefaultPositionUnit).eq(finalDefaultPositionUnit);
      });

      it("should NOT update the USDC defaultPositionUnit", async () => {
        const initialDefaultPositionUnit = await setToken.getDefaultPositionRealUnit(usdc.address);
        await subject();
        const finalDefaultPositionUnit = await setToken.getDefaultPositionRealUnit(usdc.address);;

        expect(finalDefaultPositionUnit).to.eq(initialDefaultPositionUnit);
      });

      it("should NOT update the virtual quote token position unit", async () => {
        const totalSupply = await setToken.totalSupply();
        const initialBaseBalance = (await perpBasisTradingModule.getPositionNotionalInfo(subjectSetToken))[0].baseBalance;
        const initialBasePositionUnit = preciseDiv(initialBaseBalance, totalSupply);

        await subject();

        const newTotalSupply = await setToken.totalSupply();
        const finalBaseBalance = (await perpBasisTradingModule.getPositionNotionalInfo(subjectSetToken))[0].baseBalance;
        const finalBasePositionUnit = preciseDiv(finalBaseBalance, newTotalSupply);

        expect(initialBasePositionUnit).to.eq(finalBasePositionUnit);
      });

      it("should update the USDC externalPositionUnit", async () => {
        const initialExternalPositionUnit = await setToken.getExternalPositionRealUnit(usdc.address, perpBasisTradingModule.address);
        await subject();
        const finalExternalPositionUnit = await setToken.getExternalPositionRealUnit(usdc.address, perpBasisTradingModule.address);

        // initialExternalPositionUnit = 10_000_000
        // finalExternalPositionUnit   =  9_597_857

        const expectedExternalPositionUnit = preciseDiv(usdcTransferOutQuantity, quantityNetFees);
        expect(initialExternalPositionUnit).eq(usdcDefaultPositionUnit);
        expect(finalExternalPositionUnit).to.be.closeTo(expectedExternalPositionUnit, 1);
      });

      it("should have the expected virtual token balance", async () => {
        const totalSupply = await setToken.totalSupply();

        const initialBaseBalance = (await perpBasisTradingModule.getPositionNotionalInfo(subjectSetToken))[0].baseBalance;
        await subject();
        const finalBaseBalance = (await perpBasisTradingModule.getPositionNotionalInfo(subjectSetToken))[0].baseBalance;

        const basePositionUnit = preciseDiv(initialBaseBalance, totalSupply);
        const baseTokenSoldNotional = preciseMul(basePositionUnit, quantityNetFees);
        const expectedBaseBalance = initialBaseBalance.sub(baseTokenSoldNotional);

        expect(finalBaseBalance).eq(expectedBaseBalance);
      });

      it("should get required component redemption units correctly", async () => {
        const externalPositionUnit = preciseDiv(usdcTransferOutQuantity, quantityNetFees);
        const feeAdjustedTransferOut = preciseMul(quantityNetFees, externalPositionUnit);

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

      it("should return the expected amount to the redeemer", async () => {
        const [, equityFlows, debtFlows] = await slippageIssuanceModule
          .callStatic
          .getRequiredComponentRedemptionUnitsOffChain(
            subjectSetToken,
            subjectQuantity
          );

        const setBalanceBefore = await setToken.balanceOf(subjectTo);
        const usdcBalanceBefore = await perpSetup.usdc.balanceOf(subjectTo);
        await subject();
        const setBalanceAfter = await setToken.balanceOf(subjectTo);
        const usdcBalanceAfter = await perpSetup.usdc.balanceOf(subjectTo);

        expect(subjectQuantity).to.be.eq(setBalanceBefore.sub(setBalanceAfter));
        expect(equityFlows[0]).to.be.closeTo(usdcBalanceAfter.sub(usdcBalanceBefore), 50);
        expect(debtFlows[0]).to.eq(ZERO);
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
        const accountInfo = await perpBasisTradingModule.getAccountInfo(subjectSetToken);
        const spotPrice = await perpSetup.getSpotPrice(baseToken);
        const baseBalance = (await perpBasisTradingModule.getPositionNotionalInfo(subjectSetToken))[0].baseBalance;
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

      describe("when pending funding payment is positive", async () => {
        beforeEach(async () => {
          // Move oracle price down and wait one day
          await perpSetup.setBaseTokenOraclePrice(vETH, usdcUnits(10.5));
          await increaseTimeAsync(ONE_DAY_IN_SECONDS);
        });

        it("verify testing condiitons", async () => {
          const accountInfo = await perpBasisTradingModule.getAccountInfo(setToken.address);
          expect(accountInfo.pendingFundingPayments).to.be.gt(ZERO);
        });

        it("should not update the USDC defaultPositionUnit", async () => {
          const initialDefaultPositionUnit = await setToken.getDefaultPositionRealUnit(usdc.address);
          await subject();
          const finalDefaultPositionUnit = await setToken.getDefaultPositionRealUnit(usdc.address);

          expect(initialDefaultPositionUnit).eq(finalDefaultPositionUnit);
        });

        it("should have updated the USDC externalPositionUnit", async () => {
          const baseBalance = await perpSetup.accountBalance.getBase(setToken.address, vETH.address);
          usdcTransferOutQuantity = await calculateUSDCTransferOutPreciseUnits(
            setToken,
            quantityNetFees,
            perpBasisTradingModule,
            perpSetup
          );

          const initialExternalPositionUnit = await setToken.getExternalPositionRealUnit(usdc.address, perpBasisTradingModule.address);
          const totalSupplyBeforeRedeem = await setToken.totalSupply();
          const performanceFeePercentage = (await perpBasisTradingModule.feeSettings(subjectSetToken)).performanceFeePercentage;
          const settledFundingBefore = await perpBasisTradingModule.settledFunding(subjectSetToken);

          await subject();

          const netFundingGrowth = await getNetFundingGrowth(vETH.address, baseBalance, perpSetup);
          const performanceFeeUnit = toUSDCDecimals(
            preciseMul(
              preciseDivCeil(settledFundingBefore.add(netFundingGrowth), totalSupplyBeforeRedeem),
              performanceFeePercentage
            )
          );

          const expectedExternalPositionUnit = toUSDCDecimals(
            preciseDiv(usdcTransferOutQuantity, quantityNetFees)
          ).sub(performanceFeeUnit);

          const finalExternalPositionUnit = await setToken.getExternalPositionRealUnit(usdc.address, perpBasisTradingModule.address);

          expect(initialExternalPositionUnit).not.eq(finalExternalPositionUnit);
          expect(finalExternalPositionUnit).closeTo(expectedExternalPositionUnit, 30);
        });

        it("should have the expected virtual token balance", async () => {
          const totalSupply = await setToken.totalSupply();

          const initialBaseBalance = (await perpBasisTradingModule.getPositionNotionalInfo(subjectSetToken))[0].baseBalance;
          await subject();
          const finalBaseBalance = (await perpBasisTradingModule.getPositionNotionalInfo(subjectSetToken))[0].baseBalance;

          const basePositionUnit = preciseDiv(initialBaseBalance, totalSupply);
          const baseTokenBoughtNotional = preciseMul(basePositionUnit, quantityNetFees);
          const expectedBaseBalance = initialBaseBalance.sub(baseTokenBoughtNotional);

          expect(finalBaseBalance).eq(expectedBaseBalance);
        });

        it("should not have updated the setToken USDC token balance", async () => {
          const initialUSDCBalance = await usdc.balanceOf(subjectSetToken);
          await subject();
          const finalUSDCBalance = await usdc.balanceOf(subjectSetToken);

          expect(initialUSDCBalance).eq(finalUSDCBalance);
        });
      });

      describe("withdrawal", () => {
        let feeAdjustedTransferOutUSDC: BigNumber;
        let realizedPnlUSDC: BigNumber;

        beforeEach(async () => {
          ({
            feeAdjustedTransferOutUSDC,
            realizedPnlUSDC
          } = await calculateRedemptionData(
            subjectSetToken,
            quantityNetFees,
            usdcTransferOutQuantity)
          );
        });

        it("should withdraw the expected amount from the Perp vault", async () => {
          const initialCollateralBalance = (await perpBasisTradingModule.getAccountInfo(subjectSetToken)).collateralBalance;
          await subject();
          const finalCollateralBalance = (await perpBasisTradingModule.getAccountInfo(subjectSetToken)).collateralBalance;

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

        it("should remove the module and be able to add module back", async () => {
          // Redeem to `1`
          await subject();

          // Check precondition
          const initialModules = await setToken.getModules();
          expect(initialModules.includes(perpBasisTradingModule.address)).eq(true);

          // Trade to `0`
          const {
            baseUnit: initialBaseUnit
          } = (await perpBasisTradingModule.getPositionUnitInfo(subjectSetToken))[0];

          await perpBasisTradingModule.connect(owner.wallet).trade(
            subjectSetToken,
            baseToken,
            initialBaseUnit.mul(-1),
            ZERO
          );

          const positionInfo = await perpBasisTradingModule.getPositionUnitInfo(subjectSetToken);

          // Withdraw remaining free collateral
          const freeCollateral = await perpSetup.vault.getFreeCollateral(subjectSetToken);
          const freeCollateralPositionUnit = preciseDiv(freeCollateral, await setToken.totalSupply());

          // freeCollateral = 9737806
          // withdrawing this amount as a positionUnit results in a freeCollateral balance of `1`
          // that can't be withdrawn due to positionUnit math rounding errors.
          await perpBasisTradingModule
            .connect(owner.wallet)
            .withdraw(subjectSetToken, freeCollateralPositionUnit);

          /// Remove module
          await setToken.removeModule(perpBasisTradingModule.address);
          const finalModules = await setToken.getModules();

          expect(finalModules.includes(perpBasisTradingModule.address)).eq(false);
          expect(positionInfo.length).eq(0);

          // Restore module
          await setToken.connect(owner.wallet).addModule(perpBasisTradingModule.address);
          await perpBasisTradingModule.updateAllowedSetToken(setToken.address, true);
          await perpBasisTradingModule["initialize(address,(address,uint256,uint256))"](
            setToken.address,
            {
              feeRecipient: owner.address,
              performanceFeePercentage: ether(.0),
              maxPerformanceFeePercentage: ether(.2)
            }
          );

          const restoredModules = await setToken.getModules();
          expect(restoredModules.includes(perpBasisTradingModule.address)).eq(true);

          // Verify that we can deposit again
          await perpBasisTradingModule.deposit(setToken.address, usdcUnits(5));
        });
      });

      describe("when redeeming after a liquidation", async () => {
        beforeEach(async () => {
          subjectQuantity = ether(1);
          quantityNetFees = calculateQuantityNetFees(subjectQuantity, issueFee, redeemFee, false);

          // Calculated leverage = ~8.5X = 8_654_438_822_995_683_587
          await leverUp(
            setToken,
            perpBasisTradingModule,
            perpSetup,
            owner,
            baseToken,
            6,
            ether(.02),
            true,
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
          const initialCollateralBalance = (await perpBasisTradingModule.getAccountInfo(subjectSetToken)).collateralBalance;

          // Total amount of owedRealizedPnl will be debited from collateral balance
          const { owedRealizedPnl } = await perpBasisTradingModule.getAccountInfo(subjectSetToken);
          const owedRealizedPnlUSDC = toUSDCDecimals(owedRealizedPnl);

          await subject();

          const finalTotalSupply = await setToken.totalSupply();
          const finalPositionInfo = await perpBasisTradingModule.getPositionNotionalInfo(subjectSetToken);
          const finalCollateralBalance = (await perpBasisTradingModule.getAccountInfo(subjectSetToken)).collateralBalance;

          const usdcTransferOutQuantity = await calculateUSDCTransferOut(
            setToken,
            quantityNetFees,
            perpBasisTradingModule,
            perpSetup
          );

          const {
            feeAdjustedTransferOutUSDC,
          } = await calculateRedemptionData(
            subjectSetToken,
            quantityNetFees,
            usdcTransferOutQuantity
          );

          const expectedTotalSupply = initialTotalSupply.sub(quantityNetFees);
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
          // Move oracle price down, wait one day
          await perpSetup.setBaseTokenOraclePrice(vETH, usdcUnits(10.5));
          await increaseTimeAsync(ONE_DAY_IN_SECONDS);

          // Calculated leverage = ~8.5X = 8_654_438_822_995_683_587
          // Lever again to track funding as `settled`
          await leverUp(
            setToken,
            perpBasisTradingModule,
            perpSetup,
            owner,
            baseToken,
            6,
            ether(.02),
            true,
            true
          );

          // Freeze funding changes
          await perpSetup.clearingHouseConfig.setMaxFundingRate(ZERO);

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
          const initialRedeemerUSDCBalance = await usdc.balanceOf(subjectCaller.address);
          const initialTotalSupply = await setToken.totalSupply();

          await subject();

          const finalRedeemerUSDCBalance = await usdc.balanceOf(subjectCaller.address);
          const finalTotalSupply = await setToken.totalSupply();

          const expectedTotalSupply = initialTotalSupply.sub(quantityNetFees);

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
          await setToken.removeModule(perpBasisTradingModule.address);
          const finalModules = await setToken.getModules();
          expect(finalModules.includes(perpBasisTradingModule.address)).eq(false);
        });
      });
    });
  });
});
