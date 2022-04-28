import "module-alias/register";

import { BigNumber } from "ethers";
import { ethers } from "hardhat";

import { Account, ForkedTokens } from "@utils/test/types";
import DeployHelper from "@utils/deploys";
import {
  getAccounts,
  getForkedTokens,
  getWaffleExpect,
  initializeForkedTokens,
} from "@utils/test/index";

import { WrappedfCash } from "@utils/contracts";
import { IERC20 } from "@typechain/IERC20";
import { ICErc20 } from "@typechain/ICErc20";

import { upgradeNotionalProxy, deployWrappedfCashInstance, mintWrappedFCash } from "./utils";

const expect = getWaffleExpect();

describe("Notional trade module integration [ @forked-mainnet ]", () => {
  const cdaiAddress = "0x5d3a536E4D6DbD6114cc1Ead35777bAB948E3643";
  let owner: Account;
  let tokens: ForkedTokens;
  let dai: IERC20;
  let cDai: ICErc20;
  let deployer: DeployHelper;

  beforeEach(async () => {
    [owner] = await getAccounts();
    deployer = new DeployHelper(owner.wallet);
    // Setup ForkedTokens
    await initializeForkedTokens(deployer);
    tokens = getForkedTokens();
    dai = tokens.dai;
    cDai = (await ethers.getContractAt("ICErc20", cdaiAddress)) as ICErc20;
  });

  describe("When WrappedfCash is deployed", () => {
    let wrappedFCashInstance: WrappedfCash;
    beforeEach(async () => {
      wrappedFCashInstance = await deployWrappedfCashInstance(deployer, owner.wallet, cdaiAddress);
    });

    describe("When notional proxy is upgraded", () => {
      let daiAmount: BigNumber;
      let fCashAmount: BigNumber;
      let receiver: string;
      beforeEach(async () => {
        await upgradeNotionalProxy(owner.wallet);
        daiAmount = ethers.utils.parseEther("1");
        fCashAmount = ethers.utils.parseUnits("1", 8);
        receiver = owner.address;
        await dai.transfer(owner.address, daiAmount);
      });

      [true, false].forEach(useUnderlying => {
        describe(`when ${useUnderlying ? "" : "not"} using underlying`, () => {
          it("mint works", async () => {
            const {
              wrappedFCashReceived,
              depositAmountExternal,
              inputTokenSpent,
            } = await mintWrappedFCash(
              owner.wallet,
              dai,
              daiAmount,
              fCashAmount,
              cDai,
              wrappedFCashInstance,
              useUnderlying,
            );
            expect(wrappedFCashReceived).to.eq(fCashAmount);
            expect(inputTokenSpent).to.be.lte(depositAmountExternal);
          });

          it("redeem works", async () => {
            const {
              wrappedFCashReceived,
            } = await mintWrappedFCash(
              owner.wallet,
              dai,
              daiAmount,
              fCashAmount,
              cDai,
              wrappedFCashInstance,
              useUnderlying,
            );
            const maxImpliedRate = BigNumber.from(2).pow(32).sub(1);
            if (useUnderlying) {
              await wrappedFCashInstance
                .connect(owner.wallet)
                .redeemToUnderlying(wrappedFCashReceived, receiver, maxImpliedRate);
            } else {
              await wrappedFCashInstance
                .connect(owner.wallet)
                .redeemToAsset(wrappedFCashReceived, receiver, maxImpliedRate);
            }
          });
        });
      });
    });
  });
});
