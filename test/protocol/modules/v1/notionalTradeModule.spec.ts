import "module-alias/register";
import { BigNumber } from "ethers";
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/dist/src/signer-with-address";
import { ethers } from "hardhat";
import { Address } from "@utils/types";
import { Account } from "@utils/test/types";
import {
  ManagerIssuanceHookMock,
  NotionalTradeModule,
  DebtIssuanceModule,
  SetToken,
  StandardTokenMock,
  WrappedfCashMock,
} from "@utils/contracts";
import DeployHelper from "@utils/deploys";
import { ether } from "@utils/index";
import {
  getAccounts,
  getCompoundFixture,
  getRandomAccount,
  getRandomAddress,
  getSystemFixture,
  getWaffleExpect,
} from "@utils/test/index";
import { CompoundFixture, SystemFixture } from "@utils/fixtures";
import { CERc20 } from "@utils/contracts/compound";
import { IERC20 } from "@typechain/IERC20";

const expect = getWaffleExpect();

describe("NotionalTradeModule", () => {
  let owner: Account;
  let deployer: DeployHelper;
  let manager: Account;
  let setup: SystemFixture;

  let mockPreIssuanceHook: ManagerIssuanceHookMock;
  let debtIssuanceModule: DebtIssuanceModule;

  let compoundSetup: CompoundFixture;
  let cDai: CERc20;
  let dai: StandardTokenMock;
  let cTokenInitialMantissa: BigNumber;

  beforeEach(async () => {
    [owner, manager] = await getAccounts();

    deployer = new DeployHelper(owner.wallet);

    setup = getSystemFixture(owner.address);
    await setup.initialize();

    compoundSetup = getCompoundFixture(owner.address);
    await compoundSetup.initialize();
    cTokenInitialMantissa = ether(200000000);

    dai = setup.dai;
    cDai = await compoundSetup.createAndEnableCToken(
      setup.dai.address,
      cTokenInitialMantissa,
      compoundSetup.comptroller.address,
      compoundSetup.interestRateModel.address,
      "Compound Dai",
      "cDAI",
      8,
      ether(0.75), // 75% collateral factor
      ether(1),
    );
    await dai.approve(cDai.address, ethers.constants.MaxUint256);
    await cDai.mint(ether(100));
    mockPreIssuanceHook = await deployer.mocks.deployManagerIssuanceHookMock();
  });

  describe("#constructor", async () => {
    let subjectController: Address;

    beforeEach(async () => {
      subjectController = setup.controller.address;
    });

    async function subject(): Promise<NotionalTradeModule> {
      return deployer.modules.deployNotionalTradeModule(subjectController);
    }

    it("should set the correct controller", async () => {
      const notionalTradeModule = await subject();

      const controller = await notionalTradeModule.controller();
      expect(controller).to.eq(subjectController);
    });
  });

  describe("When notional module is deployed", async () => {
    let notionalTradeModule: NotionalTradeModule;
    beforeEach(async () => {
      notionalTradeModule = await deployer.modules.deployNotionalTradeModule(
        setup.controller.address,
      );
      await setup.controller.addModule(notionalTradeModule.address);

      debtIssuanceModule = await deployer.modules.deployDebtIssuanceModuleV2(
        setup.controller.address,
      );
      await setup.controller.addModule(debtIssuanceModule.address);
      await setup.integrationRegistry.addIntegration(
        notionalTradeModule.address,
        "DefaultIssuanceModule",
        debtIssuanceModule.address,
      );
    });

    describe("When wrappedFCashMock is deployed", async () => {
      let wrappedfCashMock: WrappedfCashMock;
      let daiBalance: BigNumber;
      beforeEach(async () => {
        wrappedfCashMock = await deployer.mocks.deployWrappedfCashMock(cDai.address, dai.address);

        daiBalance = ether(1000);
        dai.transfer(owner.address, daiBalance);
        dai.approve(wrappedfCashMock.address, daiBalance);

        wrappedfCashMock.mintViaUnderlying(daiBalance, daiBalance, owner.address, 0);
      });
      describe("When setToken is deployed", async () => {
        let wrappedfCashPosition: BigNumber;
        let initialSetBalance: BigNumber;
        let setToken: SetToken;
        beforeEach(async () => {
          wrappedfCashPosition = ethers.utils.parseUnits("2", await wrappedfCashMock.decimals());

          setToken = await setup.createSetToken(
            [wrappedfCashMock.address],
            [wrappedfCashPosition],
            [debtIssuanceModule.address, notionalTradeModule.address],
            manager.address,
          );

          expect(await setToken.isPendingModule(debtIssuanceModule.address)).to.be.true;

          // Initialize debIssuance module
          await debtIssuanceModule.connect(manager.wallet).initialize(
            setToken.address,
            ether(0.1),
            ether(0), // No issue fee
            ether(0), // No redeem fee
            owner.address,
            mockPreIssuanceHook.address,
          );

          initialSetBalance = daiBalance.div(10);
          await wrappedfCashMock.approve(debtIssuanceModule.address, daiBalance);
          await debtIssuanceModule.issue(setToken.address, initialSetBalance, owner.address);
        });

        describe("#initialize", async () => {
          let isAllowListed: boolean = true;
          let subjectSetToken: Address;
          let subjectFCashPositions: Address[];
          let subjectCaller: Account;

          beforeEach(async () => {
            if (isAllowListed) {
              // Add SetToken to allow list
              console.log("Updated allow list");
              await notionalTradeModule.updateAllowedSetToken(setToken.address, true);
            }

            subjectSetToken = setToken.address;
            subjectFCashPositions = [setup.weth.address, setup.dai.address];
            subjectCaller = manager;
            console.log("Done");
          });

          async function subject(): Promise<any> {
            return notionalTradeModule
              .connect(subjectCaller.wallet)
              .initialize(subjectSetToken, subjectFCashPositions);
          }

          describe("when isAllowListed is true", () => {
            before(async () => {
              isAllowListed = true;
            });

            it("should enable the Module on the SetToken", async () => {
              await subject();
              const isModuleEnabled = await setToken.isInitializedModule(
                notionalTradeModule.address,
              );
              expect(isModuleEnabled).to.eq(true);
            });

            describe("when debt issuance module is not added to integration registry", async () => {
              beforeEach(async () => {
                await setup.integrationRegistry.removeIntegration(
                  notionalTradeModule.address,
                  "DefaultIssuanceModule",
                );
              });

              afterEach(async () => {
                // Add debt issuance address to integration
                await setup.integrationRegistry.addIntegration(
                  notionalTradeModule.address,
                  "DefaultIssuanceModule",
                  debtIssuanceModule.address,
                );
              });

              it("should revert", async () => {
                await expect(subject()).to.be.revertedWith("Must be valid adapter");
              });
            });

            describe("when debt issuance module is not initialized on SetToken", async () => {
              beforeEach(async () => {
                await setToken.connect(manager.wallet).removeModule(debtIssuanceModule.address);
              });

              afterEach(async () => {
                await setToken.connect(manager.wallet).addModule(debtIssuanceModule.address);
                // Initialize debIssuance module
                await debtIssuanceModule.connect(manager.wallet).initialize(
                  setToken.address,
                  ether(0.1),
                  ether(0), // No issue fee
                  ether(0), // No redeem fee
                  owner.address,
                  mockPreIssuanceHook.address,
                );
              });

              it("should revert", async () => {
                await expect(subject()).to.be.revertedWith("Issuance not initialized");
              });
            });

            describe("when the caller is not the SetToken manager", async () => {
              beforeEach(async () => {
                subjectCaller = await getRandomAccount();
              });

              it("should revert", async () => {
                await expect(subject()).to.be.revertedWith("Must be the SetToken manager");
              });
            });

            describe("when SetToken is not in pending state", async () => {
              beforeEach(async () => {
                const newModule = await getRandomAddress();
                await setup.controller.addModule(newModule);

                const notionalTradeModuleNotPendingSetToken = await setup.createSetToken(
                  [setup.weth.address],
                  [ether(1)],
                  [newModule],
                  manager.address,
                );

                subjectSetToken = notionalTradeModuleNotPendingSetToken.address;
              });

              it("should revert", async () => {
                await expect(subject()).to.be.revertedWith("Must be pending initialization");
              });
            });

            describe("when the SetToken is not enabled on the controller", async () => {
              beforeEach(async () => {
                const nonEnabledSetToken = await setup.createNonControllerEnabledSetToken(
                  [setup.weth.address],
                  [ether(1)],
                  [notionalTradeModule.address],
                  manager.address,
                );

                subjectSetToken = nonEnabledSetToken.address;
              });

              it("should revert", async () => {
                await expect(subject()).to.be.revertedWith("Must be controller-enabled SetToken");
              });
            });
          });

          describe("when isAllowListed is false", async () => {
            before(async () => {
              isAllowListed = false;
            });

            describe("when SetToken is not allowlisted", async () => {
              it("should revert", async () => {
                await expect(subject()).to.be.revertedWith("Not allowed SetToken");
              });
            });

            describe("when any Set can initialize this module", async () => {
              beforeEach(async () => {
                await notionalTradeModule.updateAnySetAllowed(true);
              });

              it("should enable the Module on the SetToken", async () => {
                await subject();
                const isModuleEnabled = await setToken.isInitializedModule(
                  notionalTradeModule.address,
                );
                expect(isModuleEnabled).to.eq(true);
              });
            });
          });
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

          describe("when set token is allowed", () => {
            beforeEach(async () => {
              await notionalTradeModule.updateAllowedSetToken(setToken.address, true);
            });
            describe("when token is initialized on the notional module", () => {
              beforeEach(async () => {
                await notionalTradeModule
                  .connect(manager.wallet)
                  .initialize(setToken.address, [wrappedfCashMock.address]);
              });

              [
                "buying",
                "selling",
              ].forEach(tradeDirection => {
                [
                  "underlyingToken",
                  "assetToken",
                ].forEach(tokenType => {
                  describe(`When ${tradeDirection} fCash for ${tokenType}`, () => {
                    let sendTokenType: string;
                    let receiveTokenType: string;
                    let otherToken: IERC20;
                    beforeEach(async () => {
                      const fTokenQuantity = ethers.utils.parseUnits("1", 8);

                      otherToken = tokenType == "assetToken" ? cDai : dai;
                      sendToken = tradeDirection == "buying" ? otherToken : wrappedfCashMock;
                      sendTokenType = tradeDirection == "buying" ? tokenType : "wrappedFCash";
                      receiveTokenType = tradeDirection == "selling" ? tokenType : "wrappedFCash";
                      subjectSendToken = sendToken.address;

                      receiveToken = tradeDirection == "buying" ? wrappedfCashMock : otherToken;
                      subjectReceiveToken = receiveToken.address;

                      subjectMinReceiveQuantity = fTokenQuantity;
                      subjectSendQuantity = fTokenQuantity;
                      if (tradeDirection == "buying") {
                        // Apparently it is not possible to trade tokens that are not a set component
                        // Also sending extra tokens to the trade module might break it
                        // TODO: Review
                        await sendToken.transfer(wrappedfCashMock.address, subjectSendQuantity);
                        await notionalTradeModule
                          .connect(manager.wallet)
                          .trade(
                            setToken.address,
                            wrappedfCashMock.address,
                            fTokenQuantity,
                            sendToken.address,
                            subjectSendQuantity,
                          );
                      }
                      if (tradeDirection == "selling") {
                        await receiveToken.transfer(
                          wrappedfCashMock.address,
                          subjectMinReceiveQuantity,
                        );
                        console.log(
                          "Sent receive tokens to mock",
                          receiveToken.address,
                          await receiveToken.balanceOf(wrappedfCashMock.address),
                        );
                      }
                    });

                    it("setToken should receive receiver token", async () => {
                      const receiveTokenBalanceBefore = await receiveToken.balanceOf(
                        setToken.address,
                      );
                      await subject();
                      const receiveTokenBalanceAfter = await receiveToken.balanceOf(
                        setToken.address,
                      );
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

                      expect(sendTokenAmountNormalized).to.closeTo(
                        positionChange,
                        positionChange.div(10 ** 6).toNumber(),
                      );
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
