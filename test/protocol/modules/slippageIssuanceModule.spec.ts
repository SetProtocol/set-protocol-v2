import "module-alias/register";

import { BigNumber } from "ethers";

import { Address } from "@utils/types";
import { Account } from "@utils/test/types";
import { ZERO, ADDRESS_ZERO } from "@utils/constants";
import { SlippageIssuanceModule, DebtModuleMock, ModuleIssuanceHookMock, SetToken, ManagerIssuanceHookMock } from "@utils/contracts";
import DeployHelper from "@utils/deploys";
import {
  ether,
  preciseMul,
  preciseMulCeil,
  bitcoin,
  usdc,
} from "@utils/index";
import {
  addSnapshotBeforeRestoreAfterEach,
  getAccounts,
  getSystemFixture,
  getWaffleExpect,
} from "@utils/test/index";
import { SystemFixture } from "@utils/fixtures";
import { ContractTransaction } from "ethers";

const expect = getWaffleExpect();

describe("SlippageIssuanceModule", () => {
  let owner: Account;
  let manager: Account;
  let feeRecipient: Account;
  let dummyModule: Account;
  let recipient: Account;
  let deployer: DeployHelper;
  let setup: SystemFixture;

  let debtModule: DebtModuleMock;
  let externalPositionModule: ModuleIssuanceHookMock;
  let slippageIssuance: SlippageIssuanceModule;
  let issuanceHook: ManagerIssuanceHookMock;
  let setToken: SetToken;

  let preIssueHook: Address;
  let initialize: boolean;
  let maxFee: BigNumber;
  let issueFee: BigNumber;
  let redeemFee: BigNumber;

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

    debtModule = await deployer.mocks.deployDebtModuleMock(setup.controller.address);
    slippageIssuance = await deployer.modules.deploySlippageIssuanceModule(setup.controller.address);
    externalPositionModule = await deployer.mocks.deployModuleIssuanceHookMock();
    issuanceHook = await deployer.mocks.deployManagerIssuanceHookMock();

    await setup.controller.addModule(slippageIssuance.address);
    await setup.controller.addModule(debtModule.address);
    await setup.controller.addModule(externalPositionModule.address);

    setToken = await setup.createSetToken(
      [setup.weth.address],
      [ether(1)],
      [setup.issuanceModule.address, slippageIssuance.address, debtModule.address, externalPositionModule.address],
      manager.address,
      "DebtToken",
      "DBT"
    );

    await externalPositionModule.initialize(setToken.address);

    preIssueHook = ADDRESS_ZERO;
    initialize = true;
    maxFee = ether(0.02);
    issueFee = ether(0.005);
    redeemFee = ether(0.005);
  });

  addSnapshotBeforeRestoreAfterEach();

  context("External debt module has been registered with SlippageIssuanceModule", async () => {
    beforeEach(async () => {
      if (initialize) {
        await slippageIssuance.connect(manager.wallet).initialize(
          setToken.address,
          maxFee,
          issueFee,
          redeemFee,
          feeRecipient.address,
          preIssueHook
        );
      }

      await debtModule.connect(manager.wallet).initialize(setToken.address, slippageIssuance.address);
    });

    describe("#getRequiredComponentIssuanceUnitsOffChain", async () => {
      let subjectSetToken: Address;
      let subjectQuantity: BigNumber;

      const debtUnits: BigNumber = ether(100);

      beforeEach(async () => {
        await debtModule.addDebt(setToken.address, setup.dai.address, debtUnits);

        subjectSetToken = setToken.address;
        subjectQuantity = ether(1);
      });

      async function subject(): Promise<any> {
        return slippageIssuance.callStatic.getRequiredComponentIssuanceUnitsOffChain(
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

      describe("when positional adjustments are needed to account for positions changed during issuance", async () => {
        let ethIssuanceAdjustment: BigNumber;
        let daiDebtAdjustment: BigNumber;

        beforeEach(async () => {
          await debtModule.addEquityIssuanceAdjustment(setup.weth.address, ethIssuanceAdjustment);
          await debtModule.addDebtIssuanceAdjustment(setup.dai.address, daiDebtAdjustment);
        });

        describe("when positional adjustments are positive numbers", async () => {
          before(async () => {
            ethIssuanceAdjustment = ether(0.01);
            daiDebtAdjustment = ether(1.5);
          });

          after(async () => {
            ethIssuanceAdjustment = ZERO;
            daiDebtAdjustment = ZERO;
          });

          it("should return the correct issue token amounts", async () => {
            const [components, equityFlows, debtFlows] = await subject();

            const mintQuantity = preciseMul(subjectQuantity, ether(1).add(issueFee));
            const daiFlows = preciseMulCeil(mintQuantity, debtUnits.sub(daiDebtAdjustment));
            const wethFlows = preciseMul(mintQuantity, ether(1).add(ethIssuanceAdjustment));

            const expectedComponents = await setToken.getComponents();
            const expectedEquityFlows = [wethFlows, ZERO];
            const expectedDebtFlows = [ZERO, daiFlows];

            expect(JSON.stringify(expectedComponents)).to.eq(JSON.stringify(components));
            expect(JSON.stringify(expectedEquityFlows)).to.eq(JSON.stringify(equityFlows));
            expect(JSON.stringify(expectedDebtFlows)).to.eq(JSON.stringify(debtFlows));
          });
        });

        describe("when positional adjustments are negative numbers", async () => {
          before(async () => {
            ethIssuanceAdjustment = ether(0.01).mul(-1);
            daiDebtAdjustment = ether(1.5).mul(-1);
          });

          after(async () => {
            ethIssuanceAdjustment = ZERO;
            daiDebtAdjustment = ZERO;
          });

          it("should return the correct issue token amounts", async () => {
            const [components, equityFlows, debtFlows] = await subject();

            const mintQuantity = preciseMul(subjectQuantity, ether(1).add(issueFee));
            const daiFlows = preciseMulCeil(mintQuantity, debtUnits.sub(daiDebtAdjustment));
            const wethFlows = preciseMul(mintQuantity, ether(1).add(ethIssuanceAdjustment));

            const expectedComponents = await setToken.getComponents();
            const expectedEquityFlows = [wethFlows, ZERO];
            const expectedDebtFlows = [ZERO, daiFlows];

            expect(JSON.stringify(expectedComponents)).to.eq(JSON.stringify(components));
            expect(JSON.stringify(expectedEquityFlows)).to.eq(JSON.stringify(equityFlows));
            expect(JSON.stringify(expectedDebtFlows)).to.eq(JSON.stringify(debtFlows));
          });
        });

        describe("when equity positional adjustments lead to negative results", async () => {
          before(async () => {
            ethIssuanceAdjustment = ether(1.1).mul(-1);
          });

          after(async () => {
            ethIssuanceAdjustment = ZERO;
            daiDebtAdjustment = ZERO;
          });

          it("should revert", async () => {
            await expect(subject()).to.be.revertedWith("SafeCast: value must be positive");
          });
        });

        describe("when debt positional adjustments lead to negative results", async () => {
          before(async () => {
            daiDebtAdjustment = ether(101);
          });

          after(async () => {
            ethIssuanceAdjustment = ZERO;
            daiDebtAdjustment = ZERO;
          });

          it("should revert", async () => {
            await expect(subject()).to.be.revertedWith("SafeCast: value must be positive");
          });
        });
      });
    });

    describe("#getRequiredComponentRedemptionUnitsOffChain", async () => {
      let subjectSetToken: Address;
      let subjectQuantity: BigNumber;

      const debtUnits: BigNumber = ether(100);

      beforeEach(async () => {
        await debtModule.addDebt(setToken.address, setup.dai.address, debtUnits);

        subjectSetToken = setToken.address;
        subjectQuantity = ether(1);
      });

      async function subject(): Promise<any> {
        return slippageIssuance.callStatic.getRequiredComponentRedemptionUnitsOffChain(
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

      describe("when positional adjustments are needed to account for positions changed during redemption", async () => {
        let ethIssuanceAdjustment: BigNumber;
        let daiDebtAdjustment: BigNumber;

        beforeEach(async () => {
          await debtModule.addEquityIssuanceAdjustment(setup.weth.address, ethIssuanceAdjustment);
          await debtModule.addDebtIssuanceAdjustment(setup.dai.address, daiDebtAdjustment);
        });

        describe("when positional adjustments are positive numbers", async () => {
          before(async () => {
            ethIssuanceAdjustment = ether(0.01);
            daiDebtAdjustment = ether(1.5);
          });

          it("should return the correct issue token amounts", async () => {
            const [components, equityFlows, debtFlows] = await subject();

            const mintQuantity = preciseMul(subjectQuantity, ether(1).sub(issueFee));
            const daiFlows = preciseMulCeil(mintQuantity, debtUnits.sub(daiDebtAdjustment));
            const wethFlows = preciseMul(mintQuantity, ether(1).add(ethIssuanceAdjustment));

            const expectedComponents = await setToken.getComponents();
            const expectedEquityFlows = [wethFlows, ZERO];
            const expectedDebtFlows = [ZERO, daiFlows];

            expect(JSON.stringify(expectedComponents)).to.eq(JSON.stringify(components));
            expect(JSON.stringify(expectedEquityFlows)).to.eq(JSON.stringify(equityFlows));
            expect(JSON.stringify(expectedDebtFlows)).to.eq(JSON.stringify(debtFlows));
          });
        });

        describe("when positional adjustments are negative numbers", async () => {
          before(async () => {
            ethIssuanceAdjustment = ether(0.01).mul(-1);
            daiDebtAdjustment = ether(1.5).mul(-1);
          });

          it("should return the correct issue token amounts", async () => {
            const [components, equityFlows, debtFlows] = await subject();

            const mintQuantity = preciseMul(subjectQuantity, ether(1).sub(issueFee));
            const daiFlows = preciseMulCeil(mintQuantity, debtUnits.sub(daiDebtAdjustment));
            const wethFlows = preciseMul(mintQuantity, ether(1).add(ethIssuanceAdjustment));

            const expectedComponents = await setToken.getComponents();
            const expectedEquityFlows = [wethFlows, ZERO];
            const expectedDebtFlows = [ZERO, daiFlows];

            expect(JSON.stringify(expectedComponents)).to.eq(JSON.stringify(components));
            expect(JSON.stringify(expectedEquityFlows)).to.eq(JSON.stringify(equityFlows));
            expect(JSON.stringify(expectedDebtFlows)).to.eq(JSON.stringify(debtFlows));
          });
        });

        describe("when equity positional adjustments lead to negative results", async () => {
          before(async () => {
            ethIssuanceAdjustment = ether(1.1).mul(-1);
          });

          after(async () => {
            ethIssuanceAdjustment = ZERO;
            daiDebtAdjustment = ZERO;
          });

          it("should revert", async () => {
            await expect(subject()).to.be.revertedWith("SafeCast: value must be positive");
          });
        });

        describe("when debt positional adjustments lead to negative results", async () => {
          before(async () => {
            daiDebtAdjustment = ether(101);
          });

          after(async () => {
            ethIssuanceAdjustment = ZERO;
            daiDebtAdjustment = ZERO;
          });

          it("should revert", async () => {
            await expect(subject()).to.be.revertedWith("SafeCast: value must be positive");
          });
        });
      });
    });

    describe("#issueWithSlippage", async () => {
      let subjectSetToken: Address;
      let subjectQuantity: BigNumber;
      let subjectCheckedComponents: Address[];
      let subjectMaxTokenAmountsIn: BigNumber[];
      let subjectTo: Address;
      let subjectCaller: Account;

      const debtUnits: BigNumber = ether(100);

      beforeEach(async () => {
        await debtModule.addDebt(setToken.address, setup.dai.address, debtUnits);
        await setup.dai.transfer(debtModule.address, ether(100.5));

        const [, equityFlows ] = await slippageIssuance
          .callStatic
          .getRequiredComponentIssuanceUnitsOffChain(setToken.address, ether(1));

        await setup.weth.approve(slippageIssuance.address, equityFlows[0].mul(ether(1.005)));

        subjectSetToken = setToken.address;
        subjectQuantity = ether(1);
        subjectCheckedComponents = [];
        subjectMaxTokenAmountsIn = [];
        subjectTo = recipient.address;
        subjectCaller = owner;
      });

      async function subject(): Promise<ContractTransaction> {
        return slippageIssuance.connect(subjectCaller.wallet).issueWithSlippage(
          subjectSetToken,
          subjectQuantity,
          subjectCheckedComponents,
          subjectMaxTokenAmountsIn,
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

        await expect(subject()).to.emit(slippageIssuance, "SetTokenIssued").withArgs(
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
          await setup.controller.addFee(slippageIssuance.address, ZERO, protocolFee);
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

      describe("when a max token amount in is submitted", async () => {
        beforeEach(async () => {
          const mintQuantity = preciseMul(subjectQuantity, ether(1).add(issueFee));
          const expectedWethFlows = preciseMul(mintQuantity, ether(1));

          subjectCheckedComponents = [setup.weth.address];
          subjectMaxTokenAmountsIn = [expectedWethFlows];
        });

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

        describe("but the required amount exceeds the max limit set", async () => {
          beforeEach(async () => {
            const mintQuantity = preciseMul(subjectQuantity, ether(1).add(issueFee));
            const expectedWethFlows = preciseMul(mintQuantity, ether(1));

            subjectCheckedComponents = [setup.weth.address];
            subjectMaxTokenAmountsIn = [expectedWethFlows.sub(1)];
          });

          it("should revert", async () => {
            await expect(subject()).to.be.revertedWith("Too many tokens required for issuance");
          });
        });

        describe("but a specified component isn't part of the Set", async () => {
          beforeEach(async () => {
            subjectCheckedComponents = [setup.usdc.address];
            subjectMaxTokenAmountsIn = [usdc(100)];
          });

          it("should revert", async () => {
            await expect(subject()).to.be.revertedWith("Limit passed for invalid component");
          });
        });

        describe("but the array lengths mismatch", async () => {
          beforeEach(async () => {
            subjectCheckedComponents = [setup.weth.address];
            subjectMaxTokenAmountsIn = [];
          });

          it("should revert", async () => {
            await expect(subject()).to.be.revertedWith("Array length mismatch");
          });
        });

        describe("but there are duplicates in the components array", async () => {
          beforeEach(async () => {
            subjectCheckedComponents = [setup.weth.address, setup.weth.address];
            subjectMaxTokenAmountsIn = [ether(1), ether(1)];
          });

          it("should revert", async () => {
            await expect(subject()).to.be.revertedWith("Cannot duplicate addresses");
          });
        });
      });

      describe("when the issue quantity is 0", async () => {
        beforeEach(async () => {
          subjectQuantity = ZERO;
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("SetToken quantity must be > 0");
        });
      });

      describe("when the SetToken is not enabled on the controller", async () => {
        beforeEach(async () => {
          const nonEnabledSetToken = await setup.createNonControllerEnabledSetToken(
            [setup.weth.address],
            [ether(1)],
            [slippageIssuance.address]
          );

          subjectSetToken = nonEnabledSetToken.address;
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("Must be a valid and initialized SetToken");
        });
      });
    });

    describe("#redeemWithSlippage", async () => {
      let subjectSetToken: Address;
      let subjectQuantity: BigNumber;
      let subjectCheckedComponents: Address[];
      let subjectMinTokenAmountsOut: BigNumber[];
      let subjectTo: Address;
      let subjectCaller: Account;

      const debtUnits: BigNumber = ether(100);

      beforeEach(async () => {
        await debtModule.addDebt(setToken.address, setup.dai.address, debtUnits);
        await setup.dai.transfer(debtModule.address, ether(100.5));

        const [, equityFlows ] = await slippageIssuance
          .callStatic
          .getRequiredComponentRedemptionUnitsOffChain(setToken.address, ether(1));

        await setup.weth.approve(slippageIssuance.address, equityFlows[0].mul(ether(1.005)));

        await slippageIssuance.issue(setToken.address, ether(1), owner.address);

        await setup.dai.approve(slippageIssuance.address, ether(100.5));

        subjectSetToken = setToken.address;
        subjectQuantity = ether(1);
        subjectCheckedComponents = [];
        subjectMinTokenAmountsOut = [];
        subjectTo = recipient.address;
        subjectCaller = owner;
      });

      async function subject(): Promise<ContractTransaction> {
        return slippageIssuance.connect(subjectCaller.wallet).redeemWithSlippage(
          subjectSetToken,
          subjectQuantity,
          subjectCheckedComponents,
          subjectMinTokenAmountsOut,
          subjectTo,
        );
      }

      it("should redeem SetTokens to the correct addresses", async () => {
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

        await expect(subject()).to.emit(slippageIssuance, "SetTokenRedeemed").withArgs(
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
          await setup.controller.addFee(slippageIssuance.address, ZERO, protocolFee);
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

      describe("when a min token amount out is submitted", async () => {
        beforeEach(async () => {
          const mintQuantity = preciseMul(subjectQuantity, ether(1).sub(issueFee));
          const expectedWethFlows = preciseMul(mintQuantity, ether(1));

          subjectCheckedComponents = [setup.weth.address];
          subjectMinTokenAmountsOut = [expectedWethFlows];
        });

        it("should redeem SetTokens to the correct addresses", async () => {
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

        describe("but the returned amount isn't enough", async () => {
          beforeEach(async () => {
            const mintQuantity = preciseMul(subjectQuantity, ether(1).add(issueFee));
            const expectedWethFlows = preciseMul(mintQuantity, ether(1));

            subjectCheckedComponents = [setup.weth.address];
            subjectMinTokenAmountsOut = [expectedWethFlows.add(1)];
          });

          it("should revert", async () => {
            await expect(subject()).to.be.revertedWith("Too few tokens returned for redemption");
          });
        });

        describe("but a specified component isn't part of the Set", async () => {
          beforeEach(async () => {
            subjectCheckedComponents = [setup.usdc.address];
            subjectMinTokenAmountsOut = [usdc(100)];
          });

          it("should revert", async () => {
            await expect(subject()).to.be.revertedWith("Limit passed for invalid component");
          });
        });

        describe("but the array lengths mismatch", async () => {
          beforeEach(async () => {
            subjectCheckedComponents = [setup.weth.address];
            subjectMinTokenAmountsOut = [];
          });

          it("should revert", async () => {
            await expect(subject()).to.be.revertedWith("Array length mismatch");
          });
        });

        describe("but there are duplicated in the components array", async () => {
          beforeEach(async () => {
            subjectCheckedComponents = [setup.weth.address, setup.weth.address];
            subjectMinTokenAmountsOut = [ether(1), ether(1)];
          });

          it("should revert", async () => {
            await expect(subject()).to.be.revertedWith("Cannot duplicate addresses");
          });
        });
      });

      describe("when the redeem quantity is 0", async () => {
        beforeEach(async () => {
          subjectQuantity = ZERO;
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("SetToken quantity must be > 0");
        });
      });

      describe("when the SetToken is not enabled on the controller", async () => {
        beforeEach(async () => {
          const nonEnabledSetToken = await setup.createNonControllerEnabledSetToken(
            [setup.weth.address],
            [ether(1)],
            [slippageIssuance.address]
          );

          subjectSetToken = nonEnabledSetToken.address;
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("Must be a valid and initialized SetToken");
        });
      });
    });
  });
});
