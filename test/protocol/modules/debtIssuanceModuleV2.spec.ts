import "module-alias/register";

import { BigNumber } from "ethers";

import { Address } from "@utils/types";
import { Account } from "@utils/test/types";
import { ZERO, ONE, ADDRESS_ZERO } from "@utils/constants";
import {
  DebtIssuanceModuleV2,
  DebtModuleMock,
  ManagerIssuanceHookMock,
  ModuleIssuanceHookMock,
  SetToken,
  StandardTokenWithRoundingErrorMock
} from "@utils/contracts";
import DeployHelper from "@utils/deploys";
import {
  ether,
  preciseDiv,
  preciseMul,
  preciseMulCeil,
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

describe("DebtIssuanceModuleV2", () => {
  let owner: Account;
  let manager: Account;
  let feeRecipient: Account;
  let dummyModule: Account;
  let recipient: Account;
  let deployer: DeployHelper;
  let setup: SystemFixture;

  let debtModule: DebtModuleMock;
  let externalPositionModule: ModuleIssuanceHookMock;
  let debtIssuance: DebtIssuanceModuleV2;
  let issuanceHook: ManagerIssuanceHookMock;
  let setToken: SetToken;
  let tokenWithRoundingError: StandardTokenWithRoundingErrorMock;

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

    tokenWithRoundingError = await deployer.mocks.deployTokenWithErrorMock(owner.address, ether(1000000), ZERO);
    debtIssuance = await deployer.modules.deployDebtIssuanceModuleV2(setup.controller.address);
    debtModule = await deployer.mocks.deployDebtModuleMock(setup.controller.address);
    externalPositionModule = await deployer.mocks.deployModuleIssuanceHookMock();
    issuanceHook = await deployer.mocks.deployManagerIssuanceHookMock();

    await setup.controller.addModule(debtIssuance.address);
    await setup.controller.addModule(debtModule.address);
    await setup.controller.addModule(externalPositionModule.address);

    setToken = await setup.createSetToken(
      [tokenWithRoundingError.address],
      [ether(1)],
      [setup.issuanceModule.address, debtIssuance.address, debtModule.address, externalPositionModule.address],
      manager.address,
      "DebtToken",
      "DBT"
    );

    await externalPositionModule.initialize(setToken.address);
  });

  addSnapshotBeforeRestoreAfterEach();

  context("when DebtIssuanceModuleV2 is initialized", async () => {
    let preIssueHook: Address;
    let maxFee: BigNumber;
    let issueFee: BigNumber;
    let redeemFee: BigNumber;

    before(async () => {
      await tokenWithRoundingError.setError(ZERO);

      preIssueHook = ADDRESS_ZERO;
      maxFee = ether(0.02);
      issueFee = ether(0.005);
      redeemFee = ether(0.005);
    });

    beforeEach(async () => {
      await debtIssuance.connect(manager.wallet).initialize(
        setToken.address,
        maxFee,
        issueFee,
        redeemFee,
        feeRecipient.address,
        preIssueHook
      );
      await debtModule.connect(manager.wallet).initialize(setToken.address, debtIssuance.address);
    });


    context("when SetToken components do not have any rounding error", async () => {
      // Note: Tests below are an EXACT copy of the tests for DebtIssuanceModule. Only difference is this SetToken contains
      // tokenWithRoundingError instead of weth as a default position. This is to ensure the DebtIssuanceModuleV2 behaves
      // exactly similar to DebtIssuanceModule when there is no rounding error present in it's constituent components.

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
          await tokenWithRoundingError.approve(debtIssuance.address, equityFlows[0].mul(ether(1.005)));


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
          const preMinterWethBalance = await tokenWithRoundingError.balanceOf(subjectCaller.address);
          const preSetWethBalance = await tokenWithRoundingError.balanceOf(subjectSetToken);
          const preMinterDaiBalance = await setup.dai.balanceOf(subjectCaller.address);
          const preSetDaiBalance = await setup.dai.balanceOf(subjectSetToken);
          const preExternalDaiBalance = await setup.dai.balanceOf(debtModule.address);

          await subject();

          const mintQuantity = preciseMul(subjectQuantity, ether(1).add(issueFee));
          const daiFlows = preciseMulCeil(mintQuantity, debtUnits);
          const wethFlows = preciseMul(mintQuantity, ether(1));

          const postMinterWethBalance = await tokenWithRoundingError.balanceOf(subjectCaller.address);
          const postSetWethBalance = await tokenWithRoundingError.balanceOf(subjectSetToken);
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
            await externalPositionModule.addExternalPosition(setToken.address, tokenWithRoundingError.address, externalUnits);
          });

          after(async () => {
            await externalPositionModule.addExternalPosition(setToken.address, tokenWithRoundingError.address, ZERO);
          });

          it("should have the correct token balances", async () => {
            const preMinterWethBalance = await tokenWithRoundingError.balanceOf(subjectCaller.address);
            const preSetWethBalance = await tokenWithRoundingError.balanceOf(subjectSetToken);
            const preExternalWethBalance = await tokenWithRoundingError.balanceOf(externalPositionModule.address);
            const preMinterDaiBalance = await setup.dai.balanceOf(subjectCaller.address);
            const preSetDaiBalance = await setup.dai.balanceOf(subjectSetToken);
            const preExternalDaiBalance = await setup.dai.balanceOf(debtModule.address);

            await subject();

            const mintQuantity = preciseMul(subjectQuantity, ether(1).add(issueFee));
            const daiFlows = preciseMulCeil(mintQuantity, debtUnits);
            const wethDefaultFlows = preciseMul(mintQuantity, ether(1));
            const wethExternalFlows = preciseMul(mintQuantity, externalUnits);

            const postMinterWethBalance = await tokenWithRoundingError.balanceOf(subjectCaller.address);
            const postSetWethBalance = await tokenWithRoundingError.balanceOf(subjectSetToken);
            const postExternalWethBalance = await tokenWithRoundingError.balanceOf(externalPositionModule.address);
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
            const preMinterWethBalance = await tokenWithRoundingError.balanceOf(subjectCaller.address);
            const preSetWethBalance = await tokenWithRoundingError.balanceOf(subjectSetToken);
            const preMinterDaiBalance = await setup.dai.balanceOf(subjectCaller.address);
            const preSetDaiBalance = await setup.dai.balanceOf(subjectSetToken);
            const preExternalDaiBalance = await setup.dai.balanceOf(debtModule.address);

            await subject();

            const mintQuantity = preciseMul(subjectQuantity, ether(1).add(issueFee));
            const daiFlows = preciseMulCeil(mintQuantity, debtUnits);
            const wethDefaultFlows = preciseMul(mintQuantity, ether(1));

            const postMinterWethBalance = await tokenWithRoundingError.balanceOf(subjectCaller.address);
            const postSetWethBalance = await tokenWithRoundingError.balanceOf(subjectSetToken);
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
              [tokenWithRoundingError.address],
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
          await tokenWithRoundingError.approve(debtIssuance.address, equityFlows[0].mul(ether(1.005)));

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
          const preToWethBalance = await tokenWithRoundingError.balanceOf(subjectTo);
          const preSetWethBalance = await tokenWithRoundingError.balanceOf(subjectSetToken);
          const preRedeemerDaiBalance = await setup.dai.balanceOf(subjectCaller.address);
          const preSetDaiBalance = await setup.dai.balanceOf(subjectSetToken);
          const preExternalDaiBalance = await setup.dai.balanceOf(debtModule.address);

          await subject();

          const redeemQuantity = preciseMul(subjectQuantity, ether(1).sub(redeemFee));
          const daiFlows = preciseMulCeil(redeemQuantity, debtUnits);
          const wethFlows = preciseMul(redeemQuantity, ether(1));

          const postToWethBalance = await tokenWithRoundingError.balanceOf(subjectTo);
          const postSetWethBalance = await tokenWithRoundingError.balanceOf(subjectSetToken);
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
            await externalPositionModule.addExternalPosition(setToken.address, tokenWithRoundingError.address, externalUnits);
          });

          after(async () => {
            await externalPositionModule.addExternalPosition(setToken.address, tokenWithRoundingError.address, ZERO);
          });

          it("should have the correct token balances", async () => {
            const preToWethBalance = await tokenWithRoundingError.balanceOf(subjectTo);
            const preSetWethBalance = await tokenWithRoundingError.balanceOf(subjectSetToken);
            const preExternalWethBalance = await tokenWithRoundingError.balanceOf(externalPositionModule.address);
            const preRedeemerDaiBalance = await setup.dai.balanceOf(subjectCaller.address);
            const preSetDaiBalance = await setup.dai.balanceOf(subjectSetToken);
            const preExternalDaiBalance = await setup.dai.balanceOf(debtModule.address);

            await subject();

            const redeemQuantity = preciseMul(subjectQuantity, ether(1).sub(redeemFee));
            const daiFlows = preciseMulCeil(redeemQuantity, debtUnits);
            const wethExternalFlows = preciseMul(redeemQuantity, externalUnits);
            const wethDefaultFlows = preciseMul(redeemQuantity, ether(1));

            const postToWethBalance = await tokenWithRoundingError.balanceOf(subjectTo);
            const postSetWethBalance = await tokenWithRoundingError.balanceOf(subjectSetToken);
            const postExternalWethBalance = await tokenWithRoundingError.balanceOf(externalPositionModule.address);
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
            const preToWethBalance = await tokenWithRoundingError.balanceOf(subjectTo);
            const preSetWethBalance = await tokenWithRoundingError.balanceOf(subjectSetToken);
            const preRedeemerDaiBalance = await setup.dai.balanceOf(subjectCaller.address);
            const preSetDaiBalance = await setup.dai.balanceOf(subjectSetToken);
            const preExternalDaiBalance = await setup.dai.balanceOf(debtModule.address);

            await subject();

            const redeemQuantity = preciseMul(subjectQuantity, ether(1).sub(redeemFee));
            const daiFlows = preciseMulCeil(redeemQuantity, debtUnits);
            const wethFlows = preciseMul(redeemQuantity, ether(1));

            const postToWethBalance = await tokenWithRoundingError.balanceOf(subjectTo);
            const postSetWethBalance = await tokenWithRoundingError.balanceOf(subjectSetToken);
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
              [tokenWithRoundingError.address],
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

      describe("#getRequiredComponentIssuanceUnits", async () => {
        let subjectSetToken: Address;
        let subjectQuantity: BigNumber;

        const debtUnits: BigNumber = ether(100);

        beforeEach(async () => {
          await debtModule.addDebt(setToken.address, setup.dai.address, debtUnits);
          await setup.dai.transfer(debtModule.address, ether(100.5));

          const [, equityFlows ] = await debtIssuance.getRequiredComponentIssuanceUnits(setToken.address, ether(1));
          await tokenWithRoundingError.approve(debtIssuance.address, equityFlows[0].mul(ether(1.005)));

          subjectSetToken = setToken.address;
          subjectQuantity = ether(1);

          await debtIssuance.issue(subjectSetToken, subjectQuantity, owner.address);
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
            await externalPositionModule.addExternalPosition(setToken.address, tokenWithRoundingError.address, externalUnits);
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
          const externalUnits: BigNumber = ether(50);

          beforeEach(async () => {
            await externalPositionModule.addExternalPosition(setToken.address, setup.dai.address, externalUnits);
          });

          it("should return the correct issue token amounts", async () => {
            const [components, equityFlows, debtFlows] = await subject();

            const mintQuantity = preciseMul(subjectQuantity, ether(1).add(issueFee));
            const daiDebtFlows = preciseMulCeil(mintQuantity, debtUnits);
            const wethFlows = preciseMul(mintQuantity, ether(1));
            const daiEquityFlows = preciseMul(mintQuantity, externalUnits);

            const expectedComponents = await setToken.getComponents();
            const expectedEquityFlows = [wethFlows, daiEquityFlows];
            const expectedDebtFlows = [ZERO, daiDebtFlows];

            expect(JSON.stringify(expectedComponents)).to.eq(JSON.stringify(components));
            expect(JSON.stringify(expectedEquityFlows)).to.eq(JSON.stringify(equityFlows));
            expect(JSON.stringify(expectedDebtFlows)).to.eq(JSON.stringify(debtFlows));
          });
        });
      });
    });

    context("when SetToken components do have rounding errors", async () => {
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
          // send exact amount
          await tokenWithRoundingError.approve(debtIssuance.address, equityFlows[0]);

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

        describe("when rounding error is negative one", async () => {
          beforeEach(async () => {
            await tokenWithRoundingError.setError(BigNumber.from(-1));
          });

          describe("when set is exactly collateralized", async () => {
            it("should revert", async () => {
              await expect(subject()).to.be.revertedWith(
                "Invalid transfer in. Results in undercollateralization"
              );
            });
          });

          describe("when set is over-collateralized by at least 1 wei", async () => {
            beforeEach(async () => {
              await tokenWithRoundingError.connect(owner.wallet).transfer(setToken.address, ONE);
            });

            it("should mint SetTokens to the correct addresses", async () => {
              await subject();

              const feeQuantity = preciseMulCeil(subjectQuantity, issueFee);
              const managerBalance = await setToken.balanceOf(feeRecipient.address);
              const toBalance = await setToken.balanceOf(subjectTo);

              expect(toBalance).to.eq(subjectQuantity);
              expect(managerBalance).to.eq(feeQuantity);
            });
          });
        });

        describe("when rounding error is positive one", async () => {
          beforeEach(async () => {
            await tokenWithRoundingError.setError(ONE);
          });

          describe("when set is exactly collateralized", async () => {
            it("should mint SetTokens to the correct addresses", async () => {
              await subject();

              const feeQuantity = preciseMulCeil(subjectQuantity, issueFee);
              const managerBalance = await setToken.balanceOf(feeRecipient.address);
              const toBalance = await setToken.balanceOf(subjectTo);

              expect(toBalance).to.eq(subjectQuantity);
              expect(managerBalance).to.eq(feeQuantity);
            });
          });

          describe("when set is over-collateralized by at least 1 wei", async () => {
            beforeEach(async () => {
              await tokenWithRoundingError.connect(owner.wallet).transfer(setToken.address, ONE);
            });
            it("should mint SetTokens to the correct addresses", async () => {
              await subject();

              const feeQuantity = preciseMulCeil(subjectQuantity, issueFee);
              const managerBalance = await setToken.balanceOf(feeRecipient.address);
              const toBalance = await setToken.balanceOf(subjectTo);

              expect(toBalance).to.eq(subjectQuantity);
              expect(managerBalance).to.eq(feeQuantity);
            });
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

          const [, equityFlows ] = await debtIssuance.getRequiredComponentIssuanceUnits(setToken.address, ether(1));
          // Send exact amount
          await tokenWithRoundingError.approve(debtIssuance.address, equityFlows[0]);

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

        describe("when rounding error is negative one", async () => {
          beforeEach(async () => {
            await tokenWithRoundingError.setError(BigNumber.from(-1));
          });

          describe("when set is exactly collateralized", async () => {
            it("should revert", async () => {
              await expect(subject()).to.be.revertedWith(
                "Invalid transfer out. Results in undercollateralization"
              );
            });
          });

          describe("when set is over-collateralized by at least 1 wei", async () => {
            beforeEach(async () => {
              await tokenWithRoundingError.connect(owner.wallet).transfer(setToken.address, ONE);
            });
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
          });
        });

        describe("when rounding error is positive one", async () => {
          beforeEach(async () => {
            await tokenWithRoundingError.setError(ONE);
          });

          describe("when set is exactly collateralized", async () => {
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
          });

          describe("when set is over-collateralized by at least 1 wei", async () => {
            beforeEach(async () => {
              await tokenWithRoundingError.connect(owner.wallet).transfer(setToken.address, ONE);
            });

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
          });
        });
      });

      describe("#getRequiredComponentIssuanceUnits", async () => {
        let subjectSetToken: Address;
        let subjectQuantity: BigNumber;

        const debtUnits: BigNumber = ether(100);
        const accruedBalance = ether(.00001);

        beforeEach(async () => {
          await debtModule.addDebt(setToken.address, setup.dai.address, debtUnits);
          await setup.dai.transfer(debtModule.address, ether(100.5));

          subjectSetToken = setToken.address;
          subjectQuantity = ether(1);

          await tokenWithRoundingError.setError(accruedBalance);
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
          const daiFlows = preciseMulCeil(mintQuantity, debtUnits);
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
            await externalPositionModule.addExternalPosition(setToken.address, tokenWithRoundingError.address, externalUnits);
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
          const externalUnits: BigNumber = ether(50);

          beforeEach(async () => {
            await externalPositionModule.addExternalPosition(setToken.address, setup.dai.address, externalUnits);
          });

          it("should return the correct issue token amounts", async () => {
            const [components, equityFlows, debtFlows] = await subject();

            const mintQuantity = preciseMul(subjectQuantity, ether(1).add(issueFee));
            const daiDebtFlows = preciseMulCeil(mintQuantity, debtUnits);
            const wethFlows = preciseMul(mintQuantity, ether(1));
            const daiEquityFlows = preciseMul(mintQuantity, externalUnits);

            const expectedComponents = await setToken.getComponents();
            const expectedEquityFlows = [wethFlows, daiEquityFlows];
            const expectedDebtFlows = [ZERO, daiDebtFlows];

            expect(JSON.stringify(expectedComponents)).to.eq(JSON.stringify(components));
            expect(JSON.stringify(expectedEquityFlows)).to.eq(JSON.stringify(equityFlows));
            expect(JSON.stringify(expectedDebtFlows)).to.eq(JSON.stringify(debtFlows));
          });
        });

        describe("when tokens have been issued", async () => {
          beforeEach(async () => {
            const [, equityFlows ] = await debtIssuance.getRequiredComponentIssuanceUnits(setToken.address, ether(1));
            await tokenWithRoundingError.approve(debtIssuance.address, equityFlows[0].mul(ether(1.005)));

            await debtIssuance.issue(subjectSetToken, subjectQuantity, owner.address);
          });

          it("should return the correct issue token amounts", async () => {
            const [components, equityFlows, debtFlows] = await subject();

            const mintQuantity = preciseMul(subjectQuantity, ether(1).add(issueFee));
            const daiFlows = preciseMul(mintQuantity, debtUnits);
            const wethFlows = preciseMulCeil(mintQuantity, preciseDiv(ether(1.005).add(accruedBalance), ether(1.005)));

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
              await externalPositionModule.addExternalPosition(setToken.address, tokenWithRoundingError.address, externalUnits);
            });

            it("should return the correct issue token amounts", async () => {
              const [components, equityFlows, debtFlows] = await subject();

              const mintQuantity = preciseMul(subjectQuantity, ether(1).add(issueFee));
              const daiFlows = preciseMulCeil( mintQuantity, debtUnits);
              const wethFlows = preciseMulCeil(mintQuantity, preciseDiv(ether(1.005).add(accruedBalance), ether(1.005)).add(externalUnits));

              const expectedComponents = await setToken.getComponents();
              const expectedEquityFlows = [wethFlows, ZERO];
              const expectedDebtFlows = [ZERO, daiFlows];

              expect(JSON.stringify(expectedComponents)).to.eq(JSON.stringify(components));
              expect(JSON.stringify(expectedEquityFlows)).to.eq(JSON.stringify(equityFlows));
              expect(JSON.stringify(expectedDebtFlows)).to.eq(JSON.stringify(debtFlows));
            });
          });
        });
      });
    });
  });
});
