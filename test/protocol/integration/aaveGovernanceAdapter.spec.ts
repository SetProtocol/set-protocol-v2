import "module-alias/register";
import { BigNumber, defaultAbiCoder } from "ethers/utils";

import { Address, Account, Bytes } from "@utils/types";
import { EMPTY_BYTES, ONE, TWO, ZERO } from "@utils/constants";
import { AaveGovernanceAdapter } from "@utils/contracts";
import DeployHelper from "@utils/deploys";
import {
  addSnapshotBeforeRestoreAfterEach,
  getAccounts,
  getWaffleExpect,
  getAaveFixture,
  getRandomAddress
} from "@utils/index";
import { AaveFixture } from "@utils/fixtures";


const expect = getWaffleExpect();

describe("AaveGovernanceAdapter", () => {
  let owner: Account;
  let deployer: DeployHelper;
  let aaveGovernanceAdapter: AaveGovernanceAdapter;
  let mockSetToken: Account;
  let aaveSetup: AaveFixture;

  before(async () => {
    [
      owner,
      mockSetToken,
    ] = await getAccounts();

    deployer = new DeployHelper(owner.wallet);

    aaveSetup = getAaveFixture(owner.address);
    await aaveSetup.initialize();

    aaveGovernanceAdapter = await deployer.adapters.deployAaveGovernanceAdapter(
      aaveSetup.aaveProtoGovernance.address,
      aaveSetup.aaveToken.address,
    );
  });

  addSnapshotBeforeRestoreAfterEach();

  describe("#constructor", async () => {
    let subjectAaveToken: Address;
    let subjectAaveProtoGovernance: Address;

    beforeEach(async () => {
      subjectAaveToken = aaveSetup.aaveToken.address;
      subjectAaveProtoGovernance = aaveSetup.aaveProtoGovernance.address;
    });

    async function subject(): Promise<any> {
      return deployer.adapters.deployAaveGovernanceAdapter(
        subjectAaveProtoGovernance,
        subjectAaveToken,
      );
    }

    it("should have the correct AAVE token address", async () => {
      const deployedAaveGovernanceAdapter = await subject();

      const actualCompToken = await deployedAaveGovernanceAdapter.aaveToken();
      expect(actualCompToken).to.eq(subjectAaveToken);
    });

    it("should have the correct Aave proto governance contract address", async () => {
      const deployedAaveGovernanceAdapter = await subject();

      const actualGovernorAlphaAddress = await deployedAaveGovernanceAdapter.aaveProtoGovernance();
      expect(actualGovernorAlphaAddress).to.eq(subjectAaveProtoGovernance);
    });
  });

  describe("#getProposeCalldata", async () => {
    let subjectProposalData: Address;

    beforeEach(async () => {
      subjectProposalData = EMPTY_BYTES;
    });

    async function subject(): Promise<any> {
      return aaveGovernanceAdapter.getProposeCalldata(subjectProposalData);
    }

    it("should revert", async () => {
      await expect(subject()).to.be.revertedWith("Creation of new proposal only available to AAVE genesis team");
    });
  });

  describe("#getDelegateCalldata", async () => {
    let subjectDelegatee: Address;

    beforeEach(async () => {
      subjectDelegatee = await getRandomAddress();
    });

    async function subject(): Promise<any> {
      return aaveGovernanceAdapter.getDelegateCalldata(subjectDelegatee);
    }

    it("should revert", async () => {
      await expect(subject()).to.be.revertedWith("No delegation available in AAVE governance");
    });
  });

  describe("#getRegisterCalldata", async () => {
    let subjectSetToken: Address;

    beforeEach(async () => {
      subjectSetToken = mockSetToken.address;
    });

    async function subject(): Promise<any> {
      return aaveGovernanceAdapter.getRegisterCalldata(subjectSetToken);
    }

    it("should revert", async () => {
      await expect(subject()).to.be.revertedWith("No register available in AAVE governance");
    });
  });

  describe("#getRevokeCalldata", async () => {
    async function subject(): Promise<any> {
      return aaveGovernanceAdapter.getRevokeCalldata();
    }

    it("should revert", async () => {
      await expect(subject()).to.be.revertedWith("No revoke available in AAVE governance");
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
      return aaveGovernanceAdapter.getVoteCalldata(subjectProposalId, subjectSupport, subjectData);
    }

    it("should return correct data for voting with AAVE token", async () => {
      const [targetAddress, ethValue, callData] = await subject();
      const expectedCallData = aaveSetup.aaveProtoGovernance.interface.functions.submitVoteByVoter.encode(
        [subjectProposalId, ONE, aaveSetup.aaveToken.address]
      );

      expect(targetAddress).to.eq(aaveSetup.aaveProtoGovernance.address);
      expect(ethValue).to.eq(ZERO);
      expect(callData).to.eq(expectedCallData);
    });

    describe("when voting with another token", () => {
      beforeEach(async () => {
        subjectData = defaultAbiCoder.encode(
          ["address"],
          [aaveSetup.lendToken.address]
        );
      });

      it("should return correct data for voting", async () => {
        const [targetAddress, ethValue, callData] = await subject();
        const expectedCallData = aaveSetup.aaveProtoGovernance.interface.functions.submitVoteByVoter.encode(
          [subjectProposalId, ONE, aaveSetup.lendToken.address]
        );

        expect(targetAddress).to.eq(aaveSetup.aaveProtoGovernance.address);
        expect(ethValue).to.eq(ZERO);
        expect(callData).to.eq(expectedCallData);
      });
    });

    describe("when voting against a proposal", () => {
      let voteValue: BigNumber;

      beforeEach(async () => {
        voteValue = TWO;
        subjectSupport = false;
      });

      it("should return correct data for voting", async () => {
        const [targetAddress, ethValue, callData] = await subject();
        const expectedCallData = aaveSetup.aaveProtoGovernance.interface.functions.submitVoteByVoter.encode(
          [subjectProposalId, voteValue, aaveSetup.aaveToken.address]
        );

        expect(targetAddress).to.eq(aaveSetup.aaveProtoGovernance.address);
        expect(ethValue).to.eq(ZERO);
        expect(callData).to.eq(expectedCallData);
      });
    });
  });
});
