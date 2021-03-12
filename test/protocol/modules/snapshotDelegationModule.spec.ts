import "module-alias/register";

import { ContractTransaction } from "@utils/types";
import { Account } from "@utils/test/types";
import { SnapshotDelegationModule, SetToken } from "@utils/contracts";
import DeployHelper from "@utils/deploys";
import { ether } from "@utils/index";
import {
  addSnapshotBeforeRestoreAfterEach,
  getAccounts,
  getWaffleExpect,
  getSystemFixture,
} from "@utils/test/index";
import { SystemFixture } from "@utils/fixtures";

const expect = getWaffleExpect();

describe("SnapshotDelegationModule", () => {
  let owner: Account;
  let delegate: Account;
  let deployer: DeployHelper;
  let setup: SystemFixture;

  let setToken: SetToken;
  let snapshotModule: SnapshotDelegationModule;

  before(async () => {
    [
      owner,
      delegate,
    ] = await getAccounts();

    deployer = new DeployHelper(owner.wallet);
    setup = getSystemFixture(owner.address);
    await setup.initialize();

    snapshotModule = await deployer.modules.deploySnapshotDelegationModule(setup.controller.address);
    await setup.controller.addModule(snapshotModule.address);
  });

  beforeEach(async () => {
    setToken = (await setup.createSetToken(
      [setup.weth.address],
      [ether(1)],
      [snapshotModule.address],
      owner.address
    ));
    await snapshotModule.connect(owner.wallet).initialize(setToken.address);
  });

  addSnapshotBeforeRestoreAfterEach();

  describe("#delegate", async () => {
    let subjectSetToken: SetToken;
    let subjectCaller: Account;
    let subjectDelegate: Account;

    beforeEach(async () => {
      subjectCaller = owner;
      subjectDelegate = delegate;
      subjectSetToken = setToken;
    });

    async function subject(): Promise<ContractTransaction> {
      return snapshotModule.connect(subjectCaller.wallet).delegate(subjectSetToken.address, subjectDelegate.address);
    }

    it("should emit a Delegated event", async () => {
      await expect(subject()).to.emit(snapshotModule, "Delegated").withArgs(subjectDelegate.address);
    });
  });
});
