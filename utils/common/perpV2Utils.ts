import { Address } from "@utils/types";
import { Account } from "@utils/test/types";
import { BigNumber } from "ethers";

import {
  ether,
  preciseDiv,
  preciseMul
} from "@utils/index";

import { ZERO } from "@utils/constants";
import { PerpV2LeverageModule, SetToken } from "@utils/contracts";
import { PerpV2Fixture } from "@utils/fixtures";


// Converts PRECISE_UNIT value into USDC decimals value
export function toUSDCDecimals(quantity: BigNumber): BigNumber {
  return quantity.div(BigNumber.from(10).pow(12));
}

// Allocates all deposited collateral to a levered position. Returns new baseToken position unit
export async function leverUp(
  setToken: SetToken,
  module: PerpV2LeverageModule,
  fixture: PerpV2Fixture,
  owner: Account,
  baseToken: Address,
  leverageRatio: number,
  slippagePercentage: BigNumber,
  isLong: boolean
): Promise<BigNumber>{
  const spotPrice = await fixture.getSpotPrice(baseToken);
  const totalSupply = await setToken.totalSupply();
  const collateralBalance = (await module.getAccountInfo(setToken.address)).collateralBalance;
  const baseTradeQuantityNotional = preciseDiv(collateralBalance.mul(leverageRatio), spotPrice);

  const baseTradeQuantityUnit = (isLong)
    ? preciseDiv(baseTradeQuantityNotional, totalSupply)
    : preciseDiv(baseTradeQuantityNotional, totalSupply).mul(-1);

  const estimatedQuoteQuantityNotional =  preciseMul(baseTradeQuantityNotional, spotPrice).abs();
  const allowedSlippage = preciseMul(estimatedQuoteQuantityNotional, ether(.02));

  const slippageAdjustedQuoteQuanitityNotional = (isLong)
    ? estimatedQuoteQuantityNotional.add(allowedSlippage)
    : estimatedQuoteQuantityNotional.sub(allowedSlippage);

  const receiveQuoteQuantityUnit = preciseDiv(
    slippageAdjustedQuoteQuanitityNotional,
    totalSupply
  );

  await module.connect(owner.wallet).trade(
    setToken.address,
    baseToken,
    baseTradeQuantityUnit,
    receiveQuoteQuantityUnit
  );

  return baseTradeQuantityUnit;
}

// Returns notional amount of USDC to transfer in on redeem. Handles multiple positions, long and short.
export async function calculateUSDCTransferIn(
  setToken: SetToken,
  setQuantity: BigNumber,
  module: PerpV2LeverageModule,
  fixture: PerpV2Fixture,
) {
  let totalPositionAbsoluteValue = BigNumber.from(0);
  let totalPositionNetValue = BigNumber.from(0);
  let usdcAmountIn = BigNumber.from(0);

  const allPositionInfo = await module.getPositionNotionalInfo(setToken.address);
  const collateralBalance = (await module.getAccountInfo(setToken.address)).collateralBalance;
  const netQuoteBalance = await fixture.accountBalance.getNetQuoteBalance(setToken.address);

  for (const positionInfo of allPositionInfo) {
    const spotPrice = await fixture.getSpotPrice(positionInfo.baseToken);
    const positionValue = preciseMul(positionInfo.baseBalance, spotPrice);
    totalPositionAbsoluteValue = totalPositionAbsoluteValue.add(positionValue.abs());
    totalPositionNetValue = totalPositionNetValue.add(positionValue);
  }

  const currentLeverage = preciseDiv(
    totalPositionAbsoluteValue,

    totalPositionNetValue
      .add(netQuoteBalance)
      .add(collateralBalance)
  );

  for (const positionInfo of allPositionInfo) {
    const basePositionUnit = preciseDiv(positionInfo.baseBalance, await setToken.totalSupply());
    const baseTradeQuantityNotional = preciseMul(basePositionUnit, setQuantity);
    const isLong = (basePositionUnit.gte(ZERO));

    const { deltaBase, deltaQuote } = await fixture.getSwapQuote(
      positionInfo.baseToken,
      baseTradeQuantityNotional.abs(),
      isLong
    );

    const idealQuote = preciseMul(deltaBase, await fixture.getSpotPrice(positionInfo.baseToken));

    const expectedSlippage = (isLong)
      ? idealQuote.sub(deltaQuote).mul(-1)
      : idealQuote.sub(deltaQuote);

    usdcAmountIn = usdcAmountIn.add(preciseDiv(idealQuote, currentLeverage).add(expectedSlippage));
  }

  return toUSDCDecimals(usdcAmountIn);
}

// Returns notional amount of USDC to transfer on redeem. Handles multiple positions, long and short
export async function calculateUSDCTransferOut(
  setToken: SetToken,
  setQuantity: BigNumber,
  module: PerpV2LeverageModule,
  fixture: PerpV2Fixture,
) {
  let totalRealizedPnl = BigNumber.from(0);

  const allPositionInfo = await module.getPositionNotionalInfo(setToken.address);
  const collateralBalance = (await module.getAccountInfo(setToken.address)).collateralBalance;

  const collateralPositionUnit = preciseDiv(collateralBalance, await setToken.totalSupply());
  const collateralQuantityNotional = preciseMul(collateralPositionUnit, setQuantity);

  for (const positionInfo of allPositionInfo) {
    const basePositionUnit = preciseDiv(positionInfo.baseBalance, await setToken.totalSupply());
    const baseTradeQuantityNotional = preciseMul(basePositionUnit, setQuantity);
    const isLong = (basePositionUnit.gte(ZERO));

    const closeRatio = preciseDiv(baseTradeQuantityNotional, positionInfo.baseBalance);
    const reducedOpenNotional = preciseMul(positionInfo.quoteBalance, closeRatio);

    const { deltaQuote } = await fixture.getSwapQuote(
      positionInfo.baseToken,
      baseTradeQuantityNotional.abs(),
      !isLong
    );

    const realizedPnl = (isLong)
      ? reducedOpenNotional.add(deltaQuote)
      : reducedOpenNotional.sub(deltaQuote);

    totalRealizedPnl = totalRealizedPnl.add(realizedPnl);
  }

  return toUSDCDecimals(collateralQuantityNotional.add(totalRealizedPnl).abs());
}
