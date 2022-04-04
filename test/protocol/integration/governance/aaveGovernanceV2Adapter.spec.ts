import "module-alias/register";
import { utils, BigNumber } from "ethers";
import { Address, Bytes } from "@utils/types";
import { Account } from "@utils/test/types";
import { EMPTY_BYTES, ZERO } from "@utils/constants";
import { AaveGovernanceV2Adapter } from "@utils/contracts";
import DeployHelper from "@utils/deploys";
import {
  addSnapshotBeforeRestoreAfterEach,
  getAccounts,
  getWaffleExpect,
  getAaveV2Fixture,
  getRandomAddress,
  getSystemFixture
} from "@utils/test/index";
import { AaveV2Fixture, SystemFixture } from "@utils/fixtures";


const expect = getWaffleExpect();

describe("AaveGovernanceAdapter", () => {
  let owner: Account;
  let deployer: DeployHelper;
  let aaveGovernanceV2Adapter: AaveGovernanceV2Adapter;
  let mockSetToken: Account;
  let setV2Setup: SystemFixture;
  let aaveSetup: AaveV2Fixture;

  before(async () => {
    [
      owner,
      mockSetToken,
    ] = await getAccounts();

    deployer = new DeployHelper(owner.wallet);

    setV2Setup = getSystemFixture(owner.address);
    await setV2Setup.initialize();

    aaveSetup = getAaveV2Fixture(owner.address);
    await aaveSetup.initialize(setV2Setup.weth.address, setV2Setup.dai.address);

    aaveGovernanceV2Adapter = await deployer.adapters.deployAaveGovernanceV2Adapter(
      aaveSetup.aaveGovernanceV2.address,
      aaveSetup.aaveToken.address
    );
  });

  addSnapshotBeforeRestoreAfterEach();

  describe("#constructor", async () => {
    let subjectAaveToken: Address;
    let subjectAaveGovernance: Address;

    beforeEach(async () => {
      subjectAaveToken = aaveSetup.aaveToken.address;
      subjectAaveGovernance = aaveSetup.aaveGovernanceV2.address;
    });

    async function subject(): Promise<any> {
      return deployer.adapters.deployAaveGovernanceV2Adapter(
        subjectAaveGovernance,
        subjectAaveToken,
      );
    }

    it("should have the correct AAVE token address", async () => {
      const deployedAaveGovernanceAdapter = await subject();

      const actualAaveToken = await deployedAaveGovernanceAdapter.aaveToken();
      expect(actualAaveToken).to.eq(subjectAaveToken);
    });

    it("should have the correct Aave governance contract address", async () => {
      const deployedAaveGovernanceAdapter = await subject();

      const actualGovernanceAddress = await deployedAaveGovernanceAdapter.aaveGovernanceV2();
      expect(actualGovernanceAddress).to.eq(subjectAaveGovernance);
    });
  });

  describe("#getProposeCalldata", async () => {
    let subjectProposalData: Address;

    const targets = ["0xd08E12367A7D68CAA8ff080D3A56b2dc6650709b"];
    const values = [0];
    const signatures: string[] = [];
    const calldatas = ["0x61461954"];
    const withDelegateCall = [true];
    const ipfsHash = "0x384dd57abcd23aae459877625228062db4082485a0ac1fc45eb54524f5836507";

    beforeEach(async () => {
      subjectProposalData = utils.defaultAbiCoder.encode(
        ["address", "address[]", "uint256[]", "string[]", "bytes[]", "bool[]", "bytes32"],
        [aaveSetup.executor.address, targets, values, signatures, calldatas, withDelegateCall, ipfsHash]
      );
    });


    async function subject(): Promise<any> {
      return aaveGovernanceV2Adapter.getProposeCalldata(subjectProposalData);
    }

    it("should return the correct data for creating a proposal", async () => {
      const [targetAddress, ethValue, callData] = await subject();

      const expectedCalldata = aaveSetup.aaveGovernanceV2.interface.encodeFunctionData(
        "create", [aaveSetup.executor.address, targets, values, signatures, calldatas, withDelegateCall, ipfsHash]
      );

      expect(targetAddress).to.eq(aaveSetup.aaveGovernanceV2.address);
      expect(ethValue).to.eq(BigNumber.from(0));
      expect(callData).to.eq(expectedCalldata);
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
      return aaveGovernanceV2Adapter.getVoteCalldata(subjectProposalId, subjectSupport, subjectData);
    }

    it("should return correct data for voting", async () => {
      const [targetAddress, ethValue, callData] = await subject();
      const expectedCallData = aaveSetup.aaveGovernanceV2.interface.encodeFunctionData(
        "submitVote",
        [subjectProposalId, subjectSupport]
      );

      expect(targetAddress).to.eq(aaveSetup.aaveGovernanceV2.address);
      expect(ethValue).to.eq(ZERO);
      expect(callData).to.eq(expectedCallData);
    });

    describe("when voting against a proposal", () => {

      beforeEach(async () => {
        subjectSupport = false;
      });

      it("should return correct data for voting", async () => {
        const [targetAddress, ethValue, callData] = await subject();

        const expectedCallData = aaveSetup.aaveGovernanceV2.interface.encodeFunctionData(
          "submitVote",
          [subjectProposalId, subjectSupport]
        );

        expect(targetAddress).to.eq(aaveSetup.aaveGovernanceV2.address);
        expect(ethValue).to.eq(ZERO);
        expect(callData).to.eq(expectedCallData);
      });
    });
  });

  describe("#getDelegateCalldata", async () => {
    let subjectDelegatee: Address;

    beforeEach(async () => {
      subjectDelegatee = await getRandomAddress();
    });

    async function subject(): Promise<any> {
      return aaveGovernanceV2Adapter.getDelegateCalldata(subjectDelegatee);
    }

    it("should return correct data for delegation", async () => {
      const [targetAddress, ethValue, callData] = await subject();

      const expectedCallData = aaveSetup.aaveToken.interface.encodeFunctionData("delegate", [subjectDelegatee]);

      expect(targetAddress).to.eq(aaveSetup.aaveToken.address);
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
      return aaveGovernanceV2Adapter.getRegisterCalldata(subjectSetToken);
    }

    it("should revert", async () => {
      await expect(subject()).to.be.revertedWith("No register available in AAVE governance");
    });
  });

  describe("#getRevokeCalldata", async () => {
    async function subject(): Promise<any> {
      return aaveGovernanceV2Adapter.getRevokeCalldata();
    }

    it("should revert", async () => {
      await expect(subject()).to.be.revertedWith("No revoke available in AAVE governance");
    });
  });
});
