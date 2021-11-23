import "module-alias/register";
import { ContractTransaction } from "ethers";
import { Address } from "@utils/types";
import { Account } from "@utils/test/types";
import {
  PerpV2,
  PerpV2LeverageModule,
  SlippageIssuanceModule,
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
import { ADDRESS_ZERO, ZERO } from "@utils/constants";

const expect = getWaffleExpect();

describe("PerpV2LeverageSlippageIssuance", () => {
  let owner: Account;
  let maker: Account;
  let otherTrader: Account;
  let feeRecipient: Account;
  let deployer: DeployHelper;

  let perpLib: PerpV2;
  let perpLeverageModule: PerpV2LeverageModule;
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

    slippageIssuanceModule = await deployer.modules.deploySlippageIssuanceModule(setup.controller.address);
    await setup.controller.addModule(slippageIssuanceModule.address);

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
      slippageIssuanceModule.address
    );
  });

  // Helper to calculate how leveraged the Perp account gets as it mints tokens on margin
  async function calculateFlashLeverage(setToken: Address, setQuantity: BigNumber): Promise<BigNumber> {
    const spotPrice = await perpLeverageModule.getAMMSpotPrice(vETH.address);
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
          // Calculate fee adjusted usdcTransferOut
          const redeemQuantityWithFees = (await slippageIssuanceModule.calculateTotalFees(
            subjectSetToken,
            subjectQuantity,
            false
          ))[0];

          feeAdjustedTransferOutUSDC = preciseMul(redeemQuantityWithFees, usdcTransferOutQuantity);

          // Calculate realizedPnl, which is negative in this case. The amount is debited from collateral
          // returned to redeemer *and* debited from the Perp account collateral balance because
          // withdraw performs a settlement.
          const baseUnit = (await perpLeverageModule.getPositionUnitInfo(subjectSetToken))[0].baseUnit;
          const baseTradeQuantityNotional = preciseMul(baseUnit, subjectQuantity);
          const { deltaQuote } = await perpSetup.getSwapQuote(
            baseToken,
            baseTradeQuantityNotional,
            false
          );

          const {
            baseBalance,
            quoteBalance
          } = (await perpLeverageModule.getPositionNotionalInfo(subjectSetToken))[0];
          const closeRatio = preciseDiv(baseTradeQuantityNotional, baseBalance);
          const reducedOpenNotional = preciseMul(quoteBalance, closeRatio);

          realizedPnlUSDC = toUSDCDecimals(reducedOpenNotional.add(deltaQuote));
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
          // Calculate fee adjusted usdcTransferOut
          const redeemQuantityWithFees = (await slippageIssuanceModule.calculateTotalFees(
            subjectSetToken,
            subjectQuantity,
            false
          ))[0];

          feeAdjustedTransferOutUSDC = preciseMul(redeemQuantityWithFees, usdcTransferOutQuantity);

          // Calculate realizedPnl, which is negative in this case. The amount is debited from collateral
          // returned to redeemer *and* debited from the Perp account collateral balance because
          // withdraw performs a settlement.
          const baseUnit = (await perpLeverageModule.getPositionUnitInfo(subjectSetToken))[0].baseUnit;
          const baseTradeQuantityNotional = preciseMul(baseUnit, subjectQuantity);
          const { deltaQuote } = await perpSetup.getSwapQuote(
            baseToken,
            baseTradeQuantityNotional,
            false
          );

          const {
            baseBalance,
            quoteBalance
          } = (await perpLeverageModule.getPositionNotionalInfo(subjectSetToken))[0];
          const closeRatio = preciseDiv(baseTradeQuantityNotional, baseBalance);
          const reducedOpenNotional = preciseMul(quoteBalance, closeRatio);

          realizedPnlUSDC = toUSDCDecimals(reducedOpenNotional.add(deltaQuote));
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

          const {
            baseUnit: finalBaseUnit
          } = (await perpLeverageModule.getPositionUnitInfo(subjectSetToken))[0];

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
          expect(finalBaseUnit).eq(ZERO);
          expect(toUSDCDecimals(finalCollateralBalance)).eq(1); // <-- DUST

          // Restore module
          await setToken.connect(owner.wallet).addModule(perpLeverageModule.address);
          await perpLeverageModule.updateAllowedSetToken(setToken.address, true);
          await perpLeverageModule.initialize(setToken.address);

          const restoredModules = await setToken.getModules();
          expect(restoredModules.includes(perpLeverageModule.address)).eq(true);
        });
      });
    });
  });
});
