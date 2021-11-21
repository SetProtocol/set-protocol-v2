import "module-alias/register";

import { utils, constants, BigNumber } from "ethers";
import { Account } from "@utils/test/types";
import { ether, usdc } from "@utils/common";
import {
  addSnapshotBeforeRestoreAfterEach,
  getAccounts,
  getPerpV2Fixture,
  getWaffleExpect,
} from "@utils/test/index";

import { PerpV2Fixture } from "@utils/fixtures";

const expect = getWaffleExpect();

describe("PerpV2Fixture", () => {
  let owner: Account;
  let maker: Account;
  let taker: Account;
  let perpV2: PerpV2Fixture;

  before(async () => {
    [ owner, maker, taker ] = await getAccounts();
    perpV2 = getPerpV2Fixture(owner.address);
    await perpV2.initialize(maker, taker);
  });

  addSnapshotBeforeRestoreAfterEach();

  describe("#initializePoolWithLiquidityWide", () => {
    const takerCollateralWholeUnitAmount = "1000";

    // 10 USDC : 1 BaseToken
    const subjectBaseTokenAmount = ether(10_000);
    const subjectQuoteTokenAmount = ether(100_000);

    beforeEach(async () => {
      await perpV2.usdc.mint(taker.address, utils.parseUnits(takerCollateralWholeUnitAmount, 6));
      await perpV2.deposit(taker, BigNumber.from(takerCollateralWholeUnitAmount), perpV2.usdc);
    });

    async function subject(): Promise<void> {
      return await perpV2.initializePoolWithLiquidityWide(
        perpV2.vETH,
        subjectBaseTokenAmount,
        subjectQuoteTokenAmount
      );
    }

    it("should have the expected baseToken vAMM price at beginning", async () => {
      await subject();

      const expectedPrice = ether(10);
      const ammBaseTokenPrice = await perpV2.getSpotPrice(perpV2.vETH.address);
      expect(expectedPrice).to.be.closeTo(ammBaseTokenPrice, 1); // 1 wei difference
    });

    it("should be possible to open a long position / price will change", async () => {
      await subject();

      const initialAmmBaseTokenPrice = await perpV2.getSpotPrice(perpV2.vETH.address);

      await perpV2.clearingHouse.connect(taker.wallet).openPosition({
        baseToken: perpV2.vETH.address,
        isBaseToQuote: false,
        isExactInput: true,
        oppositeAmountBound: 0,
        amount: ether(100),
        sqrtPriceLimitX96: 0,
        deadline: constants.MaxUint256,
        referralCode: constants.HashZero,
      });

      const finalAmmBaseTokenPrice = await perpV2.getSpotPrice(perpV2.vETH.address);
      expect(initialAmmBaseTokenPrice).to.be.lt(finalAmmBaseTokenPrice);
    });
  });

  describe("#initializePoolWithLiquidityWithinTicks", () => {
    const baseTokenAmount = 65.943787;
    const quoteTokenAmount = 10_000;

    const subjectBaseTokenAmount = ether(baseTokenAmount);
    const subjectQuoteTokenAmount = ether(quoteTokenAmount);
    const subjectLowerTick = 0;
    const subjectUpperTick = 100_000;

    async function subject(): Promise<void> {
      return await perpV2.initializePoolWithLiquidityWithinTicks(
        perpV2.vETH,
        subjectBaseTokenAmount,
        subjectQuoteTokenAmount,
        subjectLowerTick,
        subjectUpperTick
      );
    }

    it("should have the expected baseToken vAMM price at beginning", async () => {
      await subject();

      const expectedPrice = ether(quoteTokenAmount / baseTokenAmount);     // 151644308811078730000
      const spotPrice = await perpV2.getSpotPrice(perpV2.vETH.address);   // 151644308811078744992
      expect(expectedPrice).to.be.closeTo(spotPrice, 20000);
    });
  });

  describe("#setBaseTokenOraclePrice", () => {
    const takerCollateralWholeUnitAmount = "1000";
    const takerBuyAmount = 100;

    // vAMM = 1 BaseToken = 10 USDC
    const vETHAmount = ether(10_000);
    const vQuoteAmount = ether(100_000);

    const subjectOraclePrice = usdc(15.15);

    beforeEach(async () => {
      await perpV2.usdc.mint(taker.address, utils.parseUnits(takerCollateralWholeUnitAmount, 6));
      await perpV2.deposit(taker, BigNumber.from(takerCollateralWholeUnitAmount), perpV2.usdc);
      await perpV2.initializePoolWithLiquidityWide(
        perpV2.vETH,
        vETHAmount,
        vQuoteAmount
      );

      // Take long position
      await perpV2.clearingHouse.connect(taker.wallet).openPosition({
        baseToken: perpV2.vETH.address,
        isBaseToQuote: false,
        isExactInput: true,
        oppositeAmountBound: 0,
        amount: ether(takerBuyAmount),
        sqrtPriceLimitX96: 0,
        deadline: constants.MaxUint256,
        referralCode: constants.HashZero,
      });
    });

    async function subject(): Promise<void> {
      return await perpV2.setBaseTokenOraclePrice(perpV2.vETH, subjectOraclePrice);
    }

    it("should update the oracle price and increase taker account value", async () => {
      const initialTakerAccountValue = await perpV2.clearingHouse.getAccountValue(taker.address);

      await subject();

      const finalTakerAccountValue = await perpV2.clearingHouse.getAccountValue(taker.address);
      expect(initialTakerAccountValue).to.be.lt(finalTakerAccountValue);
    });
  });
});
