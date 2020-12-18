import "module-alias/register";
import { BigNumber } from "ethers/utils";

import { Address, Account } from "@utils/types";
import { InvokeMock, SetToken, StandardTokenWithFeeMock } from "@utils/contracts";
import { ZERO } from "@utils/constants";
import DeployHelper from "@utils/deploys";
import {
  addSnapshotBeforeRestoreAfterEach,
  ether,
  getAccounts,
  getProvider,
  getRandomAddress,
  getSystemFixture,
  getWaffleExpect,
} from "@utils/index";
import { SystemFixture } from "@utils/fixtures";

const expect = getWaffleExpect();

describe("Invoke", () => {
  let owner: Account;
  let deployer: DeployHelper;

  let invokeLib: InvokeMock;
  let setup: SystemFixture;

  let setToken: SetToken;

  before(async () => {
    [
      owner,
    ] = await getAccounts();

    deployer = new DeployHelper(owner.wallet);
    setup = getSystemFixture(owner.address);
    await setup.initialize();

    invokeLib = await deployer.mocks.deployInvokeMock();
    await setup.controller.addModule(invokeLib.address);

    setToken = await setup.createSetToken(
      [setup.wbtc.address],
      [ether(1)],
      [invokeLib.address]
    );

    await invokeLib.initializeModuleOnSet(setToken.address);
  });

  addSnapshotBeforeRestoreAfterEach();

  describe("#invokeApprove", async () => {
    let subjectSetToken: Address;
    let subjectToken: Address;
    let subjectApprovee: Address;
    let subjectApprovalQuantity: BigNumber;

    beforeEach(async () => {
      subjectSetToken = setToken.address;
      subjectToken = setup.weth.address;
      subjectApprovee = await getRandomAddress();
      subjectApprovalQuantity = ether(4);
    });

    async function subject(): Promise<any> {
      return invokeLib.testInvokeApprove(
        subjectSetToken,
        subjectToken,
        subjectApprovee,
        subjectApprovalQuantity,
      );
    }

    it("should set approvals the WETH approval of SetToken to the approvee", async () => {
      await subject();
      const approvalAmount = await setup.weth.allowance(subjectSetToken, subjectApprovee);
      expect(approvalAmount).to.eq(subjectApprovalQuantity);
    });
  });

  describe("#invokeTransfer", async () => {
    let subjectSetToken: Address;
    let subjectToken: Address;
    let subjectRecipient: Address;
    let subjectTransferQuantity: BigNumber;

    beforeEach(async () => {
      subjectSetToken = setToken.address;
      subjectToken = setup.weth.address;
      subjectRecipient = await getRandomAddress();
      subjectTransferQuantity = ether(4);

      await setup.weth.transfer(setToken.address, subjectTransferQuantity.mul(2));
    });

    async function subject(): Promise<any> {
      return invokeLib.testInvokeTransfer(
        subjectSetToken,
        subjectToken,
        subjectRecipient,
        subjectTransferQuantity,
      );
    }

    it("should transfer the WETH to the recipient", async () => {
      const beforeTransferBalance = await setup.weth.balanceOf(subjectSetToken);

      await subject();

      const afterTransferBalance = await setup.weth.balanceOf(subjectSetToken);
      expect(afterTransferBalance).to.eq(beforeTransferBalance.sub(subjectTransferQuantity));

      const recipientBalance = await setup.weth.balanceOf(subjectRecipient);
      expect(recipientBalance).to.eq(subjectTransferQuantity);
    });

    describe("when the transfer quantity is 0", async () => {
      beforeEach(async () => {
        subjectTransferQuantity = ZERO;
      });

      it("should not change the balance of the user", async () => {
        const previousBalance = await setup.weth.balanceOf(subjectRecipient);

        await subject();

        const newBalance = await setup.weth.balanceOf(subjectRecipient);

        await expect(newBalance).to.eq(previousBalance);
      });
    });
  });

  describe("#strictInvokeTransfer", async () => {
    let subjectSetToken: Address;
    let subjectToken: Address;
    let subjectRecipient: Address;
    let subjectTransferQuantity: BigNumber;

    let tokenFee: BigNumber;
    let tokenWithFee: StandardTokenWithFeeMock;

    let customTokenFee: BigNumber;

    beforeEach(async () => {
      tokenFee = customTokenFee || ZERO;

      tokenWithFee = await deployer.mocks.deployTokenWithFeeMock(owner.address, ether(100), tokenFee);

      const setToken = await setup.createSetToken(
        [tokenWithFee.address],
        [ether(1)],
        [invokeLib.address]
      );

      await invokeLib.initializeModuleOnSet(setToken.address);

      subjectSetToken = setToken.address;
      subjectToken = tokenWithFee.address;
      subjectRecipient = await getRandomAddress();
      subjectTransferQuantity = ether(4);

      await tokenWithFee.transfer(setToken.address, subjectTransferQuantity.mul(2));
    });

    async function subject(): Promise<any> {
      return invokeLib.testStrictInvokeTransfer(
        subjectSetToken,
        subjectToken,
        subjectRecipient,
        subjectTransferQuantity,
      );
    }

    it("should transfer the token to the recipient", async () => {
      const beforeTransferBalance = await tokenWithFee.balanceOf(subjectSetToken);

      await subject();

      const afterTransferBalance = await tokenWithFee.balanceOf(subjectSetToken);
      expect(afterTransferBalance).to.eq(beforeTransferBalance.sub(subjectTransferQuantity));

      const recipientBalance = await tokenWithFee.balanceOf(subjectRecipient);
      expect(recipientBalance).to.eq(subjectTransferQuantity);
    });

    describe("when there is a fee enabled", async () => {
      before(async () => {
        customTokenFee = ether(0.1);
      });

      after(async () => {
        customTokenFee = ZERO;
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Invalid post transfer balance");
      });
    });
  });

  describe("#invokeWrapWETH", async () => {
    let subjectSetToken: Address;
    let subjectWeth: Address;
    let subjectQuantity: BigNumber;

    beforeEach(async () => {
      subjectSetToken = setToken.address;
      subjectWeth = setup.weth.address;
      subjectQuantity = ether(4);

      await owner.wallet.sendTransaction({ to: setToken.address, value: subjectQuantity });
    });

    async function subject(): Promise<any> {
      return invokeLib.testInvokeWrapWETH(
        subjectSetToken,
        subjectWeth,
        subjectQuantity
      );
    }

    it("should have the expected amount of WETH", async () => {
      const preWethBalance = await setup.weth.balanceOf(setToken.address);

      await subject();

      const postWethBalance = await setup.weth.balanceOf(setToken.address);
      expect(postWethBalance).to.eq(preWethBalance.add(subjectQuantity));
    });

    it("should not have any ETH", async () => {
      const provider = getProvider();
      const preEthBalance = await provider.getBalance(setToken.address);

      await subject();

      const postEthBalance = await provider.getBalance(setToken.address);
      expect(postEthBalance).to.eq(preEthBalance.sub(subjectQuantity));
    });
  });

  describe("#invokeUnwrapWETH", async () => {
    let subjectSetToken: Address;
    let subjectWeth: Address;
    let subjectQuantity: BigNumber;

    beforeEach(async () => {
      subjectSetToken = setToken.address;
      subjectWeth = setup.weth.address;
      subjectQuantity = ether(4);

      await setup.weth.connect(owner.wallet).transfer(setToken.address, subjectQuantity);
    });

    async function subject(): Promise<any> {
      return invokeLib.testInvokeUnwrapWETH(
        subjectSetToken,
        subjectWeth,
        subjectQuantity
      );
    }

    it("should not have any WETH", async () => {
      const preWethBalance = await setup.weth.balanceOf(setToken.address);

      await subject();

      const postWethBalance = await setup.weth.balanceOf(setToken.address);
      expect(postWethBalance).to.eq(preWethBalance.sub(subjectQuantity));
    });

    it("should have expected amount of ETH", async () => {
      const provider = getProvider();
      const preEthBalance = await provider.getBalance(setToken.address);

      await subject();

      const postEthBalance = await provider.getBalance(setToken.address);
      expect(postEthBalance).to.eq(preEthBalance.add(subjectQuantity));
    });
  });
});