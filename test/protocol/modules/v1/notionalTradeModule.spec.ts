import "module-alias/register";
import { BigNumber } from "ethers";
import { Address } from "@utils/types";
import { Account } from "@utils/test/types";
import {
  NotionalTradeModule,
  DebtIssuanceMock,
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

const expect = getWaffleExpect();

describe("NotionalTradeModule", () => {
  let owner: Account;
  let deployer: DeployHelper;
  let setup: SystemFixture;

  let debtIssuanceMock: DebtIssuanceMock;

  let compoundSetup: CompoundFixture;
  let cDai: CERc20;
  let dai: StandardTokenMock;
  let cTokenInitialMantissa: BigNumber;

  beforeEach(async () => {
    [owner] = await getAccounts();

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

  describe("When wrappedFCashMock is deployed", async () => {
    let wrappedfCashMock: WrappedfCashMock;
    beforeEach(async () => {
      console.log("deploying wrappedfCashMock");
      wrappedfCashMock = await deployer.mocks.deployWrappedfCashMock(cDai.address, dai.address);
      console.log("deployed wrappedfCashMock", wrappedfCashMock.address);
    });
    describe("When notional module is deployed", async () => {
      let notionalTradeModule: NotionalTradeModule;
      beforeEach(async () => {
        notionalTradeModule = await deployer.modules.deployNotionalTradeModule(
          setup.controller.address,
        );
        await setup.controller.addModule(notionalTradeModule.address);

        debtIssuanceMock = await deployer.mocks.deployDebtIssuanceMock();
        await setup.controller.addModule(debtIssuanceMock.address);

        await setup.integrationRegistry.addIntegration(
          notionalTradeModule.address,
          "DefaultIssuanceModule",
          debtIssuanceMock.address,
        );
      });

      describe("#initialize", async () => {
        let setToken: SetToken;
        let isAllowListed: boolean = true;
        let subjectSetToken: Address;
        let subjectFCashPositions: Address[];
        let subjectCaller: Account;

        beforeEach(async () => {
          setToken = await setup.createSetToken(
            [setup.weth.address, setup.dai.address],
            [ether(1), ether(100)],
            [notionalTradeModule.address, debtIssuanceMock.address],
          );
          await debtIssuanceMock.initialize(setToken.address);

          if (isAllowListed) {
            // Add SetToken to allow list
            await notionalTradeModule.updateAllowedSetToken(setToken.address, true);
          }

          subjectSetToken = setToken.address;
          subjectFCashPositions = [setup.weth.address, setup.dai.address];
          subjectCaller = owner;
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
            const isModuleEnabled = await setToken.isInitializedModule(notionalTradeModule.address);
            expect(isModuleEnabled).to.eq(true);
          });

          it("should register on the debt issuance module", async () => {
            await subject();
            const isRegistered = await debtIssuanceMock.isRegistered(setToken.address);
            expect(isRegistered).to.be.true;
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
                debtIssuanceMock.address,
              );
            });

            it("should revert", async () => {
              await expect(subject()).to.be.revertedWith("Must be valid adapter");
            });
          });

          describe("when debt issuance module is not initialized on SetToken", async () => {
            beforeEach(async () => {
              await setToken.removeModule(debtIssuanceMock.address);
            });

            afterEach(async () => {
              await setToken.addModule(debtIssuanceMock.address);
              await debtIssuanceMock.initialize(setToken.address);
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
    });
  });
});
