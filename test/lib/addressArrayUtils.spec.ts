import "module-alias/register";
import { BigNumber } from "@ethersproject/bignumber";

import { Address } from "@utils/types";
import { Account } from "@utils/test/types";
import { ONE, MAX_UINT_256 } from "@utils/constants";
import { AddressArrayUtilsMock } from "@utils/contracts";
import DeployHelper from "@utils/deploys";
import {
  addSnapshotBeforeRestoreAfterEach,
  getAccounts,
  getWaffleExpect,
} from "@utils/test/index";

const expect = getWaffleExpect();

describe("AddressArrayUtils", () => {
  let accountOne: Account;
  let accountTwo: Account;
  let accountThree: Account;
  let unincludedAccount: Account;
  let deployer: DeployHelper;

  let addressArrayUtils: AddressArrayUtilsMock;

  let baseArray: Address[];

  before(async () => {
    [
      accountOne,
      accountTwo,
      accountThree,
      unincludedAccount,
    ] = await getAccounts();

    deployer = new DeployHelper(accountOne.wallet);
    addressArrayUtils = await deployer.mocks.deployAddressArrayUtilsMock();

    baseArray = [accountOne.address, accountTwo.address, accountThree.address];
  });

  addSnapshotBeforeRestoreAfterEach();

  describe("#indexOf", async () => {
    let subjectArray: Address[];
    let subjectAddress: Address;

    beforeEach(async () => {
      subjectArray = baseArray;
      subjectAddress = accountTwo.address;
    });

    async function subject(): Promise<any> {
      return addressArrayUtils.testIndexOf(subjectArray, subjectAddress);
    }

    it("should return the correct index and true", async () => {
      const [index, isIn] = await subject();

      expect(index).to.eq(BigNumber.from(1));
      expect(isIn).to.be.true;
    });

    describe("when passed address is not in array", async () => {
      beforeEach(async () => {
        subjectAddress = unincludedAccount.address;
      });

      it("should return false and max number index", async () => {
        const [index, isIn] = await subject();

        expect(index).to.eq(MAX_UINT_256);
        expect(isIn).to.be.false;
      });
    });
  });

  describe("#contains", async () => {
    let subjectArray: Address[];
    let subjectAddress: Address;

    beforeEach(async () => {
      subjectArray = baseArray;
      subjectAddress = accountTwo.address;
    });

    async function subject(): Promise<any> {
      return addressArrayUtils.testContains(subjectArray, subjectAddress);
    }

    it("should return the correct index and true", async () => {
      const isIn = await subject();

      expect(isIn).to.be.true;
    });

    describe("when passed address is not in array", async () => {
      beforeEach(async () => {
        subjectAddress = unincludedAccount.address;
      });

      it("should return false", async () => {
        const isIn = await subject();

        expect(isIn).to.be.false;
      });
    });
  });

  describe("#hasDuplicate", async () => {
    let subjectArray: Address[];

    beforeEach(async () => {
      subjectArray = baseArray;
    });

    async function subject(): Promise<any> {
      return addressArrayUtils.testHasDuplicate(subjectArray);
    }

    it("should return return false", async () => {
      const isIn = await subject();

      expect(isIn).to.be.false;
    });

    describe("when the passed in array has a duplicate in the beginning", async () => {
      beforeEach(async () => {
        subjectArray = [accountOne.address, accountOne.address, accountThree.address];
      });

      it("should return true", async () => {
        const isIn = await subject();

        expect(isIn).to.be.true;
      });
    });

    describe("when the passed in array has a duplicate in the end", async () => {
      beforeEach(async () => {
        subjectArray = [accountOne.address, accountTwo.address, accountOne.address];
      });

      it("should return true", async () => {
        const isIn = await subject();

        expect(isIn).to.be.true;
      });
    });

    describe("when the passed in array has a duplicate in the middle", async () => {
      beforeEach(async () => {
        subjectArray = [accountOne.address, accountTwo.address, accountTwo.address];
      });

      it("should return true", async () => {
        const isIn = await subject();

        expect(isIn).to.be.true;
      });
    });

    describe("when the passed in array is empty", async () => {
      beforeEach(async () => {
        subjectArray = [];
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("A is empty");
      });
    });
  });

  describe("#remove", async () => {
    let subjectArray: Address[];
    let subjectAddress: Address;

    beforeEach(async () => {
      subjectArray = baseArray;
      subjectAddress = accountTwo.address;
    });

    async function subject(): Promise<any> {
      return addressArrayUtils.testRemove(subjectArray, subjectAddress);
    }

    it("should return the correct array", async () => {
      const array = await subject();

      expect(JSON.stringify(array)).to.eq(JSON.stringify([accountOne.address, accountThree.address]));
    });

    describe("when passed address is not in array", async () => {
      beforeEach(async () => {
        subjectAddress = unincludedAccount.address;
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Address not in array.");
      });
    });
  });

  describe("#removeStorage", async () => {
    let subjectAddress: Address;

    beforeEach(async () => {
      await addressArrayUtils.setStorageArray(baseArray);
      subjectAddress = accountTwo.address;
    });

    async function subject(): Promise<any> {
      return addressArrayUtils.testRemoveStorage(subjectAddress);
    }

    it("should make the correct updates to the storage array", async () => {
      await subject();

      const actualArray = await addressArrayUtils.getStorageArray();
      expect(JSON.stringify(actualArray)).to.eq(JSON.stringify([accountOne.address, accountThree.address]));
    });

    describe("when item being removed is last in array", async () => {
      beforeEach(async () => {
        subjectAddress = accountThree.address;
      });

      it("should just pop off last item", async () => {
        await subject();

        const actualArray = await addressArrayUtils.getStorageArray();
        expect(JSON.stringify(actualArray)).to.eq(JSON.stringify([accountOne.address, accountTwo.address]));
      });
    });

    describe("when passed address is not in array", async () => {
      beforeEach(async () => {
        subjectAddress = unincludedAccount.address;
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Address not in array.");
      });
    });
  });

  describe("#pop", async () => {
    let subjectArray: Address[];
    let subjectIndex: BigNumber;

    beforeEach(async () => {
      subjectArray = baseArray;
      subjectIndex = ONE;
    });

    async function subject(): Promise<any> {
      return addressArrayUtils.testPop(subjectArray, subjectIndex);
    }

    it("should return the correct array and removed address", async () => {
      const [array, address] = await subject();

      expect(JSON.stringify(array)).to.eq(JSON.stringify([accountOne.address, accountThree.address]));
      expect(address).to.eq(accountTwo.address);
    });

    describe("when index is > than array length", async () => {
      beforeEach(async () => {
        subjectIndex = ONE.mul(5);
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Index must be < A length");
      });
    });
  });
});
