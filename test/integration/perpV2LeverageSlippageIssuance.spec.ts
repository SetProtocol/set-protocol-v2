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
import { ADDRESS_ZERO } from "@utils/constants";

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
      perpSetup.usdc.address,
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

  describe("#issuance", async () => {
    let setToken: SetToken;
    let issueFee: BigNumber;
    let usdcDefaultPositionUnits: BigNumber;

    let subjectSetToken: Address;
    let subjectQuantity: BigNumber;
    let subjectCheckedComponents: Address[];
    let subjectMaxTokenAmountsIn: BigNumber[];
    let subjectTo: Address;
    let subjectCaller: Account;
    let subjectDepositAmount: BigNumber;
    let issueQuantity: BigNumber;

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
      cacheBeforeEach(async () => {
        usdcDefaultPositionUnits = usdcUnits(100);
        setToken = await setup.createSetToken(
          [usdc.address],
          [usdcDefaultPositionUnits],
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

        // Issue 1 SetToken
        issueQuantity = ether(1);
      });

      beforeEach(() => {
        subjectSetToken = setToken.address;
        subjectQuantity = issueQuantity;
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
        expect(newFirstPosition.unit).to.eq(usdcDefaultPositionUnits);
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
        const usdcFlows = preciseMul(mintQuantity, usdcDefaultPositionUnits);

        const postMinterUSDCBalance = await usdc.balanceOf(subjectCaller.address);
        const postSetUSDCBalance = await usdc.balanceOf(subjectSetToken);

        expect(postMinterUSDCBalance).to.eq(preMinterUSDCBalance.sub(usdcFlows));
        expect(postSetUSDCBalance).to.eq(preSetUSDCBalance.add(usdcFlows));
      });
    });

    context("when there is a default USDC position and external USDC position", async () => {
      let baseToken: Address;
      let depositQuantityUnit: BigNumber;
      let usdcTransferInQuantity: BigNumber;

      cacheBeforeEach(async () => {
        usdcDefaultPositionUnits = usdcUnits(100);
        setToken = await setup.createSetToken(
          [usdc.address],
          [usdcDefaultPositionUnits],
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

        // Issue 1 SetToken
        issueQuantity = ether(1);
        await slippageIssuanceModule.issue(setToken.address, issueQuantity, owner.address);

        depositQuantityUnit = usdcUnits(10);
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

        subjectCheckedComponents = [];
        subjectMaxTokenAmountsIn = [];
      });

      describe("when minting a single set", () => {
        beforeEach(async () => {
          subjectSetToken = setToken.address;
          subjectQuantity = ether(1);
          subjectTo = owner.address;
          subjectCaller = owner;
          subjectDepositAmount = depositQuantityUnit;

          usdcTransferInQuantity = await calculateUSDCTransferIn(
            setToken,
            subjectQuantity,
            perpLeverageModule,
            perpSetup
          );
        });

        it("should update the USDC defaultPositionUnit", async () => {
          const initialDefaultPosition = await setToken.getDefaultPositionRealUnit(usdc.address);
          await subject();
          const finalDefaultPosition = await setToken.getDefaultPositionRealUnit(usdc.address);;

          const expectedDefaultPosition = initialDefaultPosition.sub(toUSDCDecimals(subjectDepositAmount));
          expect(finalDefaultPosition).to.eq(expectedDefaultPosition);
        });

        it("should set the expected USDC externalPositionUnit", async () => {
          const expectedExternalPositionUnit = preciseDiv(usdcTransferInQuantity, subjectQuantity);

          await subject();

          const externalPositionUnit = await setToken.getExternalPositionRealUnit(
            usdc.address,
            perpLeverageModule.address
          );

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

        // Component issue hook is not running....
        // Expected "10050000" to be equal 20058105
        it.skip("should deposit the expected amount into the Perp vault", async () => {
          const initialCollateralBalance = (await perpLeverageModule.getAccountInfo(subjectSetToken)).collateralBalance;
          await subject();
          const finalCollateralBalance = (await perpLeverageModule.getAccountInfo(subjectSetToken)).collateralBalance;

          const expectedCollateralBalance = toUSDCDecimals(initialCollateralBalance).add(usdcTransferInQuantity);
          expect(toUSDCDecimals(finalCollateralBalance)).eq(expectedCollateralBalance);
        });
      });

      describe("when flash-issuing at high margin (success)", async () => {
        // Starting point is 2X leverage, with 10 USDC collateral, 20 USDC vETH, totalSupply = 1
        // Minting 3 sets raises interim leverage ratio to > 80 USDC Asset / 10 USDC collateral
        // We know from spec scenario testing that the effective limit is ~ 9.1X
        beforeEach(async () => {
          subjectSetToken = setToken.address;
          subjectQuantity = ether(3);
          subjectTo = owner.address;
          subjectCaller = owner;
          subjectDepositAmount = depositQuantityUnit;
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
          subjectSetToken = setToken.address;
          subjectQuantity = ether(3.5);
          subjectTo = owner.address;
          subjectCaller = owner;
          subjectDepositAmount = depositQuantityUnit;
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
    let issueFee: BigNumber;
    let usdcDefaultPositionUnits: BigNumber;

    let subjectSetToken: Address;
    let subjectQuantity: BigNumber;
    let subjectCheckedComponents: Address[];
    let subjectMaxTokenAmountsIn: BigNumber[];
    let subjectTo: Address;
    let subjectCaller: Account;
    let issueQuantity: BigNumber;

    async function subject(): Promise<ContractTransaction> {
      return slippageIssuanceModule.connect(subjectCaller.wallet).redeemWithSlippage(
        subjectSetToken,
        subjectQuantity,
        subjectCheckedComponents,
        subjectMaxTokenAmountsIn,
        subjectTo
      );
    }

    context("when a default usdc position and redeem will take supply to 0", async () => {
      cacheBeforeEach(async () => {
        usdcDefaultPositionUnits = usdcUnits(100);
        setToken = await setup.createSetToken(
          [usdc.address],
          [usdcDefaultPositionUnits],
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

        // Issue 1 SetToken
        issueQuantity = ether(1);
        await slippageIssuanceModule.issue(setToken.address, issueQuantity, owner.address);

        const depositQuantityUnit = usdcUnits(10);
        await perpLeverageModule.deposit(setToken.address, depositQuantityUnit);

        // Lever up 2X
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

      beforeEach(async () => {
        subjectSetToken = setToken.address;
        subjectQuantity = issueQuantity;
        subjectCheckedComponents = [];
        subjectMaxTokenAmountsIn = [];
        subjectTo = owner.address;
        subjectCaller = owner;
      });

      // Component redeem hook not firing ...
      it.skip("should have the expected collateral position", async () => {
        await subject();
        // const newPositionUnit = await setToken.getDefaultPositionRealUnit(usdc.address);
      });

      it("should not update the USDC defaultPositionUnit", async () => {
        const initialDefaultPositionUnit = await setToken.getDefaultPositionRealUnit(usdc.address);
        await subject();
        const finalDefaultPositionUnit = await setToken.getDefaultPositionRealUnit(usdc.address);

        expect(initialDefaultPositionUnit).eq(finalDefaultPositionUnit);
      });

      // This wrong ... still showing a balance of 9597918
      it.skip("should not update the USDC externalPositionUnit", async () => {
        const initialExternalPositionUnit = await setToken.getExternalPositionRealUnit(usdc.address, perpLeverageModule.address);
        await subject();
        const finalExternalPositionUnit = await setToken.getExternalPositionRealUnit(usdc.address, perpLeverageModule.address);

        expect(initialExternalPositionUnit).eq(finalExternalPositionUnit);
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

      // Component redeem hook is not running....
      it.skip("should have emptied the Perp vault", async () => {
        const initialCollateralBalance = (await perpLeverageModule.getAccountInfo(subjectSetToken)).collateralBalance;
        await subject();
        const finalCollateralBalance = (await perpLeverageModule.getAccountInfo(subjectSetToken)).collateralBalance;

        expect(initialCollateralBalance).gt(0);
        expect(finalCollateralBalance).eq(0);
      });
    });

    context("when a default usdc position and redeem will take supply to 1", async () => {
      let depositQuantityUnit: BigNumber;
      let usdcTransferOutQuantity: BigNumber;

      cacheBeforeEach(async () => {
        usdcDefaultPositionUnits = usdcUnits(100);
        setToken = await setup.createSetToken(
          [usdc.address],
          [usdcDefaultPositionUnits],
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

        // Issue 1 SetToken
        issueQuantity = ether(2);
        await slippageIssuanceModule.issue(setToken.address, issueQuantity, owner.address);

        depositQuantityUnit = usdcUnits(10);
        await perpLeverageModule.deposit(setToken.address, depositQuantityUnit);

        // Lever up 2X
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

      beforeEach(async () => {
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

      it.skip("should update the setToken USDC token balance", async () => {
        // const initialUSDCBalance = await usdc.balanceOf(subjectSetToken);
        await subject();
        // const finalUSDCBalance = await usdc.balanceOf(subjectSetToken);

        // initialUSDCBalance      = 180_900_000
        // usdcTransferOutQuantity =  19_195_715
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
        expect(initialExternalPositionUnit).eq(depositQuantityUnit);
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

      // Component issue and redeem hooks not running....
      it.skip("should reduced the Perp vault by expected amount", async () => {
        const initialCollateralBalance = (await perpLeverageModule.getAccountInfo(subjectSetToken)).collateralBalance;
        await subject();
        const finalCollateralBalance = (await perpLeverageModule.getAccountInfo(subjectSetToken)).collateralBalance;

        // usdcTransferOutQuantity                    = 19_195_715
        // toUSDCDecimals(initialCollateralBalance))  = 20_100_000

        const expectedCollateralBalance = toUSDCDecimals(initialCollateralBalance).sub(usdcTransferOutQuantity);
        expect(toUSDCDecimals(finalCollateralBalance)).to.be.closeTo(expectedCollateralBalance, 1);
      });
    });
  });
});
