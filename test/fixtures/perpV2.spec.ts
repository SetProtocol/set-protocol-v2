import "module-alias/register";

import { Account } from "@utils/test/types";
import {
  addSnapshotBeforeRestoreAfterEach,
  getAccounts,
  getPerpV2Fixture,
} from "@utils/test/index";

import { PerpV2Fixture } from "@utils/fixtures";

// const expect = getWaffleExpect();

describe("PerpV2Fixture", () => {
  let owner: Account;
  let perpV2Setup: PerpV2Fixture;

  before(async () => {
    [
      owner,
    ] = await getAccounts();

    perpV2Setup = getPerpV2Fixture(owner.address);
  });

  addSnapshotBeforeRestoreAfterEach();

  describe("#initialize", async () => {

    async function subject(): Promise<any> {
      await perpV2Setup.initialize();
    }

    it("should deploy the PerpV2 system", async () => {
      await subject();
    });
  });
});
