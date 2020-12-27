import "module-alias/register";

import { Account } from "@utils/types";
import {
  addSnapshotBeforeRestoreAfterEach,
  ether,
  getAccounts,
  getMakerFixture,
  getWaffleExpect,
} from "@utils/index";
import { SystemFixture, MakerFixture } from "@utils/fixtures";
import { ZERO } from "@utils/constants";

const expect = getWaffleExpect();

describe("MakerFixture", () => {
  let owner: Account;

  let makerSetup: MakerFixture;

  before(async () => {
    [
      owner,
    ] = await getAccounts();

    makerSetup = getMakerFixture(owner.address);
  });

  addSnapshotBeforeRestoreAfterEach();

  describe("#initialize", async () => {
    async function subject(): Promise<any> {
      await makerSetup.initialize(
        owner
      );
    }

    it("should deploy a PollingEmitter contract", async () => {
      await subject();

      const pollingEmitter = await makerSetup.makerPollingEmitter;
      expect(pollingEmitter.npoll).to.eq(ZERO);
    });
  });
});