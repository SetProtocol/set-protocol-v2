import "module-alias/register";
import { BigNumber } from "@ethersproject/bignumber";

import { Account } from "@utils/types";
import { ONE, TWO, THREE, MAX_UINT_256 } from "@utils/constants";
import { Uint256ArrayUtilsMock } from "@utils/contracts";
import DeployHelper from "@utils/deploys";
import {
  addSnapshotBeforeRestoreAfterEach,
  getAccounts,
  getWaffleExpect,
} from "@utils/index";

const expect = getWaffleExpect();

describe("Uint256ArrayUtils", () => {
  let accountOne: Account;
  let deployer: DeployHelper;

  let uintArrayUtils: Uint256ArrayUtilsMock;

  before(async () => {
    [
      accountOne,
    ] = await getAccounts();

    deployer = new DeployHelper(accountOne.wallet);
    uintArrayUtils = await deployer.mocks.deployUint256ArrayUtilsMock();
  });

  addSnapshotBeforeRestoreAfterEach();

  describe("#extend", async () => {
    let subjectArrayA: BigNumber[];
    let subjectArrayB: BigNumber[];

    beforeEach(async () => {
      subjectArrayA = [ONE, TWO];
      subjectArrayB = [MAX_UINT_256, THREE];
    });

    async function subject(): Promise<any> {
      return uintArrayUtils.testExtend(subjectArrayA, subjectArrayB);
    }

    it("should return the correct index and true", async () => {
      const newArray = await subject();

      const expectedArray = subjectArrayA.concat(subjectArrayB);
      expect(JSON.stringify(newArray)).to.eq(JSON.stringify(expectedArray));
    });
  });
});
