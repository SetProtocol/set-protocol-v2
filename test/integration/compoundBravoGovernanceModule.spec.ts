import "module-alias/register";
import { BigNumber, utils } from "ethers";

import { Address, Bytes } from "@utils/types";
import { Account } from "@utils/test/types";
import { ADDRESS_ZERO, EMPTY_BYTES, ONE_DAY_IN_SECONDS, ZERO } from "@utils/constants";
import { CompoundBravoGovernanceAdapter, SetToken, GovernanceModule } from "@utils/contracts";
import DeployHelper from "@utils/deploys";
import {
  ether,
} from "@utils/index";
import {
  getAccounts,
  getWaffleExpect,
  getSystemFixture,
  getCompoundFixture,
  getRandomAddress,
  increaseTimeAsync,
  addSnapshotBeforeRestoreAfterEach,
} from "@utils/test/index";
import { CompoundFixture, SystemFixture } from "@utils/fixtures";

const expect = getWaffleExpect();

describe("CompoundBravoGovernanceModule", () => {
  let owner: Account;
  let deployer: DeployHelper;
  let setup: SystemFixture;

  let compoundSetup: CompoundFixture;

  let governanceModule: GovernanceModule;
  let compoundBravoGovernanceAdapter: CompoundBravoGovernanceAdapter;

  const compoundBravoGovernanceAdapterIntegrationName: string = "COMPOUNDBRAVO";

  before(async () => {
    [
      owner,
    ] = await getAccounts();

    // System setup
    deployer = new DeployHelper(owner.wallet);
    setup = getSystemFixture(owner.address);
    await setup.initialize();

    // Compound setup
    compoundSetup = getCompoundFixture(owner.address);
    await compoundSetup.initialize();
    await compoundSetup.initializeGovernorBravo();

    // GovernanceModule setup
    governanceModule = await deployer.modules.deployGovernanceModule(setup.controller.address);
    await setup.controller.addModule(governanceModule.address);

    // CompoundBravoGovernanceAdapter setup
    compoundBravoGovernanceAdapter = await deployer.adapters.deployCompoundBravoGovernanceAdapter(
      compoundSetup.compoundGovernorBravoDelegator.address,
      compoundSetup.comp.address,
    );

    await setup.integrationRegistry.addIntegration(
      governanceModule.address,
      compoundBravoGovernanceAdapterIntegrationName,
      compoundBravoGovernanceAdapter.address
    );
  });

  addSnapshotBeforeRestoreAfterEach();

  context("when a SetToken has been deployed and issued", async () => {
    let setToken: SetToken;
    let setTokensIssued: BigNumber;

    before(async () => {
      setToken = await setup.createSetToken(
        [compoundSetup.comp.address],
        [ether(200000)], // 200k COMP
        [setup.issuanceModule.address, governanceModule.address]
      );

      // Initialize modules
      await setup.issuanceModule.initialize(setToken.address, ADDRESS_ZERO);
      await governanceModule.initialize(setToken.address);

      // Issue some Sets
      setTokensIssued = ether(1);
      const underlyingRequired = ether(200000);
      await compoundSetup.comp.approve(setup.issuanceModule.address, underlyingRequired);
      await setup.issuanceModule.issue(setToken.address, setTokensIssued, owner.address);

      // Register for voting
      await governanceModule.register(setToken.address, compoundBravoGovernanceAdapterIntegrationName);
    });

    describe("#propose", async () => {
      let targets: Address[];
      let values: BigNumber[];
      let signatures: string[];
      let calldatas: Bytes[];
      let description: string;

      let subjectSetToken: Address;
      let subjectProposalData: Bytes;
      let subjectIntegrationName: string;
      let subjectCaller: Account;

      beforeEach(async () => {
        targets = [await getRandomAddress(), await getRandomAddress()];
        values = [ZERO, ZERO];
        // Random functions from sample Compound governance proposal
        signatures = ["_supportMarket(address)", "_setReserveFactor(uint256)"];
        // Random bytes from sample Compound governance proposal
        calldatas = [
          "0x00000000000000000000000070e36f6bf80a52b3b46b3af8e106cc0ed743e8e4",
          "0x00000000000000000000000000000000000000000000000002c68af0bb140000",
        ];
        description = "Create A Proposal";

        subjectSetToken = setToken.address;
        subjectIntegrationName = compoundBravoGovernanceAdapterIntegrationName;
        subjectProposalData = utils.defaultAbiCoder.encode(
          ["address[]", "uint256[]", "string[]", "bytes[]", "string"],
          [targets, values, signatures, calldatas, description]
        );
        subjectCaller = owner;
      });

      async function subject(): Promise<any> {
        return governanceModule.connect(subjectCaller.wallet).propose(
          subjectSetToken,
          subjectIntegrationName,
          subjectProposalData
        );
      }

      it("should create a proposal in Compound", async () => {
        await subject();

        const getProposalData = compoundSetup.compoundGovernorBravoDelegate.interface.encodeFunctionData("proposals", [BigNumber.from(2)]);
        const response = await subjectCaller.wallet.call({ to: compoundSetup.compoundGovernorBravoDelegator.address, data: getProposalData });
        const proposalData = compoundSetup.compoundGovernorBravoDelegate.interface.decodeFunctionResult("proposals", response);
        expect(proposalData.id).to.eq(BigNumber.from(2));
        expect(proposalData.proposer).to.eq(subjectSetToken);
      });
    });

    describe("#vote", async () => {
      let subjectSetToken: Address;
      let subjectProposalId: BigNumber;
      let subjectSupport: boolean;
      let subjectData: Bytes;
      let subjectIntegrationName: string;
      let subjectCaller: Account;

      beforeEach(async () => {
        const targets = [await getRandomAddress(), await getRandomAddress()];
        const values = [ZERO, ZERO];
        // Random functions from sample Compound governance proposal
        const signatures = ["_supportMarket(address)", "_setReserveFactor(uint256)"];
        // Random bytes from sample Compound governance proposal
        const calldatas = [
          "0x00000000000000000000000070e36f6bf80a52b3b46b3af8e106cc0ed743e8e4",
          "0x00000000000000000000000000000000000000000000000002c68af0bb140000",
        ];
        const description = "Create A Proposal";
        const proposalData = utils.defaultAbiCoder.encode(
          ["address[]", "uint256[]", "string[]", "bytes[]", "string"],
          [targets, values, signatures, calldatas, description]
        );

        await governanceModule.propose(setToken.address, compoundBravoGovernanceAdapterIntegrationName, proposalData);
        await increaseTimeAsync(ONE_DAY_IN_SECONDS);

        subjectSetToken = setToken.address;
        subjectIntegrationName = compoundBravoGovernanceAdapterIntegrationName;
        subjectProposalId = BigNumber.from(2);
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

      it("should vote in Compound", async () => {
        await subject();

        const getProposalData = compoundSetup.compoundGovernorBravoDelegate.interface.encodeFunctionData("proposals", [BigNumber.from(2)]);
        const response = await subjectCaller.wallet.call({ to: compoundSetup.compoundGovernorBravoDelegator.address, data: getProposalData });
        const proposalData = compoundSetup.compoundGovernorBravoDelegate.interface.decodeFunctionResult("proposals", response);

        expect(proposalData.forVotes).to.eq(ether(200000));
        expect(proposalData.againstVotes).to.eq(ZERO);
      });

      context("when voting against", async () => {
        beforeEach(() => {
          subjectSupport = false;
        });

        it("should vote against the proposal in Compound", async () => {
          await subject();

          const getProposalData = compoundSetup.compoundGovernorBravoDelegate.interface.encodeFunctionData("proposals", [BigNumber.from(2)]);
          const response = await subjectCaller.wallet.call({ to: compoundSetup.compoundGovernorBravoDelegator.address, data: getProposalData });
          const proposalData = compoundSetup.compoundGovernorBravoDelegate.interface.decodeFunctionResult("proposals", response);

          expect(proposalData.againstVotes).to.eq(ether(200000));
          expect(proposalData.forVotes).to.eq(ZERO);
        });
      });
    });

    describe("#delegate", async () => {
      let subjectSetToken: Address;
      let subjectDelegatee: Address;
      let subjectIntegrationName: string;
      let subjectCaller: Account;

      beforeEach(async () => {
        subjectSetToken = setToken.address;
        subjectIntegrationName = compoundBravoGovernanceAdapterIntegrationName;
        subjectDelegatee = await getRandomAddress();
        subjectCaller = owner;
      });

      async function subject(): Promise<any> {
        return governanceModule.connect(subjectCaller.wallet).delegate(
          subjectSetToken,
          subjectIntegrationName,
          subjectDelegatee
        );
      }

      it("should delegate to another ETH address", async () => {
        await subject();

        const delegatee = await compoundSetup.comp.delegates(subjectSetToken);
        expect(delegatee).to.eq(subjectDelegatee);
      });
    });

    describe("#register", async () => {
      let subjectSetToken: Address;
      let subjectIntegrationName: string;
      let subjectCaller: Account;

      beforeEach(async () => {
        subjectSetToken = setToken.address;
        subjectIntegrationName = compoundBravoGovernanceAdapterIntegrationName;
        subjectCaller = owner;
      });

      async function subject(): Promise<any> {
        return governanceModule.connect(subjectCaller.wallet).register(
          subjectSetToken,
          subjectIntegrationName,
        );
      }

      it("should register to vote", async () => {
        await subject();

        const delegatee = await compoundSetup.comp.delegates(subjectSetToken);
        expect(delegatee).to.eq(subjectSetToken);
      });
    });

    describe("#revoke", async () => {
      let subjectSetToken: Address;
      let subjectIntegrationName: string;
      let subjectCaller: Account;

      beforeEach(async () => {
        subjectSetToken = setToken.address;
        subjectIntegrationName = compoundBravoGovernanceAdapterIntegrationName;
        subjectCaller = owner;
      });

      async function subject(): Promise<any> {
        return governanceModule.connect(subjectCaller.wallet).revoke(
          subjectSetToken,
          subjectIntegrationName,
        );
      }

      it("should revoke right to vote", async () => {
        await subject();

        const delegatee = await compoundSetup.comp.delegates(subjectSetToken);
        expect(delegatee).to.eq(ADDRESS_ZERO);
      });
    });
  });
});
