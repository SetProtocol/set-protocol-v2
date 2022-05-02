import "module-alias/register";

import { BigNumber } from "ethers";
import { ethers, network } from "hardhat";
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
            let receiveToken: IERC20;
            let sendToken: IERC20;
            let subjectSetToken: string;
            let subjectSendToken: string;
            let subjectSendQuantity: BigNumber;
            let subjectReceiveToken: string;
            let subjectMinReceiveQuantity: BigNumber;
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
                  subjectReceiveToken,
                  subjectMinReceiveQuantity,
                );
            };

            const subjectCall = () => {
              return notionalTradeModule
                .connect(caller)
                .callStatic.trade(
                  subjectSetToken,
                  subjectSendToken,
                  subjectSendQuantity,
                  subjectReceiveToken,
                  subjectMinReceiveQuantity,
                );
            };

            ["buying", "selling"].forEach(tradeDirection => {
              ["underlyingToken", "assetToken"].forEach(tokenType => {
                describe(`When ${tradeDirection} fCash for ${tokenType}`, () => {
                  let sendTokenType: string;
                  let receiveTokenType: string;
                  let otherToken: IERC20;
                  beforeEach(async () => {
                    const underlyingTokenQuantity = ethers.utils.parseEther("1");
                    const assetToken = cDai;
                    const underlyingToken = dai;
                    const fTokenQuantity = ethers.utils.parseUnits("1", 8);

                    otherToken = tokenType == "assetToken" ? cDai : dai;
                    sendToken = tradeDirection == "buying" ? otherToken : wrappedFCashInstance;
                    sendTokenType = tradeDirection == "buying" ? tokenType : "wrappedFCash";
                    receiveTokenType = tradeDirection == "selling" ? tokenType : "wrappedFCash";
                    subjectSendToken = sendToken.address;

                    receiveToken = tradeDirection == "buying" ? wrappedFCashInstance : otherToken;
                    subjectReceiveToken = receiveToken.address;

                    if (tradeDirection == "buying") {
                      subjectMinReceiveQuantity = fTokenQuantity;
                      if (sendTokenType == "assetToken") {
                        const assetTokenBalanceBefore = await otherToken.balanceOf(owner.address);
                        await underlyingToken
                          .connect(owner.wallet)
                          .approve(assetToken.address, underlyingTokenQuantity);
                        await assetToken.connect(owner.wallet).mint(underlyingTokenQuantity);
                        const assetTokenBalanceAfter = await otherToken.balanceOf(owner.address);
                        subjectSendQuantity = assetTokenBalanceAfter.sub(assetTokenBalanceBefore);
                      } else {
                        subjectSendQuantity = underlyingTokenQuantity;
                      }
                      // Apparently it is not possible to trade tokens that are not a set component
                      // Also sending extra tokens to the trade module might break it
                      // TODO: Review
                      await notionalTradeModule
                        .connect(manager.wallet)
                        .trade(
                          setToken.address,
                          wrappedFCashInstance.address,
                          fTokenQuantity.mul(2),
                          sendToken.address,
                          subjectSendQuantity
                        );
                    } else {
                      subjectSendQuantity = fTokenQuantity;
                      if (tokenType == "assetToken") {
                        subjectMinReceiveQuantity = ethers.utils.parseUnits("0.4", 8);
                      } else {
                        subjectMinReceiveQuantity = ethers.utils.parseEther("0.9");
                      }
                    }
                  });

                  it("setToken should receive receiver token", async () => {
                    const receiveTokenBalanceBefore = await receiveToken.balanceOf(
                      setToken.address,
                    );
                    await subject();
                    const receiveTokenBalanceAfter = await receiveToken.balanceOf(setToken.address);
                    expect(receiveTokenBalanceAfter.sub(receiveTokenBalanceBefore)).to.be.gte(
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

                  it("should return spent / received amount of non-fcash-token", async () => {
                    const otherTokenBalanceBefore = await otherToken.balanceOf(setToken.address);
                    const result = await subjectCall();
                    await subject();
                    const otherTokenBalanceAfter = await otherToken.balanceOf(setToken.address);

                    let expectedResult;
                    if (tradeDirection == "selling") {
                      expectedResult = otherTokenBalanceAfter.sub(otherTokenBalanceBefore);
                    } else {
                      expectedResult = otherTokenBalanceBefore.sub(otherTokenBalanceAfter);
                    }

                    // TODO: Review why there is some deviation
                    const allowedDeviationPercent = 1;
                    expect(result).to.be.gte(
                      expectedResult.mul(100 - allowedDeviationPercent).div(100),
                    );
                    expect(result).to.be.lte(
                      expectedResult.mul(100 + allowedDeviationPercent).div(100),
                    );
                  });

                  it("should adjust the components position of the receiveToken correctly", async () => {
                    const positionBefore = await setToken.getDefaultPositionRealUnit(
                      receiveToken.address,
                    );
                    const tradeAmount = await subjectCall();
                    const receiveTokenAmount =
                      tradeDirection == "buying" ? subjectMinReceiveQuantity : tradeAmount;
                    await subject();
                    const positionAfter = await setToken.getDefaultPositionRealUnit(
                      receiveToken.address,
                    );

                    const positionChange = positionAfter.sub(positionBefore);
                    const totalSetSupplyWei = await setToken.totalSupply();
                    const totalSetSupplyEther = totalSetSupplyWei.div(BigNumber.from(10).pow(18));

                    let receiveTokenAmountNormalized;
                    if (receiveTokenType == "underlyingToken") {
                      receiveTokenAmountNormalized = receiveTokenAmount.div(totalSetSupplyEther);
                    } else {
                      receiveTokenAmountNormalized = BigNumber.from(
                        Math.floor(
                          receiveTokenAmount.mul(10).div(totalSetSupplyEther).toNumber() / 10,
                        ),
                      );
                    }

                    if (receiveTokenType == "underlyingToken") {
                      // TODO: Review why there is some deviation
                      const allowedDeviationPercent = 1;
                      expect(receiveTokenAmountNormalized).to.be.gte(
                        positionChange.mul(100 - allowedDeviationPercent).div(100),
                      );
                      expect(receiveTokenAmountNormalized).to.be.lte(
                        positionChange.mul(100 + allowedDeviationPercent).div(100),
                      );
                    } else {
                      expect(receiveTokenAmountNormalized).to.eq(positionChange);
                    }
                  });

                  it("should adjust the components position of the sendToken correctly", async () => {
                    const positionBefore = await setToken.getDefaultPositionRealUnit(
                      sendToken.address,
                    );
                    const tradeAmount = await subjectCall();
                    const sendTokenAmount =
                      tradeDirection == "selling" ? subjectSendQuantity : tradeAmount;
                    await subject();
                    const positionAfter = await setToken.getDefaultPositionRealUnit(
                      sendToken.address,
                    );

                    const positionChange = positionBefore.sub(positionAfter);
                    const totalSetSupplyWei = await setToken.totalSupply();
                    const totalSetSupplyEther = totalSetSupplyWei.div(BigNumber.from(10).pow(18));

                    let sendTokenAmountNormalized;
                    if (sendTokenType == "underlyingToken") {
                      sendTokenAmountNormalized = sendTokenAmount.div(totalSetSupplyEther);
                    } else {
                      sendTokenAmountNormalized = BigNumber.from(
                        // TODO: Why do we have to use round here and floor with the receive token ?
                        Math.round(
                          sendTokenAmount.mul(10).div(totalSetSupplyEther).toNumber() / 10,
                        ),
                      );
                    }

                    expect(sendTokenAmountNormalized).to.eq(positionChange);
                  });

                  if (tradeDirection == "buying") {
                    describe("When sendQuantity is too low", () => {
                      beforeEach(() => {
                        subjectSendQuantity = BigNumber.from(1000);
                      });
                      it("should revert", async () => {
                        const revertReason =
                          sendTokenType == "underlyingToken" ? "Dai/insufficient-balance" : "ERC20";
                        await expect(subject()).to.be.revertedWith(revertReason);
                      });
                    });
                  }
                });
              });
            });

            describe("#moduleIssue/RedeemHook", () => {
              ["issue", "redeem", "manualTrigger"].forEach(triggerAction => {
                describe(`When hook is triggered by ${triggerAction}`, () => {
                  let subjectSetToken: string;
                  let subjectReceiver: string;
                  let subjectAmount: BigNumber;
                  let caller: SignerWithAddress;
                  beforeEach(async () => {
                    subjectSetToken = setToken.address;
                    subjectAmount = ethers.utils.parseEther("1");
                    caller = owner.wallet;
                    subjectReceiver = caller.address;

                    if (triggerAction == "redeem") {
                      const daiAmount = ethers.utils.parseEther("2.1");
                      const fCashAmount = ethers.utils.parseUnits("2", 8);
                      await mintWrappedFCash(
                        owner.wallet,
                        dai,
                        daiAmount,
                        fCashAmount,
                        cDai,
                        wrappedFCashInstance,
                        true,
                      );
                      await debtIssuanceModule
                        .connect(owner.wallet)
                        .issue(subjectSetToken, subjectAmount, caller.address);
                      await setToken
                        .connect(caller)
                        .approve(debtIssuanceModule.address, subjectAmount);
                    } else {
                      await dai.transfer(caller.address, daiAmount);
                      await dai.connect(caller).approve(cDai.address, ethers.constants.MaxUint256);
                      await cDai.connect(caller).mint(daiAmount);
                      await cDai
                        .connect(caller)
                        .approve(debtIssuanceModule.address, ethers.constants.MaxUint256);
                    }
                  });

                  const subject = () => {
                    if (triggerAction == "issue") {
                      return debtIssuanceModule
                        .connect(caller)
                        .issue(subjectSetToken, subjectAmount, subjectReceiver);
                    } else if (triggerAction == "redeem") {
                      return debtIssuanceModule
                        .connect(caller)
                        .redeem(subjectSetToken, subjectAmount, subjectReceiver);
                    } else {
                      return notionalTradeModule
                        .connect(caller)
                        .redeemMaturedPositions(subjectSetToken);
                    }
                  };

                  describe("When component has not matured yet", () => {
                    beforeEach(async () => {
                      if (triggerAction == "issue") {
                        const daiAmount = ethers.utils.parseEther("2.1");
                        const fCashAmount = ethers.utils.parseUnits("2", 8);
                        await mintWrappedFCash(
                          caller,
                          dai,
                          daiAmount,
                          fCashAmount,
                          cDai,
                          wrappedFCashInstance,
                          true,
                        );
                        await wrappedFCashInstance
                          .connect(caller)
                          .approve(debtIssuanceModule.address, fCashAmount);
                      }
                      expect(await wrappedFCashInstance.hasMatured()).to.be.false;
                    });
                    it("fCash position remains the same", async () => {
                      const positionBefore = await setToken.getDefaultPositionRealUnit(
                        wrappedFCashInstance.address,
                      );
                      await subject();
                      const positionAfter = await setToken.getDefaultPositionRealUnit(
                        wrappedFCashInstance.address,
                      );
                      expect(positionAfter).to.eq(positionBefore);
                    });
                  });

                  describe("When component has matured", () => {
                    let snapshotId: string;
                    beforeEach(async () => {
                      snapshotId = await network.provider.send("evm_snapshot", []);
                      const maturity = await wrappedFCashInstance.getMaturity();
                      await network.provider.send("evm_setNextBlockTimestamp", [maturity + 1]);
                      await network.provider.send("evm_mine");
                      expect(await wrappedFCashInstance.hasMatured()).to.be.true;
                    });
                    afterEach(async () => {
                      await network.provider.send("evm_revert", [snapshotId]);
                    });

                    if (triggerAction != "manualTrigger") {
                      it("should adjust assetToken balance correctly", async () => {
                        const minAmountCDaiTransfered = ethers.utils.parseUnits("90", 8);
                        const cDaiBalanceBefore = await cDai.balanceOf(caller.address);
                        await subject();
                        const cDaiBalanceAfter = await cDai.balanceOf(caller.address);
                        const amountCDaiTransfered =
                          triggerAction == "redeem"
                            ? cDaiBalanceAfter.sub(cDaiBalanceBefore)
                            : cDaiBalanceBefore.sub(cDaiBalanceAfter);

                        expect(amountCDaiTransfered).to.be.gte(minAmountCDaiTransfered);
                      });

                      it("should issue correct amount of set tokens", async () => {
                        const setTokenBalanceBefore = await setToken.balanceOf(caller.address);
                        await subject();
                        const setTokenBalanceAfter = await setToken.balanceOf(caller.address);
                        const expectedBalanceChange =
                          triggerAction == "issue" ? subjectAmount : subjectAmount.mul(-1);
                        expect(setTokenBalanceAfter.sub(setTokenBalanceBefore)).to.eq(
                          expectedBalanceChange,
                        );
                      });
                    }

                    it("Removes wrappedFCash from component list", async () => {
                      expect(await setToken.isComponent(wrappedFCashInstance.address)).to.be.true;
                      await subject();
                      expect(await setToken.isComponent(wrappedFCashInstance.address)).to.be.false;
                    });

                    it("Adds assetToken (cDai) to component list", async () => {
                      expect(await setToken.isComponent(cDai.address)).to.be.false;
                      await subject();
                      expect(await setToken.isComponent(cDai.address)).to.be.true;
                    });

                    it("Adds asset token to component list", async () => {
                      expect(await setToken.isComponent(cDai.address)).to.be.false;
                      await subject();
                      expect(await setToken.isComponent(cDai.address)).to.be.true;
                    });

                    it("Afterwards setToken should have no fCash balance anymore", async () => {
                      const balanceBefore = await wrappedFCashInstance.balanceOf(subjectSetToken);
                      expect(balanceBefore).to.be.gt(0);
                      await subject();
                      const balanceAfter = await wrappedFCashInstance.balanceOf(subjectSetToken);
                      expect(balanceAfter).to.eq(0);
                    });

                    it("Afterwards setToken should have received asset token", async () => {
                      const balanceBefore = await cDai.balanceOf(subjectSetToken);
                      await subject();
                      const balanceAfter = await cDai.balanceOf(subjectSetToken);
                      expect(balanceAfter.sub(balanceBefore)).to.be.gt(0);
                    });

                    it("Afterwards setToken should have positive cDai position", async () => {
                      const positionBefore = await setToken.getDefaultPositionRealUnit(
                        cDai.address,
                      );
                      await subject();
                      const positionAfter = await setToken.getDefaultPositionRealUnit(cDai.address);
                      expect(positionAfter.sub(positionBefore)).to.be.gt(0);
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
});
