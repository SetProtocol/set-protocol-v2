import "module-alias/register";
import { BigNumber } from "ethers";
import { utils } from "ethers";

import { Address, Bytes } from "@utils/types";
import { Account } from "@utils/test/types";
import { ADDRESS_ZERO, EMPTY_BYTES, ONE_DAY_IN_SECONDS, ZERO } from "@utils/constants";
import { AaveGovernanceV2Adapter, SetToken, GovernanceModule } from "@utils/contracts";
import DeployHelper from "@utils/deploys";
import {
  ether,
} from "@utils/index";
import {
  addSnapshotBeforeRestoreAfterEach,
  getAccounts,
  getWaffleExpect,
  getSystemFixture,
  increaseTimeAsync,
  getAaveV2Fixture,
} from "@utils/test/index";
import { AaveV2Fixture, SystemFixture } from "@utils/fixtures";

const expect = getWaffleExpect();

describe("AaveGovernanceV2Module", () => {
  let owner: Account;
  let deployer: DeployHelper;
  let setup: SystemFixture;

  let aaveSetup: AaveV2Fixture;

  let governanceModule: GovernanceModule;
  let aaveGovernanceV2Adapter: AaveGovernanceV2Adapter;

  const aaveGovernanceV2AdapterIntegrationName: string = "AAVEV2";

  before(async () => {
    [
      owner,
    ] = await getAccounts();

    // System setup
    deployer = new DeployHelper(owner.wallet);
    setup = getSystemFixture(owner.address);
    await setup.initialize();

    // Aave setup
    aaveSetup = getAaveV2Fixture(owner.address);
    await aaveSetup.initialize(setup.weth.address, setup.dai.address);

    // GovernanceModule setup
    governanceModule = await deployer.modules.deployGovernanceModule(setup.controller.address);
    await setup.controller.addModule(governanceModule.address);

    // AaveGovernanceV2Adapter setup
    aaveGovernanceV2Adapter = await deployer.adapters.deployAaveGovernanceV2Adapter(
      aaveSetup.aaveGovernanceV2.address,
      aaveSetup.aaveToken.address,
    );

    await setup.integrationRegistry.addIntegration(
      governanceModule.address,
      aaveGovernanceV2AdapterIntegrationName,
      aaveGovernanceV2Adapter.address
    );
  });

  addSnapshotBeforeRestoreAfterEach();

  describe("when a SetToken has been deployed and issued", async () => {
    let setToken: SetToken;
    let setTokensIssued: BigNumber;

    let componentUnits: BigNumber[];

    before(async () => {
      componentUnits = [ether(10000)]; // 10000 AAVE
      setToken = await setup.createSetToken(
        [aaveSetup.aaveToken.address],
        componentUnits,
        [setup.issuanceModule.address, governanceModule.address]
      );

      // Initialize modules
      await setup.issuanceModule.initialize(setToken.address, ADDRESS_ZERO);
      await governanceModule.initialize(setToken.address);

      // Issue some Sets
      setTokensIssued = ether(1);
      await aaveSetup.aaveToken.approve(setup.issuanceModule.address, componentUnits[0]);
      await setup.issuanceModule.issue(setToken.address, setTokensIssued, owner.address);
    });

    describe("#vote", async () => {
      let subjectSetToken: Address;
      let subjectProposalId: BigNumber;
      let subjectSupport: boolean;
      let subjectData: Bytes;
      let subjectIntegrationName: string;
      let subjectCaller: Account;

      beforeEach(async () => {
        const targets = ["0xd08E12367A7D68CAA8ff080D3A56b2dc6650709b"];
        const values = [0];
        const signatures: string[] = [""];
        const calldatas = [EMPTY_BYTES];
        const withDelegateCall = [true];
        const ipfsHash = "0x384dd57abcd23aae459877625228062db4082485a0ac1fc45eb54524f5836507";

        await aaveSetup.aaveGovernanceV2.create(
          aaveSetup.executor.address,
          targets,
          values,
          signatures,
          calldatas,
          withDelegateCall,
          ipfsHash
        );

        const proposalReviewPeriod = ONE_DAY_IN_SECONDS;
        await increaseTimeAsync(proposalReviewPeriod);

        subjectSetToken = setToken.address;
        subjectIntegrationName = aaveGovernanceV2AdapterIntegrationName;
        subjectProposalId = ZERO;
        subjectSupport = true;
        subjectData = EMPTY_BYTES;
        subjectCaller = owner;
      });

      async function subject(): Promise<any> {
        return governanceModule.connect(subjectCaller.wallet).vote(
          subjectSetToken,
          subjectIntegrationName,
          subjectProposalId,
          subjectSupport,
          subjectData
        );
      }

      it("should vote in Aave", async () => {
        await subject();

        const proposal = await aaveSetup.aaveGovernanceV2.getProposalById(ZERO);
        const forVotes = proposal.forVotes;
        const againstVotes = proposal.againstVotes;

        expect(againstVotes).to.eq(ZERO);
        expect(forVotes).to.eq(componentUnits[0]);
      });

      describe("when voting against a proposal", () => {
        beforeEach(async () => {
          subjectSupport = false;
        });

        it("should vote false", async () => {
          await subject();

          const proposal = await aaveSetup.aaveGovernanceV2.getProposalById(ZERO);
          const forVotes = proposal.forVotes;
          const againstVotes = proposal.againstVotes;

          expect(againstVotes).to.eq(componentUnits[0]);
          expect(forVotes).to.eq(ZERO);
        });
      });
    });

    describe("#propose", async () => {
      let subjectCaller: Account;
      let subjectSetToken: SetToken;
      let subjectGovernanceIntegrationName: string;
      let subjectProposalData: string;

      const targets = ["0x0A970EB5c73b77C7d0CC81314D37Bc8C9FD14ee4"];
      const values = [BigNumber.from(7)];
      const signatures: string[] = ["someSignature(uint256)"];
      const calldatas = [EMPTY_BYTES];
      const withDelegateCall = [false];
      const ipfsHash = "0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

      beforeEach(async () => {
        subjectCaller = owner;
        subjectSetToken = setToken;
        subjectGovernanceIntegrationName = aaveGovernanceV2AdapterIntegrationName;
        subjectProposalData = utils.defaultAbiCoder.encode(
          ["address", "address[]", "uint256[]", "string[]", "bytes[]", "bool[]", "bytes32"],
          [aaveSetup.executor.address, targets, values, signatures, calldatas, withDelegateCall, ipfsHash]
        );
      });

      async function subject(): Promise<any> {
        return governanceModule.connect(subjectCaller.wallet).propose(
          subjectSetToken.address,
          subjectGovernanceIntegrationName,
          subjectProposalData
        );
      }

      it("should create a proposal with the correct parameters", async () => {
        await subject();

        const proposalReviewPeriod = ONE_DAY_IN_SECONDS;
        await increaseTimeAsync(proposalReviewPeriod);

        const proposal = await aaveSetup.aaveGovernanceV2.getProposalById(BigNumber.from(0));
        const proposalValues = proposal[4];

        expect(proposal.executor).to.eq(aaveSetup.executor.address);
        expect(proposal.targets).to.deep.eq(targets);
        expect(proposalValues.map(v => v.toString())).to.deep.eq(values.map(v => v.toString()));
        expect(proposal.signatures).to.deep.eq(signatures);
        expect(proposal.calldatas).to.deep.eq(calldatas);
        expect(proposal.withDelegatecalls).to.deep.eq(withDelegateCall);
        expect(proposal.ipfsHash).to.eq(ipfsHash);
      });
    });

    describe("#delegate", async () => {
      let subjectCaller: Account;
      let subjectDelegatee: Address;
      let subjectSetToken: SetToken;
      let subjectGovernanceIntegrationName: string;

      beforeEach(async () => {
        subjectCaller = owner;
        subjectDelegatee = "0x0A970EB5c73b77C7d0CC81314D37Bc8C9FD14ee4";
        subjectSetToken = setToken;
        subjectGovernanceIntegrationName = aaveGovernanceV2AdapterIntegrationName;
      });

      async function subject(): Promise<any> {
        return governanceModule.connect(subjectCaller.wallet).delegate(
          subjectSetToken.address,
          subjectGovernanceIntegrationName,
          subjectDelegatee
        );
      }

      it("should delegate votes to the correct address", async () => {
        const initDelegateeVotingPower = await aaveSetup.aaveToken.getPowerCurrent(subjectDelegatee, 0);
        const initSetVotingPower = await aaveSetup.aaveToken.getPowerCurrent(subjectSetToken.address, 0);

        await subject();

        const finalDelegateeVotingPower = await aaveSetup.aaveToken.getPowerCurrent(subjectDelegatee, 0);
        const finalSetVotingPower = await aaveSetup.aaveToken.getPowerCurrent(subjectSetToken.address, 0);

        const gainedVotes = finalDelegateeVotingPower.sub(initDelegateeVotingPower);

        expect(gainedVotes).to.eq(initSetVotingPower);
        expect(finalSetVotingPower).to.eq(ZERO);
      });
    });
  });
});
