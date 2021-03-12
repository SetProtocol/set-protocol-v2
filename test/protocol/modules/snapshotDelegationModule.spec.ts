import "module-alias/register";

import { ContractTransaction } from "@utils/types";
import { Account } from "@utils/test/types";
import { SnapshotDelegationModule, SetToken, DelegateRegistry } from "@utils/contracts";
import DeployHelper from "@utils/deploys";
import { ether } from "@utils/index";
import {
  addSnapshotBeforeRestoreAfterEach,
  getAccounts,
  getWaffleExpect,
  getSystemFixture,
} from "@utils/test/index";
import { SystemFixture } from "@utils/fixtures";
import { BytesLike } from "@ethersproject/bytes";

const expect = getWaffleExpect();

describe("SnapshotDelegationModule", () => {
  let owner: Account;
  let delegate: Account;
  let deployer: DeployHelper;
  let setup: SystemFixture;

  let setToken: SetToken;
  let snapshotModule: SnapshotDelegationModule;
  let delegateRegistry: DelegateRegistry;

  before(async () => {
    [
      owner,
      delegate,
    ] = await getAccounts();

    deployer = new DeployHelper(owner.wallet);
    setup = getSystemFixture(owner.address);
    await setup.initialize();
  });

  beforeEach(async () => {
    delegateRegistry = await deployer.external.deployDelegateRegistry();

    snapshotModule = await deployer.modules.deploySnapshotDelegationModule(setup.controller.address, delegateRegistry.address);
    await setup.controller.addModule(snapshotModule.address);

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
    let subjectId: BytesLike;

    beforeEach(async () => {
      subjectCaller = owner;
      subjectDelegate = delegate;
      subjectSetToken = setToken;

      // a 0 bytes32 id means delegate for all snapshot spaces
      subjectId = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
    });

    async function subject(): Promise<ContractTransaction> {
      return snapshotModule.connect(subjectCaller.wallet).delegate(subjectSetToken.address, subjectId, subjectDelegate.address);
    }

    it("should update delegation", async () => {
      await subject();
      const delegate = await delegateRegistry.delegation(subjectSetToken.address, subjectId);
      expect(delegate).to.eq(subjectDelegate.address);
    });

    it("should emit a Delegated event", async () => {
      const id = "0x0000000000000000000000000000000000000000000000000000000000000000";
      await expect(subject()).to.emit(snapshotModule, "Delegated").withArgs(id, subjectDelegate.address);
    });
  });
});
