import "module-alias/register";
import { BigNumber } from "ethers";

import { Address } from "@utils/types";
import { MAX_UINT_256 } from "@utils/constants";
import { StringArrayUtilsMock } from "@utils/contracts/index";
import DeployHelper from "@utils/deploys";
import {
  addSnapshotBeforeRestoreAfterEach,
  getAccounts,
  getWaffleExpect,
} from "@utils/test/index";

const expect = getWaffleExpect();

describe("StringArrayUtils", () => {
  let stringOne: string;
  let stringTwo: string;
  let stringThree: string;
  let unincludedString: string;
  let deployer: DeployHelper;

  let stringArrayUtils: StringArrayUtilsMock;

  let baseArray: Address[];

  before(async () => {

    stringOne = "eth";
    stringTwo = "to";
    stringThree = "$10k";

    unincludedString = "$0";

    const [ owner ] = await getAccounts();

    deployer = new DeployHelper(owner.wallet);
    stringArrayUtils = await deployer.mocks.deployStringArrayUtilsMock();

    baseArray = [ stringOne, stringTwo, stringThree ];
  });

  addSnapshotBeforeRestoreAfterEach();

  describe("#indexOf", async () => {
    let subjectArray: string[];
    let subjectString: string;

    beforeEach(async () => {
      subjectArray = baseArray;
      subjectString = stringTwo;
    });

    async function subject(): Promise<any> {
      return stringArrayUtils.testIndexOf(subjectArray, subjectString);
    }

    it("should return the correct index and true", async () => {
      const [index, isIn] = await subject();

      expect(index).to.eq(BigNumber.from(1));
      expect(isIn).to.be.true;
    });

    describe("when passed address is not in array", async () => {
      beforeEach(async () => {
        subjectString = unincludedString;
      });

      it("should return false and max number index", async () => {
        const [index, isIn] = await subject();

        expect(index).to.eq(MAX_UINT_256);
        expect(isIn).to.be.false;
      });
    });
  });

  describe("#removeStorage", async () => {
    let subjectString: string;

    beforeEach(async () => {
      await stringArrayUtils.setStorageArray(baseArray);
      subjectString = stringTwo;
    });

    async function subject(): Promise<any> {
      return stringArrayUtils.testRemoveStorage(subjectString);
    }

    it("should make the correct updates to the storage array", async () => {
      await subject();

      const actualArray = await stringArrayUtils.getStorageArray();
      expect(JSON.stringify(actualArray)).to.eq(JSON.stringify([ stringOne, stringThree ]));
    });

    describe("when item being removed is last in array", async () => {
      beforeEach(async () => {
        subjectString = stringThree;
      });

      it("should just pop off last item", async () => {
        await subject();

        const actualArray = await stringArrayUtils.getStorageArray();
        expect(JSON.stringify(actualArray)).to.eq(JSON.stringify([ stringOne, stringTwo ]));
      });
    });

    describe("when passed address is not in array", async () => {
      beforeEach(async () => {
        subjectString = unincludedString;
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("String not in array.");
      });
    });
  });
});
