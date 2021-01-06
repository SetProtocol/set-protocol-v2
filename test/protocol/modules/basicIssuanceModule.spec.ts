import "module-alias/register";
import { BigNumber } from "@ethersproject/bignumber";

import { Address, Account } from "@utils/types";
import { ADDRESS_ZERO, ZERO, ONE } from "@utils/constants";
import { BasicIssuanceModule, ManagerIssuanceHookMock, SetToken } from "@utils/contracts";
import DeployHelper from "@utils/deploys";
import {
  addSnapshotBeforeRestoreAfterEach,
  bitcoin,
  ether,
  getAccounts,
  getRandomAccount,
  getRandomAddress,
  getWaffleExpect,
  getSystemFixture,
} from "@utils/index";
import { SystemFixture } from "@utils/fixtures";

const expect = getWaffleExpect();

describe("BasicIssuanceModule", () => {
  let owner: Account;
  let recipient: Account;
  let deployer: DeployHelper;
  let setup: SystemFixture;

  let issuanceModule: BasicIssuanceModule;

  before(async () => {
    [
      owner,
      recipient,
    ] = await getAccounts();

    deployer = new DeployHelper(owner.wallet);
    setup = getSystemFixture(owner.address);
    await setup.initialize();

    issuanceModule = await deployer.modules.deployBasicIssuanceModule(setup.controller.address);
    await setup.controller.addModule(issuanceModule.address);
  });

  addSnapshotBeforeRestoreAfterEach();

  describe("#initialize", async () => {
    let setToken: SetToken;
    let subjectSetToken: Address;
    let subjectPreIssuanceHook: Address;
    let subjectCaller: Account;

    beforeEach(async () => {
      setToken = await setup.createSetToken(
        [setup.weth.address],
        [ether(1)],
        [issuanceModule.address]
      );
      subjectSetToken = setToken.address;
      subjectPreIssuanceHook = await getRandomAddress();
      subjectCaller = owner;
    });

    async function subject(): Promise<any> {
      return issuanceModule.connect(subjectCaller.wallet).initialize(
        subjectSetToken,
        subjectPreIssuanceHook,
      );
    }

    it("should enable the Module on the SetToken", async () => {
      await subject();
      const isModuleEnabled = await setToken.isInitializedModule(issuanceModule.address);
      expect(isModuleEnabled).to.eq(true);
    });

    it("should properly set the issuance hooks", async () => {
      await subject();
      const preIssuanceHooks = await issuanceModule.managerIssuanceHook(subjectSetToken);
      expect(preIssuanceHooks).to.eq(subjectPreIssuanceHook);
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
          [newModule]
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
          [issuanceModule.address]
        );

        subjectSetToken = nonEnabledSetToken.address;
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Must be controller-enabled SetToken");
      });
    });
  });

  describe("#removeModule", async () => {
    let subjectCaller: Account;

    beforeEach(async () => {
      subjectCaller = owner;
    });

    async function subject(): Promise<any> {
      return issuanceModule.connect(subjectCaller.wallet).removeModule();
    }

    it("should revert", async () => {
      await expect(subject()).to.be.revertedWith("The BasicIssuanceModule module cannot be removed");
    });
  });

  describe("#issue", async () => {
    let setToken: SetToken;

    let subjectSetToken: Address;
    let subjectIssueQuantity: BigNumber;
    let subjectTo: Account;
    let subjectCaller: Account;

    let preIssueHook: Address;

    context("when the components are WBTC and WETH", async () => {
      beforeEach(async () => {
        setToken = await setup.createSetToken(
          [setup.weth.address, setup.wbtc.address],
          [ether(1), bitcoin(2)],
          [issuanceModule.address]
        );
        await issuanceModule.initialize(setToken.address, preIssueHook);

        // Approve tokens to the issuance mdoule
        await setup.weth.approve(issuanceModule.address, ether(5));
        await setup.wbtc.approve(issuanceModule.address, bitcoin(10));

        subjectSetToken = setToken.address;
        subjectIssueQuantity = ether(2);
        subjectTo = recipient;
        subjectCaller = owner;
      });

      context("when there are no hooks", async () => {
        before(async () => {
          preIssueHook = ADDRESS_ZERO;
        });

        async function subject(): Promise<any> {
          return issuanceModule.connect(subjectCaller.wallet).issue(
            subjectSetToken,
            subjectIssueQuantity,
            subjectTo.address
          );
        }

        it("should issue the Set to the recipient", async () => {
          await subject();
          const issuedBalance = await setToken.balanceOf(recipient.address);
          expect(issuedBalance).to.eq(subjectIssueQuantity);
        });

        it("should have deposited the components into the SetToken", async () => {
          await subject();
          const depositedWETHBalance = await setup.weth.balanceOf(setToken.address);
          const expectedBTCBalance = subjectIssueQuantity;
          expect(depositedWETHBalance).to.eq(expectedBTCBalance);

          const depositedBTCBalance = await setup.wbtc.balanceOf(setToken.address);
          const expectedBalance = subjectIssueQuantity.mul(bitcoin(2)).div(ether(1));
          expect(depositedBTCBalance).to.eq(expectedBalance);
        });

        it("should emit the SetTokenIssued event", async () => {
          await expect(subject()).to.emit(issuanceModule, "SetTokenIssued").withArgs(
            subjectSetToken,
            subjectCaller.address,
            subjectTo.address,
            ADDRESS_ZERO,
            subjectIssueQuantity,
          );
        });

        describe("when the issue quantity is extremely small", async () => {
          beforeEach(async () => {
            subjectIssueQuantity = ONE;
          });

          it("should transfer the minimal units of components to the SetToken", async () => {
            await subject();
            const depositedWETHBalance = await setup.weth.balanceOf(setToken.address);
            const expectedWETHBalance = ONE;
            expect(depositedWETHBalance).to.eq(expectedWETHBalance);

            const depositedBTCBalance = await setup.wbtc.balanceOf(setToken.address);
            const expectedBTCBalance = ONE;
            expect(depositedBTCBalance).to.eq(expectedBTCBalance);
          });
        });

        describe("when a SetToken position is not in default state", async () => {
          beforeEach(async () => {
            // Add self as module and update the position state
            await setup.controller.addModule(owner.address);
            await setToken.addModule(owner.address);
            await setToken.initializeModule();

            const retrievedPosition = (await setToken.getPositions())[0];

            await setToken.addExternalPositionModule(retrievedPosition.component, retrievedPosition.module);
            await setToken.editExternalPositionUnit(retrievedPosition.component, retrievedPosition.module, retrievedPosition.unit);
          });

          it("should revert", async () => {
            await expect(subject()).to.be.revertedWith("Only default positions are supported");
          });
        });

        describe("when one of the components has a recipient-related fee", async () => {
          beforeEach(async () => {
            // Add self as module and update the position state
            await setup.controller.addModule(owner.address);
            await setToken.addModule(owner.address);
            await setToken.initializeModule();

            const tokenWithFee = await deployer.mocks.deployTokenWithFeeMock(owner.address, ether(20), ether(0.1));
            await tokenWithFee.approve(issuanceModule.address, ether(100));

            const retrievedPosition = (await setToken.getPositions())[0];

            await setToken.addComponent(tokenWithFee.address);
            await setToken.editDefaultPositionUnit(tokenWithFee.address, retrievedPosition.unit);
          });

          it("should revert", async () => {
            await expect(subject()).to.be.revertedWith("Invalid post transfer balance");
          });
        });

        describe("when the issue quantity is 0", async () => {
          beforeEach(async () => {
            subjectIssueQuantity = ZERO;
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
              [issuanceModule.address]
            );

            subjectSetToken = nonEnabledSetToken.address;
          });

          it("should revert", async () => {
            await expect(subject()).to.be.revertedWith("Must be a valid and initialized SetToken");
          });
        });
      });

      context("when a preIssueHook has been set", async () => {
        let issuanceHookContract: ManagerIssuanceHookMock;

        before(async () => {
          issuanceHookContract = await deployer.mocks.deployManagerIssuanceHookMock();

          preIssueHook = issuanceHookContract.address;
        });

        async function subject(): Promise<any> {
          return issuanceModule.issue(subjectSetToken, subjectIssueQuantity, subjectTo.address);
        }

        it("should properly call the pre-issue hooks", async () => {
          await subject();
          const retrievedSetToken = await issuanceHookContract.retrievedSetToken();
          const retrievedIssueQuantity = await issuanceHookContract.retrievedIssueQuantity();
          const retrievedSender = await issuanceHookContract.retrievedSender();
          const retrievedTo = await issuanceHookContract.retrievedTo();

          expect(retrievedSetToken).to.eq(subjectSetToken);
          expect(retrievedIssueQuantity).to.eq(subjectIssueQuantity);
          expect(retrievedSender).to.eq(owner.address);
          expect(retrievedTo).to.eq(subjectTo.address);
        });

        it("should emit the SetTokenIssued event", async () => {
          await expect(subject()).to.emit(issuanceModule, "SetTokenIssued").withArgs(
            subjectSetToken,
            subjectCaller.address,
            subjectTo.address,
            issuanceHookContract.address,
            subjectIssueQuantity,
          );
        });
      });
    });
  });

  describe("#redeem", async () => {
    let setToken: SetToken;

    let subjectSetToken: Address;
    let subjectRedeemQuantity: BigNumber;
    let subjectTo: Address;
    let subjectCaller: Account;

    let preIssueHook: Address;

    context("when the components are WBTC and WETH", async () => {
      beforeEach(async () => {
        preIssueHook = ADDRESS_ZERO;

        setToken = await setup.createSetToken(
          [setup.weth.address, setup.wbtc.address],
          [ether(1), bitcoin(2)],
          [issuanceModule.address]
        );
        await issuanceModule.initialize(setToken.address, preIssueHook);

        // Approve tokens to the issuance module
        await setup.weth.approve(issuanceModule.address, ether(5));
        await setup.wbtc.approve(issuanceModule.address, bitcoin(10));

        subjectSetToken = setToken.address;
        subjectRedeemQuantity = ether(1);
        subjectTo = recipient.address;
        subjectCaller = owner;

        const issueQuantity = ether(2);
        await issuanceModule.issue(subjectSetToken, issueQuantity, subjectCaller.address);
      });

      async function subject(): Promise<any> {
        return issuanceModule.connect(subjectCaller.wallet).redeem(subjectSetToken, subjectRedeemQuantity, subjectTo);
      }

      it("should redeem the Set", async () => {
        await subject();
        const redeemBalance = await setToken.balanceOf(owner.address);
        expect(redeemBalance).to.eq(ether(1));
      });

      it("should have deposited the components to the recipients account", async () => {
        const beforeWETHBalance = await setup.weth.balanceOf(recipient.address);
        const beforeBTCBalance = await setup.wbtc.balanceOf(recipient.address);

        await subject();
        const afterWETHBalance = await setup.weth.balanceOf(recipient.address);
        const expectedBTCBalance = beforeWETHBalance.add(subjectRedeemQuantity);
        expect(afterWETHBalance).to.eq(expectedBTCBalance);

        const afterBTCBalance = await setup.wbtc.balanceOf(recipient.address);
        const expectedBalance = beforeBTCBalance.add(subjectRedeemQuantity.mul(bitcoin(2)).div(ether(1)));
        expect(afterBTCBalance).to.eq(expectedBalance);
      });

      it("should have subtracted from the components from the SetToken", async () => {
        const beforeWETHBalance = await setup.weth.balanceOf(setToken.address);
        const beforeBTCBalance = await setup.wbtc.balanceOf(setToken.address);

        await subject();
        const afterWETHBalance = await setup.weth.balanceOf(setToken.address);
        const expectedBTCBalance = beforeWETHBalance.sub(subjectRedeemQuantity);
        expect(afterWETHBalance).to.eq(expectedBTCBalance);

        const afterBTCBalance = await setup.wbtc.balanceOf(setToken.address);
        const expectedBalance = beforeBTCBalance.sub(subjectRedeemQuantity.mul(bitcoin(2)).div(ether(1)));
        expect(afterBTCBalance).to.eq(expectedBalance);
      });

      it("should emit the SetTokenRedeemed event", async () => {
        await expect(subject()).to.emit(issuanceModule, "SetTokenRedeemed").withArgs(
          subjectSetToken,
          subjectCaller.address,
          subjectTo,
          subjectRedeemQuantity
        );
      });

      describe("when the issue quantity is extremely small", async () => {
        beforeEach(async () => {
          subjectRedeemQuantity = ONE;
        });

        it("should transfer the minimal units of components to the SetToken", async () => {
          const previousCallerBTCBalance = await setup.wbtc.balanceOf(subjectCaller.address);

          await subject();

          const afterCallerBTCBalance = await setup.wbtc.balanceOf(subjectCaller.address);
          expect(previousCallerBTCBalance).to.eq(afterCallerBTCBalance);
        });
      });

      describe("when the issue quantity is greater than the callers balance", async () => {
        beforeEach(async () => {
          subjectRedeemQuantity = ether(4);
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("ERC20: burn amount exceeds balance");
        });
      });

      describe("when one of the components has a recipient-related fee", async () => {
        beforeEach(async () => {
          // Add self as module and update the position state
          await setup.controller.addModule(owner.address);
          await setToken.addModule(owner.address);
          await setToken.initializeModule();

          const tokenWithFee = await deployer.mocks.deployTokenWithFeeMock(setToken.address, ether(20), ether(0.1));

          const retrievedPosition = (await setToken.getPositions())[0];

          await setToken.addComponent(tokenWithFee.address);
          await setToken.editDefaultPositionUnit(tokenWithFee.address, retrievedPosition.unit);
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("Invalid post transfer balance");
        });
      });

      describe("when a SetToken position is not in default state", async () => {
        beforeEach(async () => {
          // Add self as module and update the position state
          await setup.controller.addModule(owner.address);
          await setToken.addModule(owner.address);
          await setToken.initializeModule();

          const retrievedPosition = (await setToken.getPositions())[0];

          await setToken.addExternalPositionModule(retrievedPosition.component, retrievedPosition.module);
          await setToken.editExternalPositionUnit(retrievedPosition.component, retrievedPosition.module, retrievedPosition.unit);
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("Only default positions are supported");
        });
      });

      describe("when the issue quantity is 0", async () => {
        beforeEach(async () => {
          subjectRedeemQuantity = ZERO;
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
            [issuanceModule.address]
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
