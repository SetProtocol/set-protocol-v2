import "module-alias/register";

import { Account } from "@utils/test/types";
import { IssuanceModule } from "@utils/contracts";
import DeployHelper from "@utils/deploys";
import {
  addSnapshotBeforeRestoreAfterEach,
  getAccounts,
  getWaffleExpect,
  getSystemFixture,
} from "@utils/test/index";
import { SystemFixture } from "@utils/fixtures";

const expect = getWaffleExpect();

describe("IssuanceModule", () => {
  let owner: Account;
  let deployer: DeployHelper;
  let setup: SystemFixture;

  before(async () => {
    [
      owner,
    ] = await getAccounts();

    deployer = new DeployHelper(owner.wallet);
    setup = getSystemFixture(owner.address);
    await setup.initialize();
  });

  addSnapshotBeforeRestoreAfterEach();

  describe("#constructor", async () => {
    let subjectIssuanceModule: IssuanceModule;

    async function subject(): Promise<IssuanceModule> {
      return deployer.modules.deployIssuanceModule(setup.controller.address);
    }

    it("should have the correct controller", async () => {
      subjectIssuanceModule = await subject();
      const expectedController = await subjectIssuanceModule.controller();
      expect(expectedController).to.eq(setup.controller.address);
    });
  });
});