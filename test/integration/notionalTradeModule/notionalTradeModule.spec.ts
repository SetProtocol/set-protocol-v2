import "module-alias/register";

import { BigNumber } from "ethers";
import { ethers } from "hardhat";
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/dist/src/signer-with-address";

import { Account, ForkedTokens } from "@utils/test/types";
import DeployHelper from "@utils/deploys";
import { ether } from "@utils/index";
import {
  getAccounts,
  getForkedTokens,
  getSystemFixture,
  getWaffleExpect,
  initializeForkedTokens,
} from "@utils/test/index";

import { SystemFixture } from "@utils/fixtures";
import {
  SetToken,
  DebtIssuanceModuleV2,
  ManagerIssuanceHookMock,
  NotionalTradeModule,
  WrappedfCash,
} from "@utils/contracts";

import { IERC20 } from "@typechain/IERC20";
import { ICErc20 } from "@typechain/ICErc20";
import { upgradeNotionalProxy, deployWrappedfCashInstance, mintWrappedFCash } from "./utils";

const expect = getWaffleExpect();

describe("Notional trade module integration [ @forked-mainnet ]", () => {
  const cdaiAddress = "0x5d3a536E4D6DbD6114cc1Ead35777bAB948E3643";
  let owner: Account;
  let manager: Account;
  let tokens: ForkedTokens;
  let dai: IERC20;
  let cDai: ICErc20;
  let deployer: DeployHelper;
  let setup: SystemFixture;

  beforeEach(async () => {
    [owner, manager] = await getAccounts();
    deployer = new DeployHelper(owner.wallet);
    setup = getSystemFixture(owner.address);
    await setup.initialize();

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
      beforeEach(async () => {
        await upgradeNotionalProxy(owner.wallet);
        daiAmount = ethers.utils.parseEther("1");
        fCashAmount = ethers.utils.parseUnits("1", 8);
        await dai.transfer(owner.address, daiAmount);
      });

      describe("When setToken with wrappedFCash component is deployed", () => {
        let debtIssuanceModule: DebtIssuanceModuleV2;
        let mockPreIssuanceHook: ManagerIssuanceHookMock;
        let notionalTradeModule: NotionalTradeModule;
        let setToken: SetToken;
        let wrappedFCashPosition: BigNumber;

        beforeEach(async () => {
          // Deploy DebtIssuanceModuleV2
          debtIssuanceModule = await deployer.modules.deployDebtIssuanceModuleV2(
            setup.controller.address,
          );
          await setup.controller.addModule(debtIssuanceModule.address);

          // Deploy NotionalTradeModule
          notionalTradeModule = await deployer.modules.deployNotionalTradeModule(
            setup.controller.address,
          );
          await setup.controller.addModule(notionalTradeModule.address);

          // Deploy mock issuance hook to pass as arg in DebtIssuance module initialization
          mockPreIssuanceHook = await deployer.mocks.deployManagerIssuanceHookMock();

          wrappedFCashPosition = ethers.utils.parseUnits(
            "2",
            await wrappedFCashInstance.decimals(),
          );

          await initialize();
        });

        async function initialize() {
          // Create Set token
          setToken = await setup.createSetToken(
            [wrappedFCashInstance.address],
            [wrappedFCashPosition],
            [debtIssuanceModule.address, notionalTradeModule.address],
            manager.address,
          );

          // Fund owner with stETH
          await tokens.steth.transfer(owner.address, ether(11000));

          // Initialize debIssuance module
          await debtIssuanceModule.connect(manager.wallet).initialize(
            setToken.address,
            ether(0.1),
            ether(0), // No issue fee
            ether(0), // No redeem fee
            owner.address,
            mockPreIssuanceHook.address,
          );

          await setup.integrationRegistry.addIntegration(
            notionalTradeModule.address,
            "DefaultIssuanceModule",
            debtIssuanceModule.address,
          );
          await notionalTradeModule.updateAllowedSetToken(setToken.address, true);
          await notionalTradeModule
            .connect(manager.wallet)
            .initialize(setToken.address, [wrappedFCashInstance.address]);
        }

        it("Should be able to issue set from wrappedFCash", async () => {
          daiAmount = ethers.utils.parseEther("10");
          fCashAmount = ethers.utils.parseUnits("9", 8);
          const setAmount = ethers.utils.parseEther("1");
          await dai.transfer(owner.address, daiAmount);

          await mintWrappedFCash(
            owner.wallet,
            dai,
            daiAmount,
            fCashAmount,
            cDai,
            wrappedFCashInstance,
            true,
          );

          await wrappedFCashInstance
            .connect(owner.wallet)
            .approve(debtIssuanceModule.address, ethers.constants.MaxUint256);
          await wrappedFCashInstance
            .connect(owner.wallet)
            .approve(setToken.address, ethers.constants.MaxUint256);

          const setBalanceBefore = await setToken.balanceOf(owner.address);
          await debtIssuanceModule
            .connect(owner.wallet)
            .issue(setToken.address, setAmount, owner.address);
          const setBalanceAfter = await setToken.balanceOf(owner.address);

          expect(setBalanceAfter.sub(setBalanceBefore)).to.eq(setAmount);
        });
        describe("When initial amount of set token has been issued", () => {
          beforeEach(async () => {
            daiAmount = ethers.utils.parseEther("2000");
            fCashAmount = ethers.utils.parseUnits("2000", 8);
            const setAmount = ethers.utils.parseEther("1000");
            await dai.transfer(owner.address, daiAmount);

            await mintWrappedFCash(
              owner.wallet,
              dai,
              daiAmount,
              fCashAmount,
              cDai,
              wrappedFCashInstance,
              true,
            );

            await wrappedFCashInstance
              .connect(owner.wallet)
              .approve(debtIssuanceModule.address, ethers.constants.MaxUint256);
            await wrappedFCashInstance
              .connect(owner.wallet)
              .approve(setToken.address, ethers.constants.MaxUint256);

            await debtIssuanceModule
              .connect(owner.wallet)
              .issue(setToken.address, setAmount, owner.address);
          });
          describe("#trade", () => {
            let receiverToken: IERC20;
            let sendToken: IERC20;
            let subjectSetToken: string;
            let subjectSendToken: string;
            let subjectSendQuantity: BigNumber;
            let subjectReceiverToken: string;
            let subjectMinReceiveQuantity: BigNumber;
            let subjectUseUnderlying: boolean;
            let caller: SignerWithAddress;

            beforeEach(async () => {
              subjectSetToken = setToken.address;
              caller = manager.wallet;
            });

            const subject = () => {
              return notionalTradeModule
                .connect(caller)
                .trade(
                  subjectSetToken,
                  subjectSendToken,
                  subjectSendQuantity,
                  subjectReceiverToken,
                  subjectMinReceiveQuantity,
                  subjectUseUnderlying,
                );
            };

            ["buying"].forEach(tradeDirection => {
              ["underlyingToken", "assetToken"].forEach(tokenType => {
                describe(`When ${tradeDirection} fCash for ${tokenType}`, () => {
                  beforeEach(async () => {
                    const underlyingTokenQuantity = ethers.utils.parseEther("1");
                    const assetToken = cDai;
                    const underlyingToken = dai;
                    const otherToken = tokenType == "assetToken" ? cDai : dai;
                    subjectUseUnderlying = tokenType == "underlyingToken";
                    subjectMinReceiveQuantity = ethers.utils.parseUnits("0.1", 8);

                    sendToken = tradeDirection == "buying" ? otherToken : wrappedFCashInstance;
                    const sendTokenType = tradeDirection == "buying" ? tokenType : "wrappedFCash";
                    subjectSendToken = sendToken.address;

                    receiverToken = tradeDirection == "buying" ? wrappedFCashInstance : otherToken;
                    subjectReceiverToken = receiverToken.address;

                    if (tradeDirection == "buying") {
                      if (sendTokenType == "assetToken") {
                        const assetTokenBalanceBefore = await otherToken.balanceOf(owner.address);
                        await underlyingToken
                          .connect(owner.wallet)
                          .approve(assetToken.address, underlyingTokenQuantity);
                        await assetToken.connect(owner.wallet).mint(underlyingTokenQuantity);
                        const assetTokenBalanceAfter = await otherToken.balanceOf(owner.address);
                        subjectSendQuantity = assetTokenBalanceAfter.sub(assetTokenBalanceBefore);
                      } else {
                        subjectSendQuantity = underlyingTokenQuantity.mul(2);
                      }
                      console.log("Sending send token to setToken");
                      await sendToken
                        .connect(owner.wallet)
                        .transfer(setToken.address, subjectSendQuantity);
                      console.log("Done");
                      const sendTokenBalance = await sendToken.balanceOf(setToken.address);
                      console.log(
                        "sendTokenBalance",
                        sendTokenBalance.toString(),
                        sendToken.address,
                      );
                    }
                  });

                  it("should not revert", async () => {
                    await subject();
                  });

                  it("setToken should receive receiver token", async () => {
                    const receiverTokenBalanceBefore = await receiverToken.balanceOf(
                      setToken.address,
                    );
                    await subject();
                    const receiverTokenBalanceAfter = await receiverToken.balanceOf(
                      setToken.address,
                    );
                    expect(receiverTokenBalanceAfter.sub(receiverTokenBalanceBefore)).to.be.gte(
                      subjectMinReceiveQuantity,
                    );
                  });

                  it("setTokens sendToken balance should be adjusted accordingly", async () => {
                    const sendTokenBalanceBefore = await sendToken.balanceOf(setToken.address);
                    await subject();
                    const sendTokenBalanceAfter = await sendToken.balanceOf(setToken.address);
                    if (tradeDirection == "selling") {
                      expect(sendTokenBalanceBefore.sub(sendTokenBalanceAfter)).to.eq(
                        subjectSendQuantity,
                      );
                    } else {
                      expect(sendTokenBalanceBefore.sub(sendTokenBalanceAfter)).to.be.lte(
                        subjectSendQuantity,
                      );
                    }
                  });
                });
              });
            });
          });
        });
      });
    });
  });
});
