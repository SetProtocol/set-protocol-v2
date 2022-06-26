import { ethers, network } from "hardhat";
import { BigNumber, Signer } from "ethers";
import { INotionalV2Complete, IWrappedfCashComplete, IWrappedfCashFactory } from "@utils/contracts";
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/dist/src/signer-with-address";
import { IERC20 } from "@typechain/IERC20";
import { ICErc20 } from "@typechain/ICErc20";
import { ICEth } from "@typechain/ICEth";

const NEW_ROUTER_ADDRESS = "0x16eD130F7A6dcAc7e3B0617A7bafa4b470189962";
export const NOTIONAL_PROXY_ADDRESS = "0x1344A36A1B56144C3Bc62E7757377D288fDE0369";

const cEthAddress = "0x4Ddc2D193948926D02f9B1fE9e1daa0718270ED5";

async function impersonateAccount(address: string) {
  await network.provider.request({
    method: "hardhat_impersonateAccount",
    params: [address],
  });
  return ethers.provider.getSigner(address);
}

export async function upgradeNotionalProxy(signer: Signer) {
  // This is the notional contract w/ notional abi
  const notional = (await ethers.getContractAt(
    "INotionalV2Complete",
    NOTIONAL_PROXY_ADDRESS,
  )) as INotionalV2Complete;

  const notionalOwner = await impersonateAccount(await notional.owner());

  const fundingValue = ethers.utils.parseEther("10");
  await signer.sendTransaction({ to: await notionalOwner.getAddress(), value: fundingValue });

  await notional.connect(notionalOwner).upgradeTo(NEW_ROUTER_ADDRESS);
  await notional
    .connect(notionalOwner)
    .updateAssetRate(1, "0x8E3D447eBE244db6D28E2303bCa86Ef3033CFAd6");
  await notional
    .connect(notionalOwner)
    .updateAssetRate(2, "0x719993E82974f5b5eA0c5ebA25c260CD5AF78E00");
  await notional
    .connect(notionalOwner)
    .updateAssetRate(3, "0x612741825ACedC6F88D8709319fe65bCB015C693");
  await notional
    .connect(notionalOwner)
    .updateAssetRate(4, "0x39D9590721331B13C8e9A42941a2B961B513E69d");
}

export async function getCurrencyIdAndMaturity(underlyingAddress: string, maturityIndex: number) {
  const notionalProxy = (await ethers.getContractAt(
    "INotionalV2Complete",
    NOTIONAL_PROXY_ADDRESS,
  )) as INotionalV2Complete;
  const currencyId = await notionalProxy.getCurrencyId(underlyingAddress);
  const activeMarkets = await notionalProxy.getActiveMarkets(currencyId);
  const maturity = activeMarkets[maturityIndex].maturity;
  return { currencyId, maturity };
}

export async function deployWrappedfCashInstance(
  wrappedfCashFactory: IWrappedfCashFactory,
  currencyId: number,
  maturity: BigNumber,
) {
  const wrappeFCashAddress = await wrappedfCashFactory.callStatic.deployWrapper(
    currencyId,
    maturity,
  );
  await wrappedfCashFactory.deployWrapper(currencyId, maturity);
  const wrappedFCashInstance = (await ethers.getContractAt(
    "IWrappedfCashComplete",
    wrappeFCashAddress,
  )) as IWrappedfCashComplete;
  return wrappedFCashInstance;
}


export async function mintWrappedFCash(
  signer: SignerWithAddress,
  underlyingToken: IERC20,
  underlyingTokenAmount: BigNumber,
  fCashAmount: BigNumber,
  assetToken: ICErc20 | ICEth,
  wrappedFCashInstance: IWrappedfCashComplete,
  useUnderlying: boolean = false,
  receiver: string | undefined = undefined,
  minImpliedRate: number | BigNumber = 0,
) {
  let inputToken: IERC20;
  let depositAmountExternal: BigNumber;
  receiver = receiver ?? signer.address;

  if (useUnderlying) {
    inputToken = underlyingToken;
    depositAmountExternal = underlyingTokenAmount;
  } else {
    const assetTokenBalanceBefore = await assetToken.balanceOf(signer.address);
    if (assetToken.address == cEthAddress) {
      assetToken = assetToken as ICEth;
      await assetToken.connect(signer).mint({ value: underlyingTokenAmount });
    } else {
      assetToken = assetToken as ICErc20;
      await underlyingToken.connect(signer).approve(assetToken.address, underlyingTokenAmount);
      await assetToken.connect(signer).mint(underlyingTokenAmount);
    }
    const assetTokenBalanceAfter = await assetToken.balanceOf(signer.address);
    depositAmountExternal = assetTokenBalanceAfter.sub(assetTokenBalanceBefore);
    inputToken = assetToken;
  }

  await inputToken.connect(signer).approve(wrappedFCashInstance.address, depositAmountExternal);
  const inputTokenBalanceBefore = await inputToken.balanceOf(signer.address);
  const wrappedFCashBalanceBefore = await wrappedFCashInstance.balanceOf(signer.address);
  let txReceipt;
  if (useUnderlying) {
    txReceipt = await wrappedFCashInstance
      .connect(signer)
      .mintViaUnderlying(depositAmountExternal, fCashAmount, receiver, minImpliedRate);
  } else {
    txReceipt = await wrappedFCashInstance
      .connect(signer)
      .mintViaAsset(depositAmountExternal, fCashAmount, receiver, minImpliedRate);
  }
  const wrappedFCashBalanceAfter = await wrappedFCashInstance.balanceOf(signer.address);
  const inputTokenBalanceAfter = await inputToken.balanceOf(signer.address);
  const inputTokenSpent = inputTokenBalanceAfter.sub(inputTokenBalanceBefore);
  const wrappedFCashReceived = wrappedFCashBalanceAfter.sub(wrappedFCashBalanceBefore);
  return {
    wrappedFCashReceived,
    depositAmountExternal,
    inputTokenSpent,
    txReceipt,
    inputToken,
  };
}
