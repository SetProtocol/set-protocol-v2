import "module-alias/register";
import { BigNumber } from "ethers";

import { Address } from "@utils/types";
import { Account } from "@utils/test/types";
import { ZERO } from "@utils/constants";
import { ContractTransaction } from "ethers";
import { TokenSwap } from "@utils/contracts/axieInfinity";
import { AxieInfinityMigrationWrapAdapter, StandardTokenMock } from "@utils/contracts";
import DeployHelper from "@utils/deploys";
import {
  ether,
} from "@utils/index";
import {
  addSnapshotBeforeRestoreAfterEach,
  getAccounts,
  getRandomAccount,
  getWaffleExpect
} from "@utils/test/index";

const expect = getWaffleExpect();

describe("AxieInfinityMigrationWrapAdapter", () => {
  let owner: Account;
  let deployer: DeployHelper;
  let tokenSwap: TokenSwap;
  let axieMigrationWrapAdapter: AxieInfinityMigrationWrapAdapter;

  let mockOtherUnderlyingToken: Account;
  let mockOtherWrappedToken: Account;
  let newAxsToken: StandardTokenMock;
  let oldAxsToken: StandardTokenMock;

  before(async () => {
    [
      owner,
      mockOtherUnderlyingToken,
      mockOtherWrappedToken,
    ] = await getAccounts();

    deployer = new DeployHelper(owner.wallet);

    oldAxsToken = await deployer.mocks.deployTokenMock(owner.address);
    newAxsToken = await deployer.mocks.deployTokenMock(owner.address);

    tokenSwap = await deployer.external.deployTokenSwap(oldAxsToken.address, newAxsToken.address);

    // transfer new AXS tokens to TokenSwap contract
    await newAxsToken.connect(owner.wallet).transfer(tokenSwap.address, ether(100000));

    axieMigrationWrapAdapter = await deployer.adapters.deployAxieInfinityMigrationWrapAdapter(
      tokenSwap.address,
      oldAxsToken.address,
      newAxsToken.address
    );
  });

  addSnapshotBeforeRestoreAfterEach();

  describe("#constructor", async () => {
    let subjectTokenSwap: Address;
    let subjectOldAxsToken: Address;
    let subjectNewAxsToken: Address;

    beforeEach(async () => {
      subjectTokenSwap = tokenSwap.address;
      subjectOldAxsToken = oldAxsToken.address;
      subjectNewAxsToken = newAxsToken.address;
    });

    async function subject(): Promise<any> {
      return deployer.adapters.deployAxieInfinityMigrationWrapAdapter(
        subjectTokenSwap,
        subjectOldAxsToken,
        subjectNewAxsToken
      );
    }

    it("should have the correct tokenSwap address", async () => {
      const deployedAxieMigrationWrapAdapter = await subject();

      const tokenSwap = await deployedAxieMigrationWrapAdapter.tokenSwap();
      const expectedTokenSwap = subjectTokenSwap;

      expect(tokenSwap).to.eq(expectedTokenSwap);
    });

    it("should have the correct old AXS token address", async () => {
      const deployedAxieMigrationWrapAdapter = await subject();

      const oldAxsToken = await deployedAxieMigrationWrapAdapter.oldToken();
      const expectedOldAxsToken = subjectOldAxsToken;

      expect(oldAxsToken).to.eq(expectedOldAxsToken);
    });

    it("should have the correct new AXS token address", async () => {
      const deployedAxieMigrationWrapAdapter = await subject();

      const newAxsToken = await deployedAxieMigrationWrapAdapter.newToken();
      const expectedNewAxsToken = subjectNewAxsToken;

      expect(newAxsToken).to.eq(expectedNewAxsToken);
    });
  });

  describe("#swapTokenUsingAdapter", async () => {
    let subjectCaller: Account;
    let subjectAmount: BigNumber;

    beforeEach(async () => {
      const randomAccount = await getRandomAccount();
      await oldAxsToken.connect(owner.wallet).transfer(randomAccount.address, ether(1000));

      // Note: subjectCaller's oldAxsToken balance is higher than the subjectAmount.
      // This represents the scenario when balance of oldAxsToken held in Set is greter than
      // `setTokenTotalSupply.preciseMul(oldAxsPositionUnit)`, due to presence of some extra wei
      // in the SetToken, accumulated due to rounding errors
      subjectCaller = randomAccount;
      subjectAmount = ether(100);
    });

    async function subject(): Promise<ContractTransaction> {
      return axieMigrationWrapAdapter.connect(subjectCaller.wallet).swapTokenUsingAdapter(
        subjectAmount
      );
    }

    it("Should swap old AXS tokens for new AXS tokens", async () => {
      const beforeOldAxsBalance = await oldAxsToken.balanceOf(subjectCaller.address);
      const beforeNewAxsBalance = await newAxsToken.balanceOf(subjectCaller.address);

      await oldAxsToken.connect(subjectCaller.wallet).approve(axieMigrationWrapAdapter.address, subjectAmount);
      await subject();

      const afterOldAxsBalance = await oldAxsToken.balanceOf(subjectCaller.address);
      const afterNewAxsBalance = await newAxsToken.balanceOf(subjectCaller.address);

      const expectedAfterOldAxsBalance = beforeOldAxsBalance.sub(subjectAmount);
      const expectedAfterNewAxsBalance = beforeNewAxsBalance.add(subjectAmount);

      expect(afterOldAxsBalance).to.eq(expectedAfterOldAxsBalance);
      expect(afterNewAxsBalance).to.eq(expectedAfterNewAxsBalance);
    });
  });

  describe("#getSpenderAddress", async () => {
    async function subject(): Promise<any> {
      return axieMigrationWrapAdapter.getSpenderAddress(
        oldAxsToken.address,
        newAxsToken.address
      );
    }

    it("should return the correct spender address", async () => {
      const spender = await subject();
      const expectedSpender = axieMigrationWrapAdapter.address;

      expect(spender).to.eq(expectedSpender);
    });
  });

  describe("#getWrapCallData", async () => {
    let subjectUnderlyingToken: Address;
    let subjectWrappedToken: Address;
    let subjectNotionalUnderlying: BigNumber;

    beforeEach(async () => {
      subjectUnderlyingToken = oldAxsToken.address;
      subjectWrappedToken = newAxsToken.address;
      subjectNotionalUnderlying = ether(2);
    });

    async function subject(): Promise<any> {
      return axieMigrationWrapAdapter.getWrapCallData(subjectUnderlyingToken, subjectWrappedToken, subjectNotionalUnderlying);
    }

    it("should return correct data for valid pair", async () => {
      const [targetAddress, ethValue, callData] = await subject();

      const expectedCallData = axieMigrationWrapAdapter.interface.encodeFunctionData("swapTokenUsingAdapter", [subjectNotionalUnderlying]);
      const expectedTargetAddress = axieMigrationWrapAdapter.address;

      expect(targetAddress).to.eq(expectedTargetAddress);
      expect(ethValue).to.eq(ZERO);
      expect(callData).to.eq(expectedCallData);
    });

    describe("when underlying asset is not old AXS token", () => {
      beforeEach(async () => {
        subjectUnderlyingToken = mockOtherUnderlyingToken.address;
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Must be old AXS token");
      });
    });

    describe("when wrapped asset is not new AXS token", () => {
      beforeEach(async () => {
        subjectWrappedToken = mockOtherWrappedToken.address;
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Must be new AXS token");
      });
    });
  });

  describe("#getUnwrapCallData", async () => {
    let subjectUnderlyingToken: Address;
    let subjectWrappedToken: Address;
    let subjectNotionalUnderlying: BigNumber;

    beforeEach(async () => {
      subjectUnderlyingToken = mockOtherUnderlyingToken.address;
      subjectWrappedToken = mockOtherWrappedToken.address;
      subjectNotionalUnderlying = ether(2);
    });

    async function subject(): Promise<any> {
      return axieMigrationWrapAdapter.getUnwrapCallData(subjectUnderlyingToken, subjectWrappedToken, subjectNotionalUnderlying);
    }

    it("should revert", async () => {
      await expect(subject()).to.be.revertedWith("AXS migration cannot be reversed");
    });
  });
});
