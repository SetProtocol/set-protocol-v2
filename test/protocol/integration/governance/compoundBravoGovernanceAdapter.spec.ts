import "module-alias/register";
import { BigNumber } from "@ethersproject/bignumber";
import { defaultAbiCoder } from "@ethersproject/abi";
import { Address, Bytes } from "@utils/types";
import { Account } from "@utils/test/types";
import { ADDRESS_ZERO, EMPTY_BYTES, ZERO } from "@utils/constants";
import { CompoundBravoGovernanceAdapter } from "@utils/contracts";
import DeployHelper from "@utils/deploys";
import {
  addSnapshotBeforeRestoreAfterEach,
  getAccounts,
  getWaffleExpect,
  getCompoundFixture,
  getRandomAddress
} from "@utils/test/index";

import { CompoundFixture } from "@utils/fixtures";


const expect = getWaffleExpect();

describe("CompoundBravoGovernanceAdapter", () => {
  let owner: Account;
  let deployer: DeployHelper;
  let compoundBravoGovernanceAdapter: CompoundBravoGovernanceAdapter;
  let targetAddressOne: Account;
  let targetAddressTwo: Account;
  let mockSetToken: Account;
  let compoundSetup: CompoundFixture;

  before(async () => {
    [
      owner,
      targetAddressOne,
      targetAddressTwo,
      mockSetToken,
    ] = await getAccounts();

    deployer = new DeployHelper(owner.wallet);

    compoundSetup = getCompoundFixture(owner.address);
    await compoundSetup.initialize();
    await compoundSetup.initializeGovernorBravo();

    compoundBravoGovernanceAdapter = await deployer.adapters.deployCompoundBravoGovernanceAdapter(
      compoundSetup.compoundGovernorBravoDelegator.address,
      compoundSetup.comp.address,
    );
  });

  addSnapshotBeforeRestoreAfterEach();

  describe("#constructor", async () => {
    let subjectCompToken: Address;
    let subjectGovernorBravo: Address;

    beforeEach(async () => {
      subjectCompToken = compoundSetup.comp.address;
      subjectGovernorBravo = compoundSetup.compoundGovernorBravoDelegator.address;
    });

    async function subject(): Promise<any> {
      return deployer.adapters.deployCompoundBravoGovernanceAdapter(
        subjectGovernorBravo,
        subjectCompToken,
      );
    }

    it("should have the correct COMP token address", async () => {
      const deployedCompoundLikeGovernanceAdapter = await subject();

      const actualCompToken = await deployedCompoundLikeGovernanceAdapter.governanceToken();
      expect(actualCompToken).to.eq(subjectCompToken);
    });

    it("should have the correct governor bravo contract address", async () => {
      const deployedCompoundBravoGovernanceAdapter = await subject();

      const actualGovernorBravoAddress = await deployedCompoundBravoGovernanceAdapter.governorBravo();
      expect(actualGovernorBravoAddress).to.eq(subjectGovernorBravo);
    });
  });

  describe("#getProposeCalldata", async () => {
    let targets: Address[];
    let values: BigNumber[];
    let signatures: string[];
    let calldatas: Bytes[];
    let description: string;

    let subjectProposalData: Address;

    beforeEach(async () => {
      targets = [targetAddressOne.address, targetAddressTwo.address];
      values = [ZERO, ZERO];
      // Random functions from sample Compound governance proposal
      signatures = ["_supportMarket(address)", "_setReserveFactor(uint256)"];
      // Random bytes from sample Compound governance proposal
      calldatas = [
        "0x00000000000000000000000070e36f6bf80a52b3b46b3af8e106cc0ed743e8e4",
        "0x00000000000000000000000000000000000000000000000002c68af0bb140000",
      ];
      description = "Create A Proposal";
      subjectProposalData = defaultAbiCoder.encode(
        ["address[]", "uint256[]", "string[]", "bytes[]", "string"],
        [targets, values, signatures, calldatas, description]
      );
    });

    async function subject(): Promise<any> {
      return compoundBravoGovernanceAdapter.getProposeCalldata(subjectProposalData);
    }

    it("should return correct data for creating a proposal", async () => {
      const [targetAddress, ethValue, callData] = await subject();
      const expectedCallData = compoundSetup.compoundGovernorBravoDelegate.interface.encodeFunctionData("propose",
        [targets, values, signatures, calldatas, description]
      );

      expect(targetAddress).to.eq(compoundSetup.compoundGovernorBravoDelegator.address);
      expect(ethValue).to.eq(ZERO);
      expect(callData).to.eq(expectedCallData);
    });
  });

  describe("#getDelegateCalldata", async () => {
    let subjectDelegatee: Address;

    beforeEach(async () => {
      subjectDelegatee = await getRandomAddress();
    });

    async function subject(): Promise<any> {
      return compoundBravoGovernanceAdapter.getDelegateCalldata(subjectDelegatee);
    }

    it("should return correct data for delegating", async () => {
      const [targetAddress, ethValue, callData] = await subject();
      const expectedCallData = compoundSetup.comp.interface.encodeFunctionData("delegate", [subjectDelegatee]);

      expect(targetAddress).to.eq(compoundSetup.comp.address);
      expect(ethValue).to.eq(ZERO);
      expect(callData).to.eq(expectedCallData);
    });
  });

  describe("#getRegisterCalldata", async () => {
    let subjectSetToken: Address;

    beforeEach(async () => {
      subjectSetToken = mockSetToken.address;
    });

    async function subject(): Promise<any> {
      return compoundBravoGovernanceAdapter.getRegisterCalldata(subjectSetToken);
    }

    it("should return correct data for registering", async () => {
      const [targetAddress, ethValue, callData] = await subject();
      const expectedCallData = compoundSetup.comp.interface.encodeFunctionData("delegate", [mockSetToken.address]);

      expect(targetAddress).to.eq(compoundSetup.comp.address);
      expect(ethValue).to.eq(ZERO);
      expect(callData).to.eq(expectedCallData);
    });
  });

  describe("#getRevokeCalldata", async () => {
    async function subject(): Promise<any> {
      return compoundBravoGovernanceAdapter.getRevokeCalldata();
    }

    it("should return correct data for revoking", async () => {
      const [targetAddress, ethValue, callData] = await subject();
      const expectedCallData = compoundSetup.comp.interface.encodeFunctionData("delegate", [ADDRESS_ZERO]);

      expect(targetAddress).to.eq(compoundSetup.comp.address);
      expect(ethValue).to.eq(ZERO);
      expect(callData).to.eq(expectedCallData);
    });
  });

  describe("#getVoteCalldata", async () => {
    let subjectProposalId: BigNumber;
    let subjectSupport: boolean;
    let subjectData: Bytes;

    beforeEach(async () => {
      subjectProposalId = ZERO;
      subjectSupport = true;
      subjectData = EMPTY_BYTES;
    });

    async function subject(): Promise<any> {
      return compoundBravoGovernanceAdapter.getVoteCalldata(subjectProposalId, subjectSupport, subjectData);
    }

    it("should return correct data for voting on a proposal", async () => {
      const [targetAddress, ethValue, callData] = await subject();
      const expectedCallData = compoundSetup.compoundGovernorBravoDelegate.interface.encodeFunctionData("castVote",
        [subjectProposalId, subjectSupport ? 1 : 0]
      );

      expect(targetAddress).to.eq(compoundSetup.compoundGovernorBravoDelegator.address);
      expect(ethValue).to.eq(ZERO);
      expect(callData).to.eq(expectedCallData);
    });
  });
});
