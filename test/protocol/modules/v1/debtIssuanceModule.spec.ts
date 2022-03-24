import "module-alias/register";

import { BigNumber } from "ethers";

import { Address } from "@utils/types";
import { Account } from "@utils/test/types";
import { ZERO, ADDRESS_ZERO } from "@utils/constants";
import { DebtIssuanceModule, DebtModuleMock, ModuleIssuanceHookMock, SetToken, ManagerIssuanceHookMock } from "@utils/contracts";
import DeployHelper from "@utils/deploys";
import {
  ether,
  preciseMul,
  preciseMulCeil,
  bitcoin,
} from "@utils/index";
import {
  addSnapshotBeforeRestoreAfterEach,
  getAccounts,
  getRandomAccount,
  getRandomAddress,
  getSystemFixture,
  getWaffleExpect,
} from "@utils/test/index";
import { SystemFixture } from "@utils/fixtures";
import { ContractTransaction } from "ethers";

const expect = getWaffleExpect();

describe("DebtIssuanceModule", () => {
  let owner: Account;
  let manager: Account;
  let feeRecipient: Account;
  let dummyModule: Account;
  let recipient: Account;
  let deployer: DeployHelper;
  let setup: SystemFixture;

  let debtModule: DebtModuleMock;
  let externalPositionModule: ModuleIssuanceHookMock;
  let debtIssuance: DebtIssuanceModule;
  let issuanceHook: ManagerIssuanceHookMock;
  let setToken: SetToken;

  before(async () => {
    [
      owner,
      manager,
      feeRecipient,
      dummyModule,  // Set as protocol fee recipient
      recipient,
    ] = await getAccounts();

    deployer = new DeployHelper(owner.wallet);
    setup = getSystemFixture(owner.address);

    await setup.initialize();

    debtIssuance = await deployer.modules.deployDebtIssuanceModule(setup.controller.address);
    debtModule = await deployer.mocks.deployDebtModuleMock(setup.controller.address);
    externalPositionModule = await deployer.mocks.deployModuleIssuanceHookMock();
    issuanceHook = await deployer.mocks.deployManagerIssuanceHookMock();

    await setup.controller.addModule(debtIssuance.address);
    await setup.controller.addModule(debtModule.address);
    await setup.controller.addModule(externalPositionModule.address);

    setToken = await setup.createSetToken(
      [setup.weth.address],
      [ether(1)],
      [setup.issuanceModule.address, debtIssuance.address, debtModule.address, externalPositionModule.address],
      manager.address,
      "DebtToken",
      "DBT"
    );

    await externalPositionModule.initialize(setToken.address);
  });

  addSnapshotBeforeRestoreAfterEach();

  describe("#initialize", async () => {
    let subjectSetToken: Address;
    let subjectMaxManagerFee: BigNumber;
    let subjectManagerIssueFee: BigNumber;
    let subjectManagerRedeemFee: BigNumber;
    let subjectFeeRecipient: Address;
    let subjectManagerIssuanceHook: Address;
    let subjectCaller: Account;

    beforeEach(async () => {
      subjectSetToken = setToken.address;
      subjectMaxManagerFee = ether(0.02);
      subjectManagerIssueFee = ether(0.005);
      subjectManagerRedeemFee = ether(0.004);
      subjectFeeRecipient = feeRecipient.address;
      subjectManagerIssuanceHook = owner.address;
      subjectCaller = manager;
    });

    async function subject(): Promise<ContractTransaction> {
      return debtIssuance.connect(subjectCaller.wallet).initialize(
        subjectSetToken,
        subjectMaxManagerFee,
        subjectManagerIssueFee,
        subjectManagerRedeemFee,
        subjectFeeRecipient,
        subjectManagerIssuanceHook
      );
    }

    it("should set the correct state", async () => {
      await subject();

      const settings: any = await debtIssuance.issuanceSettings(subjectSetToken);

      expect(settings.maxManagerFee).to.eq(subjectMaxManagerFee);
      expect(settings.managerIssueFee).to.eq(subjectManagerIssueFee);
      expect(settings.managerRedeemFee).to.eq(subjectManagerRedeemFee);
      expect(settings.feeRecipient).to.eq(subjectFeeRecipient);
      expect(settings.managerIssuanceHook).to.eq(subjectManagerIssuanceHook);
    });

    describe("when the issue fee is greater than the maximum fee", async () => {
      beforeEach(async () => {
        subjectManagerIssueFee = ether(0.03);
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Issue fee can't exceed maximum fee");
      });
    });

    describe("when the redeem fee is greater than the maximum fee", async () => {
      beforeEach(async () => {
        subjectManagerRedeemFee = ether(0.03);
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Redeem fee can't exceed maximum fee");
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

        const issuanceModuleNotPendingSetToken = await setup.createSetToken(
          [setup.weth.address],
          [ether(1)],
          [newModule],
          manager.address
        );

        subjectSetToken = issuanceModuleNotPendingSetToken.address;
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
          [debtIssuance.address],
          manager.address
        );

        subjectSetToken = nonEnabledSetToken.address;
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Must be controller-enabled SetToken");
      });
    });
  });

  context("DebtIssuanceModule has been initialized", async () => {
    let preIssueHook: Address;
    let initialize: boolean;
    let maxFee: BigNumber;
    let issueFee: BigNumber;
    let redeemFee: BigNumber;

    before(async () => {
      preIssueHook = ADDRESS_ZERO;
      initialize = true;
      maxFee = ether(0.02);
      issueFee = ether(0.005);
      redeemFee = ether(0.005);
    });

    beforeEach(async () => {
      if (initialize) {
        await debtIssuance.connect(manager.wallet).initialize(
          setToken.address,
          maxFee,
          issueFee,
          redeemFee,
          feeRecipient.address,
          preIssueHook
        );
      }
    });

    describe("#removeModule", async () => {
      let subjectModule: Address;

      beforeEach(async () => {
        subjectModule = debtIssuance.address;
      });

      async function subject(): Promise<ContractTransaction> {
        return setToken.connect(manager.wallet).removeModule(subjectModule);
      }

      it("should set the correct state", async () => {
        await subject();

        const settings: any = await debtIssuance.issuanceSettings(setToken.address);

        expect(settings.managerIssueFee).to.eq(ZERO);
        expect(settings.managerRedeemFee).to.eq(ZERO);
        expect(settings.feeRecipient).to.eq(ADDRESS_ZERO);
        expect(settings.managerIssuanceHook).to.eq(ADDRESS_ZERO);
      });

      describe("when a module is still registered with the DebtIssuanceModule", async () => {
        beforeEach(async () => {
          await setup.controller.addModule(dummyModule.address);
          await setToken.connect(manager.wallet).addModule(dummyModule.address);
          await setToken.connect(dummyModule.wallet).initializeModule();

          await debtIssuance.connect(dummyModule.wallet).registerToIssuanceModule(setToken.address);
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("Registered modules must be removed.");
        });
      });
    });

    describe("#registerToIssuanceModule", async () => {
      let subjectSetToken: Address;
      let subjectCaller: Account;

      beforeEach(async () => {
        await setup.controller.addModule(dummyModule.address);
        await setToken.connect(manager.wallet).addModule(dummyModule.address);
        await setToken.connect(dummyModule.wallet).initializeModule();

        subjectSetToken = setToken.address;
        subjectCaller = dummyModule;
      });

      async function subject(): Promise<ContractTransaction> {
        return debtIssuance.connect(subjectCaller.wallet).registerToIssuanceModule(
          subjectSetToken
        );
      }

      it("should add dummyModule to moduleIssuanceHooks", async () => {
        await subject();

        const moduleHooks = await debtIssuance.getModuleIssuanceHooks(subjectSetToken);
        expect(moduleHooks).to.contain(subjectCaller.address);
      });

      it("should mark dummyModule as a valid module issuance hook", async () => {
        await subject();

        const isModuleHook = await debtIssuance.isModuleIssuanceHook(subjectSetToken, dummyModule.address);
        expect(isModuleHook).to.be.true;
      });

      describe("when DebtIssuanceModule is not initialized", async () => {
        before(async () => {
          initialize = false;
        });

        after(async () => {
          initialize = true;
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("Must be a valid and initialized SetToken");
        });
      });

      describe("when module is already registered", async () => {
        beforeEach(async () => {
          await subject();
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("Module already registered.");
        });
      });
    });

    describe("#unregisterFromIssuanceModule", async () => {
      let subjectSetToken: Address;
      let subjectCaller: Account;
      let register: boolean;

      before(async () => {
        register = true;
      });

      beforeEach(async () => {
        await setup.controller.addModule(dummyModule.address);
        await setToken.connect(manager.wallet).addModule(dummyModule.address);
        await setToken.connect(dummyModule.wallet).initializeModule();

        if (register) {
          await debtIssuance.connect(dummyModule.wallet).registerToIssuanceModule(setToken.address);
        }

        subjectSetToken = setToken.address;
        subjectCaller = dummyModule;
      });

      async function subject(): Promise<ContractTransaction> {
        return debtIssuance.connect(subjectCaller.wallet).unregisterFromIssuanceModule(
          subjectSetToken
        );
      }

      it("should remove dummyModule from issuanceSettings", async () => {
        const preModuleHooks = await debtIssuance.getModuleIssuanceHooks(subjectSetToken);
        expect(preModuleHooks).to.contain(subjectCaller.address);

        await subject();

        const postModuleHooks = await debtIssuance.getModuleIssuanceHooks(subjectSetToken);
        expect(postModuleHooks).to.not.contain(subjectCaller.address);
      });

      it("should not mark dummyModule as a valid module issuance hook", async () => {
        await subject();

        const isModuleHook = await debtIssuance.isModuleIssuanceHook(subjectSetToken, dummyModule.address);
        expect(isModuleHook).to.be.false;
      });

      describe("when calling module isn't registered", async () => {
        before(async () => {
          register = false;
        });

        after(async () => {
          register = true;
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("Module not registered.");
        });
      });
    });

    context("External debt module has been registered with DebtIssuanceModule", async () => {
      beforeEach(async () => {
        await debtModule.connect(manager.wallet).initialize(setToken.address, debtIssuance.address);
      });

      describe("#getRequiredComponentIssuanceUnits", async () => {
        let subjectSetToken: Address;
        let subjectQuantity: BigNumber;

        const debtUnits: BigNumber = ether(100);

        beforeEach(async () => {
          await debtModule.addDebt(setToken.address, setup.dai.address, debtUnits);

          subjectSetToken = setToken.address;
          subjectQuantity = ether(1);
        });

        async function subject(): Promise<any> {
          return debtIssuance.getRequiredComponentIssuanceUnits(
            subjectSetToken,
            subjectQuantity
          );
        }

        it("should return the correct issue token amounts", async () => {
          const [components, equityFlows, debtFlows] = await subject();

          const mintQuantity = preciseMul(subjectQuantity, ether(1).add(issueFee));
          const daiFlows = preciseMulCeil( mintQuantity, debtUnits);
          const wethFlows = preciseMul(mintQuantity, ether(1));

          const expectedComponents = await setToken.getComponents();
          const expectedEquityFlows = [wethFlows, ZERO];
          const expectedDebtFlows = [ZERO, daiFlows];

          expect(JSON.stringify(expectedComponents)).to.eq(JSON.stringify(components));
          expect(JSON.stringify(expectedEquityFlows)).to.eq(JSON.stringify(equityFlows));
          expect(JSON.stringify(expectedDebtFlows)).to.eq(JSON.stringify(debtFlows));
        });

        describe("when an additive external equity position is in place", async () => {
          const externalUnits: BigNumber = ether(1);

          beforeEach(async () => {
            await externalPositionModule.addExternalPosition(setToken.address, setup.weth.address, externalUnits);
          });

          it("should return the correct issue token amounts", async () => {
            const [components, equityFlows, debtFlows] = await subject();

            const mintQuantity = preciseMul(subjectQuantity, ether(1).add(issueFee));
            const daiFlows = preciseMulCeil( mintQuantity, debtUnits);
            const wethFlows = preciseMul(mintQuantity, ether(1).add(externalUnits));

            const expectedComponents = await setToken.getComponents();
            const expectedEquityFlows = [wethFlows, ZERO];
            const expectedDebtFlows = [ZERO, daiFlows];

            expect(JSON.stringify(expectedComponents)).to.eq(JSON.stringify(components));
            expect(JSON.stringify(expectedEquityFlows)).to.eq(JSON.stringify(equityFlows));
            expect(JSON.stringify(expectedDebtFlows)).to.eq(JSON.stringify(debtFlows));
          });
        });

        describe("when a non-additive external equity position is in place", async () => {
          const externalUnits: BigNumber = bitcoin(.5);

          beforeEach(async () => {
            await externalPositionModule.addExternalPosition(setToken.address, setup.wbtc.address, externalUnits);
          });

          it("should return the correct issue token amounts", async () => {
            const [components, equityFlows, debtFlows] = await subject();

            const mintQuantity = preciseMul(subjectQuantity, ether(1).add(issueFee));
            const daiFlows = preciseMulCeil( mintQuantity, debtUnits);
            const wethFlows = preciseMul(mintQuantity, ether(1));
            const btcFlows = preciseMul(mintQuantity, externalUnits);

            const expectedComponents = await setToken.getComponents();
            const expectedEquityFlows = [wethFlows, ZERO, btcFlows];
            const expectedDebtFlows = [ZERO, daiFlows, ZERO];

            expect(JSON.stringify(expectedComponents)).to.eq(JSON.stringify(components));
            expect(JSON.stringify(expectedEquityFlows)).to.eq(JSON.stringify(equityFlows));
            expect(JSON.stringify(expectedDebtFlows)).to.eq(JSON.stringify(debtFlows));
          });
        });
      });

      describe("#getRequiredComponentRedemptionUnits", async () => {
        let subjectSetToken: Address;
        let subjectQuantity: BigNumber;

        const debtUnits: BigNumber = ether(100);

        beforeEach(async () => {
          await debtModule.addDebt(setToken.address, setup.dai.address, debtUnits);

          subjectSetToken = setToken.address;
          subjectQuantity = ether(1);
        });

        async function subject(): Promise<any> {
          return debtIssuance.getRequiredComponentRedemptionUnits(
            subjectSetToken,
            subjectQuantity
          );
        }

        it("should return the correct redeem token amounts", async () => {
          const [components, equityFlows, debtFlows] = await subject();

          const mintQuantity = preciseMul(subjectQuantity, ether(1).sub(issueFee));
          const daiFlows = preciseMulCeil( mintQuantity, debtUnits);
          const wethFlows = preciseMul(mintQuantity, ether(1));

          const expectedComponents = await setToken.getComponents();
          const expectedEquityFlows = [wethFlows, ZERO];
          const expectedDebtFlows = [ZERO, daiFlows];

          expect(JSON.stringify(expectedComponents)).to.eq(JSON.stringify(components));
          expect(JSON.stringify(expectedEquityFlows)).to.eq(JSON.stringify(equityFlows));
          expect(JSON.stringify(expectedDebtFlows)).to.eq(JSON.stringify(debtFlows));
        });


        describe("when an additive external equity position is in place", async () => {
          const externalUnits: BigNumber = ether(1);

          beforeEach(async () => {
            await externalPositionModule.addExternalPosition(setToken.address, setup.weth.address, externalUnits);
          });

          it("should return the correct redeem token amounts", async () => {
            const [components, equityFlows, debtFlows] = await subject();

            const mintQuantity = preciseMul(subjectQuantity, ether(1).sub(issueFee));
            const daiFlows = preciseMulCeil(mintQuantity, debtUnits);
            const wethFlows = preciseMul(mintQuantity, ether(1).add(externalUnits));

            const expectedComponents = await setToken.getComponents();
            const expectedEquityFlows = [wethFlows, ZERO];
            const expectedDebtFlows = [ZERO, daiFlows];

            expect(JSON.stringify(expectedComponents)).to.eq(JSON.stringify(components));
            expect(JSON.stringify(expectedEquityFlows)).to.eq(JSON.stringify(equityFlows));
            expect(JSON.stringify(expectedDebtFlows)).to.eq(JSON.stringify(debtFlows));
          });
        });

        describe("when a non-additive external equity position is in place", async () => {
          const externalUnits: BigNumber = bitcoin(0.5);

          beforeEach(async () => {
            await externalPositionModule.addExternalPosition(setToken.address, setup.wbtc.address, externalUnits);
          });

          it("should return the correct redeem token amounts", async () => {
            const [components, equityFlows, debtFlows] = await subject();

            const mintQuantity = preciseMul(subjectQuantity, ether(1).sub(issueFee));
            const daiFlows = preciseMulCeil(mintQuantity, debtUnits);
            const wethFlows = preciseMul(mintQuantity, ether(1));
            const wbtcFlows = preciseMul(mintQuantity, externalUnits);

            const expectedComponents = await setToken.getComponents();
            const expectedEquityFlows = [wethFlows, ZERO, wbtcFlows];
            const expectedDebtFlows = [ZERO, daiFlows, ZERO];

            expect(JSON.stringify(expectedComponents)).to.eq(JSON.stringify(components));
            expect(JSON.stringify(expectedEquityFlows)).to.eq(JSON.stringify(equityFlows));
            expect(JSON.stringify(expectedDebtFlows)).to.eq(JSON.stringify(debtFlows));
          });
        });
      });

      describe("#issue", async () => {
        let subjectSetToken: Address;
        let subjectQuantity: BigNumber;
        let subjectTo: Address;
        let subjectCaller: Account;

        const debtUnits: BigNumber = ether(100);

        beforeEach(async () => {
          await debtModule.addDebt(setToken.address, setup.dai.address, debtUnits);
          await setup.dai.transfer(debtModule.address, ether(100.5));

          const [, equityFlows ] = await debtIssuance.getRequiredComponentIssuanceUnits(setToken.address, ether(1));
          await setup.weth.approve(debtIssuance.address, equityFlows[0].mul(ether(1.005)));

          subjectSetToken = setToken.address;
          subjectQuantity = ether(1);
          subjectTo = recipient.address;
          subjectCaller = owner;
        });

        async function subject(): Promise<ContractTransaction> {
          return debtIssuance.connect(subjectCaller.wallet).issue(
            subjectSetToken,
            subjectQuantity,
            subjectTo,
          );
        }

        it("should mint SetTokens to the correct addresses", async () => {
          await subject();

          const feeQuantity = preciseMulCeil(subjectQuantity, issueFee);
          const managerBalance = await setToken.balanceOf(feeRecipient.address);
          const toBalance = await setToken.balanceOf(subjectTo);

          expect(toBalance).to.eq(subjectQuantity);
          expect(managerBalance).to.eq(feeQuantity);
        });

        it("should have the correct token balances", async () => {
          const preMinterWethBalance = await setup.weth.balanceOf(subjectCaller.address);
          const preSetWethBalance = await setup.weth.balanceOf(subjectSetToken);
          const preMinterDaiBalance = await setup.dai.balanceOf(subjectCaller.address);
          const preSetDaiBalance = await setup.dai.balanceOf(subjectSetToken);
          const preExternalDaiBalance = await setup.dai.balanceOf(debtModule.address);

          await subject();

          const mintQuantity = preciseMul(subjectQuantity, ether(1).add(issueFee));
          const daiFlows = preciseMulCeil( mintQuantity, debtUnits);
          const wethFlows = preciseMul(mintQuantity, ether(1));

          const postMinterWethBalance = await setup.weth.balanceOf(subjectCaller.address);
          const postSetWethBalance = await setup.weth.balanceOf(subjectSetToken);
          const postMinterDaiBalance = await setup.dai.balanceOf(subjectCaller.address);
          const postSetDaiBalance = await setup.dai.balanceOf(subjectSetToken);
          const postExternalDaiBalance = await setup.dai.balanceOf(debtModule.address);

          expect(postMinterWethBalance).to.eq(preMinterWethBalance.sub(wethFlows));
          expect(postSetWethBalance).to.eq(preSetWethBalance.add(wethFlows));
          expect(postMinterDaiBalance).to.eq(preMinterDaiBalance.add(daiFlows));
          expect(postSetDaiBalance).to.eq(preSetDaiBalance);
          expect(postExternalDaiBalance).to.eq(preExternalDaiBalance.sub(daiFlows));
        });

        it("should have called the module issue hook", async () => {
          await subject();

          const hookCalled = await debtModule.moduleIssueHookCalled();

          expect(hookCalled).to.be.true;
        });

        it("should emit the correct SetTokenIssued event", async () => {
          const feeQuantity = preciseMulCeil(subjectQuantity, issueFee);

          await expect(subject()).to.emit(debtIssuance, "SetTokenIssued").withArgs(
            setToken.address,
            subjectCaller.address,
            subjectTo,
            preIssueHook,
            subjectQuantity,
            feeQuantity,
            ZERO
          );
        });

        describe("when an external equity position is in place", async () => {
          const externalUnits: BigNumber = ether(1);

          before(async () => {
            await externalPositionModule.addExternalPosition(setToken.address, setup.weth.address, externalUnits);
          });

          after(async () => {
            await externalPositionModule.addExternalPosition(setToken.address, setup.weth.address, ZERO);
          });

          it("should have the correct token balances", async () => {
            const preMinterWethBalance = await setup.weth.balanceOf(subjectCaller.address);
            const preSetWethBalance = await setup.weth.balanceOf(subjectSetToken);
            const preExternalWethBalance = await setup.weth.balanceOf(externalPositionModule.address);
            const preMinterDaiBalance = await setup.dai.balanceOf(subjectCaller.address);
            const preSetDaiBalance = await setup.dai.balanceOf(subjectSetToken);
            const preExternalDaiBalance = await setup.dai.balanceOf(debtModule.address);

            await subject();

            const mintQuantity = preciseMul(subjectQuantity, ether(1).add(issueFee));
            const daiFlows = preciseMulCeil(mintQuantity, debtUnits);
            const wethDefaultFlows = preciseMul(mintQuantity, ether(1));
            const wethExternalFlows = preciseMul(mintQuantity, externalUnits);

            const postMinterWethBalance = await setup.weth.balanceOf(subjectCaller.address);
            const postSetWethBalance = await setup.weth.balanceOf(subjectSetToken);
            const postExternalWethBalance = await setup.weth.balanceOf(externalPositionModule.address);
            const postMinterDaiBalance = await setup.dai.balanceOf(subjectCaller.address);
            const postSetDaiBalance = await setup.dai.balanceOf(subjectSetToken);
            const postExternalDaiBalance = await setup.dai.balanceOf(debtModule.address);

            expect(postMinterWethBalance).to.eq(preMinterWethBalance.sub(wethDefaultFlows.add(wethExternalFlows)));
            expect(postSetWethBalance).to.eq(preSetWethBalance.add(wethDefaultFlows));
            expect(postExternalWethBalance).to.eq(preExternalWethBalance.add(wethExternalFlows));
            expect(postMinterDaiBalance).to.eq(preMinterDaiBalance.add(daiFlows));
            expect(postSetDaiBalance).to.eq(preSetDaiBalance);
            expect(postExternalDaiBalance).to.eq(preExternalDaiBalance.sub(daiFlows));
          });
        });

        describe("when the manager issuance fee is 0", async () => {
          before(async () => {
            issueFee = ZERO;
          });

          after(async () => {
            issueFee = ether(0.005);
          });

          it("should mint SetTokens to the correct addresses", async () => {
            await subject();

            const toBalance = await setToken.balanceOf(subjectTo);

            expect(toBalance).to.eq(subjectQuantity);
          });

          it("should have the correct token balances", async () => {
            const preMinterWethBalance = await setup.weth.balanceOf(subjectCaller.address);
            const preSetWethBalance = await setup.weth.balanceOf(subjectSetToken);
            const preMinterDaiBalance = await setup.dai.balanceOf(subjectCaller.address);
            const preSetDaiBalance = await setup.dai.balanceOf(subjectSetToken);
            const preExternalDaiBalance = await setup.dai.balanceOf(debtModule.address);

            await subject();

            const mintQuantity = preciseMul(subjectQuantity, ether(1).add(issueFee));
            const daiFlows = preciseMulCeil(mintQuantity, debtUnits);
            const wethDefaultFlows = preciseMul(mintQuantity, ether(1));

            const postMinterWethBalance = await setup.weth.balanceOf(subjectCaller.address);
            const postSetWethBalance = await setup.weth.balanceOf(subjectSetToken);
            const postMinterDaiBalance = await setup.dai.balanceOf(subjectCaller.address);
            const postSetDaiBalance = await setup.dai.balanceOf(subjectSetToken);
            const postExternalDaiBalance = await setup.dai.balanceOf(debtModule.address);

            expect(postMinterWethBalance).to.eq(preMinterWethBalance.sub(wethDefaultFlows));
            expect(postSetWethBalance).to.eq(preSetWethBalance.add(wethDefaultFlows));
            expect(postMinterDaiBalance).to.eq(preMinterDaiBalance.add(daiFlows));
            expect(postSetDaiBalance).to.eq(preSetDaiBalance);
            expect(postExternalDaiBalance).to.eq(preExternalDaiBalance.sub(daiFlows));
          });
        });

        describe("when protocol fees are enabled", async () => {
          const protocolFee: BigNumber = ether(.2);

          beforeEach(async () => {
            await setup.controller.addFee(debtIssuance.address, ZERO, protocolFee);
          });

          it("should mint SetTokens to the correct addresses", async () => {
            await subject();

            const feeQuantity = preciseMulCeil(subjectQuantity, issueFee);
            const protocolSplit = preciseMul(feeQuantity, protocolFee);

            const managerBalance = await setToken.balanceOf(feeRecipient.address);
            const protocolBalance = await setToken.balanceOf(dummyModule.address);  // DummyModule is set as address in fixture setup
            const toBalance = await setToken.balanceOf(subjectTo);

            expect(toBalance).to.eq(subjectQuantity);
            expect(managerBalance).to.eq(feeQuantity.sub(protocolSplit));
            expect(protocolBalance).to.eq(protocolSplit);
          });
        });

        describe("when manager issuance hook is defined", async () => {
          before(async () => {
            preIssueHook = issuanceHook.address;
          });

          after(async () => {
            preIssueHook = ADDRESS_ZERO;
          });

          it("should call the issuance hook", async () => {
            await subject();

            const setToken = await issuanceHook.retrievedSetToken();

            expect(setToken).to.eq(subjectSetToken);
          });
        });

        describe("when the issue quantity is 0", async () => {
          beforeEach(async () => {
            subjectQuantity = ZERO;
          });

          it("should revert", async () => {
            await expect(subject()).to.be.revertedWith("Issue quantity must be > 0");
          });
        });

        describe("when the SetToken is not enabled on the controller", async () => {
          beforeEach(async () => {
            const nonEnabledSetToken = await setup.createNonControllerEnabledSetToken(
              [setup.weth.address],
              [ether(1)],
              [debtIssuance.address]
            );

            subjectSetToken = nonEnabledSetToken.address;
          });

          it("should revert", async () => {
            await expect(subject()).to.be.revertedWith("Must be a valid and initialized SetToken");
          });
        });
      });

      describe("#redeem", async () => {
        let subjectSetToken: Address;
        let subjectQuantity: BigNumber;
        let subjectTo: Address;
        let subjectCaller: Account;

        const debtUnits: BigNumber = ether(100);

        beforeEach(async () => {
          await debtModule.addDebt(setToken.address, setup.dai.address, debtUnits);
          await setup.dai.transfer(debtModule.address, ether(100.5));

          const [, equityFlows ] = await debtIssuance.getRequiredComponentRedemptionUnits(setToken.address, ether(1));
          await setup.weth.approve(debtIssuance.address, equityFlows[0].mul(ether(1.005)));

          await debtIssuance.issue(setToken.address, ether(1), owner.address);

          await setup.dai.approve(debtIssuance.address, ether(100.5));

          subjectSetToken = setToken.address;
          subjectQuantity = ether(1);
          subjectTo = recipient.address;
          subjectCaller = owner;
        });

        async function subject(): Promise<ContractTransaction> {
          return debtIssuance.connect(subjectCaller.wallet).redeem(
            subjectSetToken,
            subjectQuantity,
            subjectTo,
          );
        }

        it("should mint SetTokens to the correct addresses", async () => {
          const preManagerBalance = await setToken.balanceOf(feeRecipient.address);
          const preCallerBalance = await setToken.balanceOf(subjectCaller.address);

          await subject();

          const feeQuantity = preciseMulCeil(subjectQuantity, redeemFee);
          const postManagerBalance = await setToken.balanceOf(feeRecipient.address);
          const postCallerBalance = await setToken.balanceOf(subjectCaller.address);

          expect(postManagerBalance).to.eq(preManagerBalance.add(feeQuantity));
          expect(postCallerBalance).to.eq(preCallerBalance.sub(subjectQuantity));
        });

        it("should have the correct token balances", async () => {
          const preToWethBalance = await setup.weth.balanceOf(subjectTo);
          const preSetWethBalance = await setup.weth.balanceOf(subjectSetToken);
          const preRedeemerDaiBalance = await setup.dai.balanceOf(subjectCaller.address);
          const preSetDaiBalance = await setup.dai.balanceOf(subjectSetToken);
          const preExternalDaiBalance = await setup.dai.balanceOf(debtModule.address);

          await subject();

          const redeemQuantity = preciseMul(subjectQuantity, ether(1).sub(redeemFee));
          const daiFlows = preciseMulCeil(redeemQuantity, debtUnits);
          const wethFlows = preciseMul(redeemQuantity, ether(1));

          const postToWethBalance = await setup.weth.balanceOf(subjectTo);
          const postSetWethBalance = await setup.weth.balanceOf(subjectSetToken);
          const postRedeemerDaiBalance = await setup.dai.balanceOf(subjectCaller.address);
          const postSetDaiBalance = await setup.dai.balanceOf(subjectSetToken);
          const postExternalDaiBalance = await setup.dai.balanceOf(debtModule.address);

          expect(postToWethBalance).to.eq(preToWethBalance.add(wethFlows));
          expect(postSetWethBalance).to.eq(preSetWethBalance.sub(wethFlows));
          expect(postRedeemerDaiBalance).to.eq(preRedeemerDaiBalance.sub(daiFlows));
          expect(postSetDaiBalance).to.eq(preSetDaiBalance);
          expect(postExternalDaiBalance).to.eq(preExternalDaiBalance.add(daiFlows));
        });

        it("should have called the module issue hook", async () => {
          await subject();

          const hookCalled = await debtModule.moduleRedeemHookCalled();

          expect(hookCalled).to.be.true;
        });

        it("should emit the correct SetTokenRedeemed event", async () => {
          const feeQuantity = preciseMulCeil(subjectQuantity, issueFee);

          await expect(subject()).to.emit(debtIssuance, "SetTokenRedeemed").withArgs(
            setToken.address,
            subjectCaller.address,
            subjectTo,
            subjectQuantity,
            feeQuantity,
            ZERO
          );
        });

        describe("when an external equity position is in place", async () => {
          const externalUnits: BigNumber = ether(1);

          before(async () => {
            await externalPositionModule.addExternalPosition(setToken.address, setup.weth.address, externalUnits);
          });

          after(async () => {
            await externalPositionModule.addExternalPosition(setToken.address, setup.weth.address, ZERO);
          });

          it("should have the correct token balances", async () => {
            const preToWethBalance = await setup.weth.balanceOf(subjectTo);
            const preSetWethBalance = await setup.weth.balanceOf(subjectSetToken);
            const preExternalWethBalance = await setup.weth.balanceOf(externalPositionModule.address);
            const preRedeemerDaiBalance = await setup.dai.balanceOf(subjectCaller.address);
            const preSetDaiBalance = await setup.dai.balanceOf(subjectSetToken);
            const preExternalDaiBalance = await setup.dai.balanceOf(debtModule.address);

            await subject();

            const redeemQuantity = preciseMul(subjectQuantity, ether(1).sub(redeemFee));
            const daiFlows = preciseMulCeil(redeemQuantity, debtUnits);
            const wethExternalFlows = preciseMul(redeemQuantity, externalUnits);
            const wethDefaultFlows = preciseMul(redeemQuantity, ether(1));

            const postToWethBalance = await setup.weth.balanceOf(subjectTo);
            const postSetWethBalance = await setup.weth.balanceOf(subjectSetToken);
            const postExternalWethBalance = await setup.weth.balanceOf(externalPositionModule.address);
            const postRedeemerDaiBalance = await setup.dai.balanceOf(subjectCaller.address);
            const postSetDaiBalance = await setup.dai.balanceOf(subjectSetToken);
            const postExternalDaiBalance = await setup.dai.balanceOf(debtModule.address);

            expect(postToWethBalance).to.eq(preToWethBalance.add(wethExternalFlows.add(wethDefaultFlows)));
            expect(postSetWethBalance).to.eq(preSetWethBalance.sub(wethDefaultFlows));
            expect(postExternalWethBalance).to.eq(preExternalWethBalance.sub(wethExternalFlows));
            expect(postRedeemerDaiBalance).to.eq(preRedeemerDaiBalance.sub(daiFlows));
            expect(postSetDaiBalance).to.eq(preSetDaiBalance);
            expect(postExternalDaiBalance).to.eq(preExternalDaiBalance.add(daiFlows));
          });
        });

        describe("when the manager redemption fee is 0", async () => {
          before(async () => {
            redeemFee = ZERO;
          });

          after(async () => {
            redeemFee = ether(0.005);
          });

          it("should mint SetTokens to the correct addresses", async () => {
            await subject();

            const toBalance = await setToken.balanceOf(subjectTo);

            expect(toBalance).to.eq(ZERO);
          });

          it("should have the correct token balances", async () => {
            const preToWethBalance = await setup.weth.balanceOf(subjectTo);
            const preSetWethBalance = await setup.weth.balanceOf(subjectSetToken);
            const preRedeemerDaiBalance = await setup.dai.balanceOf(subjectCaller.address);
            const preSetDaiBalance = await setup.dai.balanceOf(subjectSetToken);
            const preExternalDaiBalance = await setup.dai.balanceOf(debtModule.address);

            await subject();

            const redeemQuantity = preciseMul(subjectQuantity, ether(1).sub(redeemFee));
            const daiFlows = preciseMulCeil(redeemQuantity, debtUnits);
            const wethFlows = preciseMul(redeemQuantity, ether(1));

            const postToWethBalance = await setup.weth.balanceOf(subjectTo);
            const postSetWethBalance = await setup.weth.balanceOf(subjectSetToken);
            const postRedeemerDaiBalance = await setup.dai.balanceOf(subjectCaller.address);
            const postSetDaiBalance = await setup.dai.balanceOf(subjectSetToken);
            const postExternalDaiBalance = await setup.dai.balanceOf(debtModule.address);

            expect(postToWethBalance).to.eq(preToWethBalance.add(wethFlows));
            expect(postSetWethBalance).to.eq(preSetWethBalance.sub(wethFlows));
            expect(postRedeemerDaiBalance).to.eq(preRedeemerDaiBalance.sub(daiFlows));
            expect(postSetDaiBalance).to.eq(preSetDaiBalance);
            expect(postExternalDaiBalance).to.eq(preExternalDaiBalance.add(daiFlows));
          });
        });

        describe("when protocol fees are enabled", async () => {
          const protocolFee: BigNumber = ether(.2);

          beforeEach(async () => {
            await setup.controller.addFee(debtIssuance.address, ZERO, protocolFee);
          });

          it("should mint SetTokens to the correct addresses", async () => {
            const preManagerBalance = await setToken.balanceOf(feeRecipient.address);
            const preProtocolBalance = await setToken.balanceOf(dummyModule.address);
            const preCallerBalance = await setToken.balanceOf(subjectCaller.address);

            await subject();

            const feeQuantity = preciseMulCeil(subjectQuantity, redeemFee);
            const protocolSplit = preciseMul(feeQuantity, protocolFee);

            const postManagerBalance = await setToken.balanceOf(feeRecipient.address);
            const postProtocolBalance = await setToken.balanceOf(dummyModule.address);  // DummyModule is set as address in fixture setup
            const postCallerBalance = await setToken.balanceOf(subjectCaller.address);

            expect(postCallerBalance).to.eq(preCallerBalance.sub(subjectQuantity));
            expect(postManagerBalance).to.eq(preManagerBalance.add(feeQuantity.sub(protocolSplit)));
            expect(postProtocolBalance).to.eq(preProtocolBalance.add(protocolSplit));
          });
        });

        describe("when the issue quantity is 0", async () => {
          beforeEach(async () => {
            subjectQuantity = ZERO;
          });

          it("should revert", async () => {
            await expect(subject()).to.be.revertedWith("Redeem quantity must be > 0");
          });
        });

        describe("when the SetToken is not enabled on the controller", async () => {
          beforeEach(async () => {
            const nonEnabledSetToken = await setup.createNonControllerEnabledSetToken(
              [setup.weth.address],
              [ether(1)],
              [debtIssuance.address]
            );

            subjectSetToken = nonEnabledSetToken.address;
          });

          it("should revert", async () => {
            await expect(subject()).to.be.revertedWith("Must be a valid and initialized SetToken");
          });
        });
      });

      describe("#updateFeeRecipient", async () => {
        let subjectSetToken: Address;
        let subjectNewFeeRecipient: Address;
        let subjectCaller: Account;

        beforeEach(async () => {
          subjectNewFeeRecipient = recipient.address;
          subjectSetToken = setToken.address;
          subjectCaller = manager;
        });

        async function subject(): Promise<ContractTransaction> {
          return debtIssuance.connect(subjectCaller.wallet).updateFeeRecipient(
            subjectSetToken,
            subjectNewFeeRecipient
          );
        }

        it("should have set the new fee recipient address", async () => {
          await subject();

          const settings: any = await debtIssuance.issuanceSettings(subjectSetToken);

          expect(settings.feeRecipient).to.eq(subjectNewFeeRecipient);
        });

        it("should emit the correct FeeRecipientUpdated event", async () => {
          await expect(subject()).to.emit(debtIssuance, "FeeRecipientUpdated").withArgs(
            subjectSetToken,
            subjectNewFeeRecipient
          );
        });

        describe("when fee recipient address is null address", async () => {
          beforeEach(async () => {
            subjectNewFeeRecipient = ADDRESS_ZERO;
          });

          it("should revert", async () => {
            await expect(subject()).to.be.revertedWith("Fee Recipient must be non-zero address.");
          });
        });

        describe("when fee recipient address is same address", async () => {
          beforeEach(async () => {
            subjectNewFeeRecipient = (await debtIssuance.issuanceSettings(subjectSetToken)).feeRecipient;
          });

          it("should revert", async () => {
            await expect(subject()).to.be.revertedWith("Same fee recipient passed");
          });
        });

        describe("when SetToken is not valid", async () => {
          beforeEach(async () => {
            const nonEnabledSetToken = await setup.createNonControllerEnabledSetToken(
              [setup.weth.address],
              [ether(1)],
              [debtIssuance.address],
              manager.address
            );

            subjectSetToken = nonEnabledSetToken.address;
          });

          it("should revert", async () => {
            await expect(subject()).to.be.revertedWith("Must be a valid and initialized SetToken");
          });
        });

        describe("when the caller is not the SetToken manager", async () => {
          beforeEach(async () => {
            subjectCaller = owner;
          });

          it("should revert", async () => {
            await expect(subject()).to.be.revertedWith("Must be the SetToken manager");
          });
        });
      });
    });

    describe("#updateIssueFee", async () => {
      let subjectSetToken: Address;
      let subjectNewIssueFee: BigNumber;
      let subjectCaller: Account;

      beforeEach(async () => {
        subjectNewIssueFee = ether(.01);
        subjectSetToken = setToken.address;
        subjectCaller = manager;
      });

      async function subject(): Promise<ContractTransaction> {
        return debtIssuance.connect(subjectCaller.wallet).updateIssueFee(
          subjectSetToken,
          subjectNewIssueFee
        );
      }

      it("should have set the new fee recipient address", async () => {
        await subject();

        const settings: any = await debtIssuance.issuanceSettings(subjectSetToken);

        expect(settings.managerIssueFee).to.eq(subjectNewIssueFee);
      });

      it("should emit the correct IssueFeeUpdated event", async () => {
        await expect(subject()).to.emit(debtIssuance, "IssueFeeUpdated").withArgs(
          subjectSetToken,
          subjectNewIssueFee
        );
      });

      describe("when new issue fee is greater than max fee", async () => {
        beforeEach(async () => {
          subjectNewIssueFee = ether(0.03);
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("Issue fee can't exceed maximum");
        });
      });

      describe("when issue fee is same amount", async () => {
        beforeEach(async () => {
          subjectNewIssueFee = (await debtIssuance.issuanceSettings(subjectSetToken)).managerIssueFee;
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("Same issue fee passed");
        });
      });

      describe("when SetToken is not valid", async () => {
        beforeEach(async () => {
          const nonEnabledSetToken = await setup.createNonControllerEnabledSetToken(
            [setup.weth.address],
            [ether(1)],
            [debtIssuance.address],
            manager.address
          );

          subjectSetToken = nonEnabledSetToken.address;
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("Must be a valid and initialized SetToken");
        });
      });

      describe("when the caller is not the SetToken manager", async () => {
        beforeEach(async () => {
          subjectCaller = owner;
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("Must be the SetToken manager");
        });
      });
    });

    describe("#updateRedeemFee", async () => {
      let subjectSetToken: Address;
      let subjectNewRedeemFee: BigNumber;
      let subjectCaller: Account;

      beforeEach(async () => {
        subjectNewRedeemFee = ether(.01);
        subjectSetToken = setToken.address;
        subjectCaller = manager;
      });

      async function subject(): Promise<ContractTransaction> {
        return debtIssuance.connect(subjectCaller.wallet).updateRedeemFee(
          subjectSetToken,
          subjectNewRedeemFee
        );
      }

      it("should have set the new fee recipient address", async () => {
        await subject();

        const settings: any = await debtIssuance.issuanceSettings(subjectSetToken);

        expect(settings.managerRedeemFee).to.eq(subjectNewRedeemFee);
      });

      it("should emit the correct RedeemFeeUpdated event", async () => {
        await expect(subject()).to.emit(debtIssuance, "RedeemFeeUpdated").withArgs(
          subjectSetToken,
          subjectNewRedeemFee
        );
      });

      describe("when new redeem fee is greater than max fee", async () => {
        beforeEach(async () => {
          subjectNewRedeemFee = ether(0.03);
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("Redeem fee can't exceed maximum");
        });
      });

      describe("when redeem fee is same amount", async () => {
        beforeEach(async () => {
          subjectNewRedeemFee = (await debtIssuance.issuanceSettings(subjectSetToken)).managerRedeemFee;
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("Same redeem fee passed");
        });
      });

      describe("when SetToken is not valid", async () => {
        beforeEach(async () => {
          const nonEnabledSetToken = await setup.createNonControllerEnabledSetToken(
            [setup.weth.address],
            [ether(1)],
            [debtIssuance.address],
            manager.address
          );

          subjectSetToken = nonEnabledSetToken.address;
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("Must be a valid and initialized SetToken");
        });
      });

      describe("when the caller is not the SetToken manager", async () => {
        beforeEach(async () => {
          subjectCaller = owner;
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("Must be the SetToken manager");
        });
      });
    });
  });
});
