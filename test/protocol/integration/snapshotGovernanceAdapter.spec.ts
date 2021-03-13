import "module-alias/register";

import { Address } from "@utils/types";
import { Account } from "@utils/test/types";
import { DelegateRegistry, SnapshotGovernanceAdapter } from "@utils/contracts";
import { ZERO, ZERO_BYTES } from "@utils/constants";
import DeployHelper from "@utils/deploys";
import {
  addSnapshotBeforeRestoreAfterEach,
  getAccounts,
  getRandomAddress,
  getWaffleExpect,
  getSystemFixture,
} from "@utils/test/index";
import { SystemFixture } from "@utils/fixtures";

const expect = getWaffleExpect();

describe("SnapshotDelegationModule", () => {
  let owner: Account;
  let deployer: DeployHelper;
  let setup: SystemFixture;

  let snapshotGovernanceAdapter: SnapshotGovernanceAdapter;
  let delegateRegistry: DelegateRegistry;

  before(async () => {
    [ owner ] = await getAccounts();

    deployer = new DeployHelper(owner.wallet);
    setup = getSystemFixture(owner.address);
    await setup.initialize();
  });

  beforeEach(async () => {
    delegateRegistry = await deployer.external.deployDelegateRegistry();
    snapshotGovernanceAdapter = await deployer.adapters.deploySnapshotGovernanceAdapter(delegateRegistry.address);
  });

  addSnapshotBeforeRestoreAfterEach();

  describe("#getDelegateCalldata", async () => {
    let subjectDelegatee: Address;

    beforeEach(async () => {
      subjectDelegatee = await getRandomAddress();
    });

    async function subject(): Promise<any> {
      return snapshotGovernanceAdapter.getDelegateCalldata(subjectDelegatee);
    }

    it("should return correct data for delegating", async () => {
      const [targetAddress, ethValue, callData] = await subject();
      const expectedCallData = delegateRegistry.interface.encodeFunctionData("setDelegate", [ZERO_BYTES, subjectDelegatee]);

      expect(targetAddress).to.eq(delegateRegistry.address);
      expect(ethValue).to.eq(ZERO);
      expect(callData).to.eq(expectedCallData);
    });
  });

  describe("#getRevokeCalldata", async () => {

    async function subject(): Promise<any> {
      return snapshotGovernanceAdapter.getRevokeCalldata();
    }

    it("should return correct data for removing delegate", async () => {
      const [targetAddress, ethValue, callData] = await subject();
      const expectedCallData = delegateRegistry.interface.encodeFunctionData("clearDelegate", [ZERO_BYTES]);

      expect(targetAddress).to.eq(delegateRegistry.address);
      expect(ethValue).to.eq(ZERO);
      expect(callData).to.eq(expectedCallData);
    });
  });
});
