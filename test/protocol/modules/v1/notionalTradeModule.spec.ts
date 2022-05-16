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
  DebtIssuanceMock,
  SetToken,
  StandardTokenMock,
  WrappedfCashMock,
  WrappedfCashFactoryMock,
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
import { mintWrappedFCash } from "../../../integration/notionalTradeModule/utils";

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

  describe("when factory mock is deployed", async () => {
    let wrappedfCashFactoryMock: WrappedfCashFactoryMock;
    beforeEach(async () => {
      wrappedfCashFactoryMock = await deployer.mocks.deployWrappedfCashFactoryMock();
    });

    describe("#constructor", async () => {
      let subjectController: Address;
      let subjectWrappedfCashFactory: Address;

      beforeEach(async () => {
        subjectController = setup.controller.address;
        subjectWrappedfCashFactory = wrappedfCashFactoryMock.address;
      });

      async function subject(): Promise<NotionalTradeModule> {
        return deployer.modules.deployNotionalTradeModule(
          subjectController,
          subjectWrappedfCashFactory,
        );
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
          wrappedfCashFactoryMock.address,
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
        let currencyId: number;
        let maturity: number;
        beforeEach(async () => {
          wrappedfCashMock = await deployer.mocks.deployWrappedfCashMock(cDai.address, dai.address);
          currencyId = 1;
          maturity = (await ethers.provider.getBlock("latest")).timestamp + 30 * 24 * 3600;

          await wrappedfCashMock.initialize(currencyId, maturity);

          await wrappedfCashFactoryMock.registerWrapper(
            currencyId,
            maturity,
            wrappedfCashMock.address,
          );

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

          describe("#updateAnySetAllowed", async () => {
            let caller: SignerWithAddress;
            let subjectStatus: boolean;

            beforeEach(async () => {
              caller = owner.wallet;
            });

            const subject = () => {
              return notionalTradeModule.connect(caller).updateAnySetAllowed(subjectStatus);
            };
            describe("when setting to true", () => {
              beforeEach(async () => {
                subjectStatus = true;
              });
              it("updates allowedSetTokens", async () => {
                await subject();
                expect(await notionalTradeModule.anySetAllowed()).to.be.true;
              });
              describe("when caller is not the owner", () => {
                beforeEach(() => {
                  caller = manager.wallet;
                });
                it("should revert", async () => {
                  await expect(subject()).to.be.revertedWith("Ownable: caller is not the owner");
                });
              });
            });
          });

          describe("#updateAllowedSetToken", async () => {
            let caller: SignerWithAddress;
            let subjectSetToken: Address;
            let subjectStatus: boolean;

            beforeEach(async () => {
              caller = owner.wallet;
            });

            const subject = () => {
              return notionalTradeModule
                .connect(caller)
                .updateAllowedSetToken(subjectSetToken, subjectStatus);
            };
            describe("when adding a new allowed set token", () => {
              beforeEach(async () => {
                subjectStatus = true;
              });
              describe("when set token is invalid", () => {
                beforeEach(() => {
                  subjectSetToken = ethers.constants.AddressZero;
                });
                it("should revert", async () => {
                  await expect(subject()).to.be.revertedWith("Invalid SetToken");
                });
              });
              describe("when set token is valid", () => {
                beforeEach(() => {
                  subjectSetToken = setToken.address;
                });
                it("updates allowedSetTokens", async () => {
                  await subject();
                  expect(await notionalTradeModule.allowedSetTokens(subjectSetToken)).to.be.true;
                });
              });
              describe("when caller is not the owner", () => {
                beforeEach(() => {
                  caller = manager.wallet;
                });
                it("should revert", async () => {
                  await expect(subject()).to.be.revertedWith("Ownable: caller is not the owner");
                });
              });
            });
            describe("when removing an allowed set token", () => {
              beforeEach(async () => {
                subjectSetToken = setToken.address;
                subjectStatus = false;
                await notionalTradeModule
                  .connect(owner.wallet)
                  .updateAllowedSetToken(subjectSetToken, true);
              });
              it("updates allowedSetTokens", async () => {
                expect(await notionalTradeModule.allowedSetTokens(subjectSetToken)).to.be.true;
                await subject();
                expect(await notionalTradeModule.allowedSetTokens(subjectSetToken)).to.be.false;
              });
            });
          });

          describe("#initialize", async () => {
            let isAllowListed: boolean = true;
            let subjectSetToken: Address;
            let subjectCaller: Account;

            beforeEach(async () => {
              if (isAllowListed) {
                // Add SetToken to allow list
                console.log("Updated allow list");
                await notionalTradeModule.updateAllowedSetToken(setToken.address, true);
              }

              subjectSetToken = setToken.address;
              subjectCaller = manager;
              console.log("Done");
            });

            async function subject(): Promise<any> {
              return notionalTradeModule.connect(subjectCaller.wallet).initialize(subjectSetToken);
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

          describe("when set token is allowed", () => {
            beforeEach(async () => {
              await notionalTradeModule.updateAllowedSetToken(setToken.address, true);
            });

            describe("when token is initialized on the notional module", () => {
              beforeEach(async () => {
                await notionalTradeModule.connect(manager.wallet).initialize(setToken.address);
              });

              describe("#registerToModule", () => {
                let caller: SignerWithAddress;
                let subjectSetToken: Address;
                let subjectIssuanceModule: Address;
                let newIssuanceModule: DebtIssuanceMock;

                const subject = () => {
                  return notionalTradeModule
                    .connect(caller)
                    .registerToModule(subjectSetToken, subjectIssuanceModule);
                };

                beforeEach(async () => {
                  caller = manager.wallet;
                  subjectSetToken = setToken.address;
                  newIssuanceModule = await deployer.mocks.deployDebtIssuanceMock();
                  await setup.controller.addModule(newIssuanceModule.address);
                  await setToken.connect(manager.wallet).addModule(newIssuanceModule.address);
                  subjectIssuanceModule = newIssuanceModule.address;
                });

                describe("when token is initialized on new issuance module", () => {
                  beforeEach(async () => {
                    await newIssuanceModule.initialize(setToken.address);
                  });

                  it("should not revert", async () => {
                    await subject();
                  });
                });

                describe("when token is NOT initialized on new issuance module", () => {
                  it("should revert", async () => {
                    await expect(subject()).to.be.revertedWith("Issuance not initialized");
                  });
                });
              });

              describe("#setRedeemToUnderlying", () => {
                let subjectSetToken: string;
                let subjectToUnderlying: boolean;
                let caller: SignerWithAddress;
                const subject = () => {
                  return notionalTradeModule
                    .connect(caller)
                    .setRedeemToUnderlying(subjectSetToken, subjectToUnderlying);
                };
                beforeEach(() => {
                  subjectSetToken = setToken.address;
                  subjectToUnderlying = true;
                  caller = manager.wallet;
                });
                describe("when setting to true", () => {
                  it("should adjust the state correctly", async () => {
                    await subject();
                    expect(await notionalTradeModule.redeemToUnderlying(subjectSetToken)).to.be
                      .true;
                  });
                  describe("when caller is not the manager", () => {
                    beforeEach(() => {
                      caller = owner.wallet;
                    });
                    it("should revert", async () => {
                      await expect(subject()).to.be.revertedWith("Must be the SetToken manager");
                    });
                  });
                });

                describe("when setting to false", () => {
                  beforeEach(async () => {
                    subjectToUnderlying = false;
                    await notionalTradeModule
                      .connect(manager.wallet)
                      .setRedeemToUnderlying(subjectSetToken, true);
                    expect(await notionalTradeModule.redeemToUnderlying(subjectSetToken)).to.be
                      .true;
                  });
                  it("should adjust the state correctly", async () => {
                    await subject();
                    expect(await notionalTradeModule.redeemToUnderlying(subjectSetToken)).to.be
                      .false;
                  });
                });
              });

              describe("#getFCashPositions", () => {
                let subjectSetToken: string;
                const subject = () => {
                  return notionalTradeModule.getFCashPositions(subjectSetToken);
                };
                beforeEach(() => {
                  subjectSetToken = setToken.address;
                });
                it("should return the correct fCash positions", async () => {
                  const fCashPositions = await subject();
                  expect(fCashPositions).to.deep.eq([wrappedfCashMock.address]);
                });
                describe("When the unit is negative", () => {
                  beforeEach(async () => {
                    await setup.controller.connect(owner.wallet).addModule(owner.address);
                    await setToken.connect(manager.wallet).addModule(owner.address);
                    await setToken.connect(owner.wallet).initializeModule();
                    await setToken
                      .connect(owner.wallet)
                      .editDefaultPositionUnit(wrappedfCashMock.address, -420);
                    const externalPositionModule = await getRandomAddress();
                    await setToken
                      .connect(owner.wallet)
                      .addExternalPositionModule(wrappedfCashMock.address, externalPositionModule);
                    await setToken
                      .connect(owner.wallet)
                      .editExternalPositionUnit(
                        wrappedfCashMock.address,
                        externalPositionModule,
                        -420,
                      );
                  });
                  it("should not return the fCash component", async () => {
                    const fCashPositions = await subject();
                    expect(fCashPositions).to.deep.eq([]);
                  });
                });
              });
              describe("#redeem/mintFCashPosition", () => {
                let receiveToken: IERC20;
                let sendToken: IERC20;
                let subjectSetToken: string;
                let subjectSendToken: string;
                let subjectSendQuantity: BigNumber;
                let subjectReceiveToken: string;
                let subjectMinReceiveQuantity: BigNumber;
                let subjectCurrencyId: number;
                let subjectMaturity: number | BigNumber;
                let caller: SignerWithAddress;

                beforeEach(async () => {
                  subjectSetToken = setToken.address;
                  caller = manager.wallet;
                  subjectCurrencyId = currencyId;
                  subjectMaturity = maturity;
                });

                ["buying", "selling"].forEach(tradeDirection => {
                  ["underlyingToken", "assetToken"].forEach(tokenType => {
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
                          await sendToken.transfer(
                            wrappedfCashMock.address,
                            subjectSendQuantity.mul(2),
                          );
                          await notionalTradeModule
                            .connect(manager.wallet)
                            .redeemFCashPosition(
                              setToken.address,
                              subjectCurrencyId,
                              subjectMaturity,
                              fTokenQuantity.mul(2),
                              sendToken.address,
                              subjectSendQuantity.mul(2),
                            );
                        }
                        if (tradeDirection == "selling") {
                          await receiveToken.transfer(
                            wrappedfCashMock.address,
                            subjectMinReceiveQuantity.mul(2),
                          );
                        }
                      });

                      const subject = () => {
                        if (tradeDirection == "buying") {
                          return notionalTradeModule
                            .connect(caller)
                            .mintFCashPosition(
                              subjectSetToken,
                              subjectCurrencyId,
                              subjectMaturity,
                              subjectMinReceiveQuantity,
                              subjectSendToken,
                              subjectSendQuantity,
                            );
                        } else {
                          return notionalTradeModule
                            .connect(caller)
                            .redeemFCashPosition(
                              subjectSetToken,
                              subjectCurrencyId,
                              subjectMaturity,
                              subjectSendQuantity,
                              subjectReceiveToken,
                              subjectMinReceiveQuantity,
                            );
                        }
                      };

                      const subjectCall = () => {
                        if (tradeDirection == "buying") {
                          return notionalTradeModule
                            .connect(caller)
                            .callStatic.mintFCashPosition(
                              subjectSetToken,
                              subjectCurrencyId,
                              subjectMaturity,
                              subjectMinReceiveQuantity,
                              subjectSendToken,
                              subjectSendQuantity,
                            );
                        } else {
                          return notionalTradeModule
                            .connect(caller)
                            .callStatic.redeemFCashPosition(
                              subjectSetToken,
                              subjectCurrencyId,
                              subjectMaturity,
                              subjectSendQuantity,
                              subjectReceiveToken,
                              subjectMinReceiveQuantity,
                            );
                        }
                      };

                      if (tradeDirection == "buying") {
                        describe("When sendToken is neither underlying nor asset token", () => {
                          beforeEach(async () => {
                            subjectSendToken = ethers.constants.AddressZero;
                          });
                          it("should revert", async () => {
                            await expect(subject()).to.be.revertedWith(
                              "Token is neither asset nor underlying token",
                            );
                          });
                        });

                        describe("When receiveAmount is 0", () => {
                          beforeEach(async () => {
                            subjectMinReceiveQuantity = BigNumber.from(0);
                          });
                          it("should not revert", async () => {
                            await subject();
                          });
                        });

                        describe(`when too much ${tokenType} is spent`, () => {
                          beforeEach(async () => {
                            await wrappedfCashMock.setMintTokenSpent(subjectSendQuantity.mul(2));
                          });
                          it("should revert", async () => {
                            await expect(subject()).to.be.revertedWith("Overspent");
                          });
                        });
                      } else {
                        describe("When receiveToken is neither underlying nor asset token", () => {
                          beforeEach(async () => {
                            subjectReceiveToken = ethers.constants.AddressZero;
                          });
                          it("should revert", async () => {
                            await expect(subject()).to.be.revertedWith(
                              "Token is neither asset nor underlying token",
                            );
                          });
                        });

                        describe("When sendAmount is 0", () => {
                          beforeEach(async () => {
                            subjectSendQuantity = BigNumber.from(0);
                          });
                          it("should not revert", async () => {
                            await subject();
                          });
                        });
                        describe(`when too little ${tokenType} is returned`, () => {
                          beforeEach(async () => {
                            await wrappedfCashMock.setRedeemTokenReturned(
                              subjectMinReceiveQuantity.div(2),
                            );
                          });
                          it("should revert", async () => {
                            await expect(subject()).to.be.revertedWith(
                              "Not enough received amount",
                            );
                          });
                        });
                      }
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

                      it("should not revert when executing trade twice", async () => {
                        await subject();
                        await subject();
                      });

                      it("should return spent / received amount of non-fcash-token", async () => {
                        const otherTokenBalanceBefore = await otherToken.balanceOf(
                          setToken.address,
                        );
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
                        const totalSetSupplyEther = totalSetSupplyWei.div(
                          BigNumber.from(10).pow(18),
                        );

                        let receiveTokenAmountNormalized;
                        if (receiveTokenType == "underlyingToken") {
                          receiveTokenAmountNormalized = receiveTokenAmount.div(
                            totalSetSupplyEther,
                          );
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
                        const totalSetSupplyEther = totalSetSupplyWei.div(
                          BigNumber.from(10).pow(18),
                        );

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
              describe("#moduleIssue/RedeemHook", () => {
                let subjectSetToken: string;
                let subjectReceiver: string;
                let subjectAmount: BigNumber;
                let caller: SignerWithAddress;
                beforeEach(() => {
                  subjectSetToken = setToken.address;
                  subjectAmount = ethers.utils.parseEther("1");
                  caller = owner.wallet;
                  subjectReceiver = caller.address;
                });
                ["underlying", "asset"].forEach(redeemToken => {
                  describe(`when redeeming to ${redeemToken}`, () => {
                    let outputToken: IERC20;
                    beforeEach(async () => {
                      const toUnderlying = redeemToken == "underlying";
                      await notionalTradeModule
                        .connect(manager.wallet)
                        .setRedeemToUnderlying(subjectSetToken, toUnderlying);
                      outputToken = redeemToken == "underlying" ? dai : cDai;
                    });
                    ["issue", "redeem", "manualTrigger", "removeModule"].forEach(triggerAction => {
                      describe(`When hook is triggered by ${triggerAction}`, () => {
                        beforeEach(async () => {
                          const daiAmount = ethers.utils.parseEther("2.1");
                          const fCashAmount = ethers.utils.parseUnits("2", 8);

                          await cDai.connect(owner.wallet).mint(ether(1));
                          const cDaiBalance = await cDai.balanceOf(owner.address);
                          await cDai
                            .connect(owner.wallet)
                            .transfer(wrappedfCashMock.address, cDaiBalance);

                          const redemptionAssetAmount = cDaiBalance.div(2);
                          await wrappedfCashMock.setRedeemTokenReturned(redemptionAssetAmount);

                          if (triggerAction == "redeem") {
                            await mintWrappedFCash(
                              owner.wallet,
                              dai,
                              daiAmount,
                              fCashAmount,
                              cDai as any,
                              wrappedfCashMock as any,
                              true,
                            );
                            await debtIssuanceModule
                              .connect(owner.wallet)
                              .issue(subjectSetToken, subjectAmount, caller.address);
                            await setToken
                              .connect(caller)
                              .approve(debtIssuanceModule.address, subjectAmount);
                          } else if (triggerAction == "issue") {
                            await dai.transfer(caller.address, daiAmount);

                            if (redeemToken == "underlying") {
                              // If matured tokens are redeemed to underlying token issuer will need that token (dai) for issuance
                              await dai
                                .connect(caller)
                                .approve(debtIssuanceModule.address, ethers.constants.MaxUint256);
                            } else {
                              // If matured tokens are redeemed to asset token issuer will need that token (cDai) for issuance
                              await dai
                                .connect(caller)
                                .approve(cDai.address, ethers.constants.MaxUint256);
                              await cDai.connect(caller).mint(daiAmount);
                              await cDai
                                .connect(caller)
                                .approve(debtIssuanceModule.address, ethers.constants.MaxUint256);
                            }
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
                          } else if (triggerAction == "removeModule") {
                            return setToken
                              .connect(manager.wallet)
                              .removeModule(notionalTradeModule.address);
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
                                cDai as any,
                                wrappedfCashMock as any,
                                true,
                              );
                              await wrappedfCashMock
                                .connect(caller)
                                .approve(debtIssuanceModule.address, ethers.constants.MaxUint256);
                            }
                            expect(await wrappedfCashMock.hasMatured()).to.be.false;
                          });
                          it("fCash position remains the same", async () => {
                            const positionBefore = await setToken.getDefaultPositionRealUnit(
                              wrappedfCashMock.address,
                            );
                            await subject();
                            const positionAfter = await setToken.getDefaultPositionRealUnit(
                              wrappedfCashMock.address,
                            );
                            expect(positionAfter).to.eq(positionBefore);
                          });
                        });

                        describe("When component has matured", () => {
                          beforeEach(async () => {
                            await wrappedfCashMock.setMatured(true);
                          });

                          if (["issue", "redeem"].includes(triggerAction)) {
                            it(`should adjust ${redeemToken} balance correctly`, async () => {
                              const outputTokenBalanceBefore = await outputToken.balanceOf(
                                caller.address,
                              );
                              await subject();
                              const outputTokenBalanceAfter = await outputToken.balanceOf(
                                caller.address,
                              );
                              const amountCDaiTransfered =
                                triggerAction == "redeem"
                                  ? outputTokenBalanceAfter.sub(outputTokenBalanceBefore)
                                  : outputTokenBalanceBefore.sub(outputTokenBalanceAfter);

                              expect(amountCDaiTransfered).to.be.gt(0);
                            });

                            it("should issue correct amount of set tokens", async () => {
                              const setTokenBalanceBefore = await setToken.balanceOf(
                                caller.address,
                              );
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
                            expect(await setToken.isComponent(wrappedfCashMock.address)).to.be.true;
                            await subject();
                            expect(await setToken.isComponent(wrappedfCashMock.address)).to.be
                              .false;
                          });

                          it("Removes wrappedFCash from the list of registered fCashPositions", async () => {
                            await subject();
                            const fCashPositions = await notionalTradeModule.getFCashPositions(
                              subjectSetToken,
                            );
                            expect(fCashPositions).to.not.include(wrappedfCashMock.address);
                          });

                          it(`Adds ${redeemToken} token to component list`, async () => {
                            expect(await setToken.isComponent(outputToken.address)).to.be.false;
                            await subject();
                            expect(await setToken.isComponent(outputToken.address)).to.be.true;
                          });

                          it("Afterwards setToken should have no fCash balance anymore", async () => {
                            const balanceBefore = await wrappedfCashMock.balanceOf(subjectSetToken);
                            expect(balanceBefore).to.be.gt(0);
                            await subject();
                            const balanceAfter = await wrappedfCashMock.balanceOf(subjectSetToken);
                            expect(balanceAfter).to.eq(0);
                          });

                          it(`Afterwards setToken should have received ${redeemToken} token`, async () => {
                            const balanceBefore = await outputToken.balanceOf(subjectSetToken);
                            await subject();
                            const balanceAfter = await outputToken.balanceOf(subjectSetToken);
                            expect(balanceAfter.sub(balanceBefore)).to.be.gt(0);
                          });

                          it(`Afterwards setToken should have positive ${redeemToken} position`, async () => {
                            const positionBefore = await setToken.getDefaultPositionRealUnit(
                              outputToken.address,
                            );
                            await subject();
                            const positionAfter = await setToken.getDefaultPositionRealUnit(
                              outputToken.address,
                            );
                            expect(positionAfter.sub(positionBefore)).to.be.gt(0);
                          });

                          describe("When positions have been redeemed already", () => {
                            beforeEach(async () => {
                              await notionalTradeModule.redeemMaturedPositions(setToken.address);
                            });
                            it("should not revert", async () => {
                              await subject();
                            });
                          });

                          describe("When positions have been redeemed already", () => {
                            beforeEach(async () => {
                              await notionalTradeModule.redeemMaturedPositions(setToken.address);
                            });
                            it("should not revert", async () => {
                              await subject();
                            });
                          });

                          if (triggerAction == "manualTrigger") {
                            [
                              "wrong currencyId",
                              "wrong maturity",
                              "reverted getCurrencyId",
                              "reverted getMaturity",
                              "reverted computeAddress",
                              "negative unit",
                            ].forEach(reason => {
                              describe(`When the wrappedFCash position is not recognized as such because of ${reason}`, () => {
                                beforeEach(async () => {
                                  if (reason == "wrong currencyId") {
                                    await wrappedfCashMock.initialize(420, maturity);
                                  } else if (reason == "wrong maturity") {
                                    await wrappedfCashMock.initialize(currencyId, 420);
                                  } else if (reason == "reverted getCurrencyId") {
                                    await wrappedfCashMock.setRevertCurrencyId(true);
                                  } else if (reason == "reverted getMaturity") {
                                    await wrappedfCashMock.setRevertMaturity(true);
                                  } else if (reason == "reverted computeAddress") {
                                    await wrappedfCashFactoryMock.setRevertComputeAddress(true);
                                  } else if (reason == "negative unit") {
                                    // We add the owner as a fake-module to be able to add arbitrary addresses as components
                                    await setup.controller
                                      .connect(owner.wallet)
                                      .addModule(owner.address);
                                    await setToken.connect(manager.wallet).addModule(owner.address);
                                    await setToken.connect(owner.wallet).initializeModule();
                                    // Just changing the default position to <= 0 will make it disappear from the position list
                                    await setToken
                                      .connect(owner.wallet)
                                      .editDefaultPositionUnit(wrappedfCashMock.address, -420);
                                    const externalPositionModule = await getRandomAddress();
                                    await setToken
                                      .connect(owner.wallet)
                                      .addExternalPositionModule(
                                        wrappedfCashMock.address,
                                        externalPositionModule,
                                      );
                                    // Have to add it back in as an external position to get a negative unit
                                    await setToken
                                      .connect(owner.wallet)
                                      .editExternalPositionUnit(
                                        wrappedfCashMock.address,
                                        externalPositionModule,
                                        -420,
                                      );
                                  }
                                });
                                it("fCash position remains the same", async () => {
                                  const positionBefore = await setToken.getDefaultPositionRealUnit(
                                    wrappedfCashMock.address,
                                  );
                                  await subject();
                                  const positionAfter = await setToken.getDefaultPositionRealUnit(
                                    wrappedfCashMock.address,
                                  );
                                  expect(positionAfter).to.eq(positionBefore);
                                });
                              });
                            });

                            describe("When setToken contains an additional position that is not a smart contract", () => {
                              beforeEach(async () => {
                                const nonContractComponent = await getRandomAddress();
                                // We add the owner as a fake-module to be able to add arbitrary addresses as components
                                await setup.controller
                                  .connect(owner.wallet)
                                  .addModule(owner.address);
                                await setToken.connect(manager.wallet).addModule(owner.address);
                                await setToken.connect(owner.wallet).initializeModule();
                                await setToken
                                  .connect(owner.wallet)
                                  .addComponent(nonContractComponent);
                                await setToken
                                  .connect(owner.wallet)
                                  .editDefaultPositionUnit(nonContractComponent, 420);
                              });
                              it(`Afterwards setToken should have received ${redeemToken} token`, async () => {
                                const balanceBefore = await outputToken.balanceOf(subjectSetToken);
                                await subject();
                                const balanceAfter = await outputToken.balanceOf(subjectSetToken);
                                expect(balanceAfter.sub(balanceBefore)).to.be.gt(0);
                              });

                              it(`Afterwards setToken should have positive ${redeemToken} position`, async () => {
                                const positionBefore = await setToken.getDefaultPositionRealUnit(
                                  outputToken.address,
                                );
                                await subject();
                                const positionAfter = await setToken.getDefaultPositionRealUnit(
                                  outputToken.address,
                                );
                                expect(positionAfter.sub(positionBefore)).to.be.gt(0);
                              });
                            });
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
    });
  });
});
