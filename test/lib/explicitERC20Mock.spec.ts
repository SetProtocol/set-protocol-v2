import "module-alias/register";

import { BigNumber } from "@ethersproject/bignumber";

import { Account, Address } from "@utils/types";
import { MAX_UINT_256, ZERO } from "@utils/constants";
import { ExplicitERC20Mock, StandardTokenMock, StandardTokenWithFeeMock } from "@utils/contracts";
import DeployHelper from "@utils/deploys";
import {
  ether,
  getWaffleExpect,
  getAccounts,
  addSnapshotBeforeRestoreAfterEach,
} from "@utils/index";

const expect = getWaffleExpect();

describe("ExplicitErc20Mock", () => {
  let owner: Account;
  let testAccount: Account;
  let testAccount2: Account;
  let deployer: DeployHelper;

  let explicitERC20Mock: ExplicitERC20Mock;

  beforeEach(async () => {
    [
      owner,
      testAccount,
      testAccount2,
    ] = await getAccounts();

    deployer = new DeployHelper(owner.wallet);

    explicitERC20Mock = await deployer.mocks.deployExplicitErc20Mock();
  });

  addSnapshotBeforeRestoreAfterEach();

  describe("transferFrom", async () => {
    let token: StandardTokenMock;
    let quantity: BigNumber;

    let subjectTokenAddress: Address;
    let subjectQuantity: BigNumber;
    let subjectFromAddress: Address;
    let subjectToAddress: Address;
    let subjectCaller: Account;

    beforeEach(async () => {
      token = await deployer.mocks.deployTokenMock(testAccount.address);

      token = token.connect(testAccount.wallet);
      await token.approve(
        explicitERC20Mock.address,
        MAX_UINT_256
      );

      quantity = ether(1);

      subjectTokenAddress = token.address;
      subjectQuantity = ether(1);
      subjectFromAddress = testAccount.address;
      subjectToAddress = testAccount2.address;
      subjectCaller = owner;
    });

    async function subject(): Promise<any> {
      explicitERC20Mock = explicitERC20Mock.connect(subjectCaller.wallet);
      return explicitERC20Mock.transferFrom(
        subjectTokenAddress,
        subjectFromAddress,
        subjectToAddress,
        subjectQuantity,
      );
    }

    it("should decrement the balance of the from address", async () => {
      const previousBalance = await token.balanceOf(testAccount.address);

      await subject();

      const newBalance = await token.balanceOf(testAccount.address);
      const expectedBalance = previousBalance.sub(quantity);

      await expect(newBalance).to.eq(expectedBalance);
    });

    it("should increment the balance of the to address", async () => {
      const previousBalance = await token.balanceOf(testAccount2.address);

      await subject();

      const newBalance = await token.balanceOf(testAccount2.address);
      const expectedBalance = previousBalance.add(quantity);

      await expect(newBalance).to.eq(expectedBalance);
    });

    describe("when the transfer quantity is 0", async () => {
      beforeEach(async () => {
        subjectQuantity = ZERO;
      });

      it("should not change the balance of the user", async () => {
        const previousBalance = await token.balanceOf(testAccount2.address);

        await subject();

        const newBalance = await token.balanceOf(testAccount2.address);

        await expect(newBalance).to.eq(previousBalance);
      });
    });

    describe("when the token has a transfer fee", async () => {
      let mockTokenWithFee: StandardTokenWithFeeMock;

      beforeEach(async () => {
        mockTokenWithFee = await deployer.mocks.deployTokenWithFeeMock(testAccount.address);

        mockTokenWithFee = mockTokenWithFee.connect(testAccount.wallet);
        await mockTokenWithFee.approve(
          explicitERC20Mock.address,
          MAX_UINT_256
        );

        subjectTokenAddress = mockTokenWithFee.address;
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Invalid post transfer balance");
      });
    });

    describe("when the token is not approved for transfer", async () => {
      beforeEach(async () => {
        await token.approve(
          explicitERC20Mock.address,
          ZERO
        );
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("ERC20: transfer amount exceeds allowance");
      });
    });
  });
});