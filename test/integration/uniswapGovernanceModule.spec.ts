import "module-alias/register";
import { BigNumber, utils } from "ethers";

import { Address, Bytes } from "@utils/types";
import { Account } from "@utils/test/types";
import { ADDRESS_ZERO, EMPTY_BYTES, ONE, ONE_DAY_IN_SECONDS, ZERO } from "@utils/constants";
import { CompoundLikeGovernanceAdapter, SetToken, GovernanceModule } from "@utils/contracts";
import DeployHelper from "@utils/deploys";
import {
  ether,
} from "@utils/index";
import {
  getAccounts,
  getWaffleExpect,
  getSystemFixture,
  getUniswapFixture,
  getRandomAddress,
  increaseTimeAsync,
  addSnapshotBeforeRestoreAfterEach,
} from "@utils/test/index";
import { UniswapFixture, SystemFixture } from "@utils/fixtures";

const expect = getWaffleExpect();

describe("UniswapGovernanceModule", () => {
  let owner: Account;
  let deployer: DeployHelper;
  let setup: SystemFixture;

  let uniswapSetup: UniswapFixture;

  let governanceModule: GovernanceModule;
  let compoundLikeGovernanceAdapter: CompoundLikeGovernanceAdapter;

  const compoundLikeGovernanceAdapterIntegrationName: string = "UNISWAP";

  before(async () => {
    [
      owner,
    ] = await getAccounts();

    // System setup
    deployer = new DeployHelper(owner.wallet);
    setup = getSystemFixture(owner.address);
    await setup.initialize();

    // Uniswap setup
    uniswapSetup = getUniswapFixture(owner.address);
    await uniswapSetup.initialize(owner, setup.weth.address, setup.wbtc.address, setup.dai.address);

    // GovernanceModule setup
    governanceModule = await deployer.modules.deployGovernanceModule(setup.controller.address);
    await setup.controller.addModule(governanceModule.address);

    // CompoundLikeGovernanceAdapter setup
    compoundLikeGovernanceAdapter = await deployer.adapters.deployCompoundLikeGovernanceAdapter(
      uniswapSetup.uniswapGovernorAlpha.address,
      uniswapSetup.uni.address,
    );

    await setup.integrationRegistry.addIntegration(
      governanceModule.address,
      compoundLikeGovernanceAdapterIntegrationName,
      compoundLikeGovernanceAdapter.address
    );
  });

  addSnapshotBeforeRestoreAfterEach();

  context("when a SetToken has been deployed and issued", async () => {
    let setToken: SetToken;
    let setTokensIssued: BigNumber;

    before(async () => {
      setToken = await setup.createSetToken(
        [uniswapSetup.uni.address],
        [ether(20000000)], // 20m UNI
        [setup.issuanceModule.address, governanceModule.address]
      );

      // Initialize modules
      await setup.issuanceModule.initialize(setToken.address, ADDRESS_ZERO);
      await governanceModule.initialize(setToken.address);

      // Issue some Sets
      setTokensIssued = ether(1);
      const underlyingRequired = ether(20000000);
      await uniswapSetup.uni.approve(setup.issuanceModule.address, underlyingRequired);
      await setup.issuanceModule.issue(setToken.address, setTokensIssued, owner.address);

      // Register for voting
      await governanceModule.register(setToken.address, compoundLikeGovernanceAdapterIntegrationName);
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
        subjectIntegrationName = compoundLikeGovernanceAdapterIntegrationName;
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

      it("should create a proposal in Uniswap", async () => {
        await subject();

        const proposalData = await uniswapSetup.uniswapGovernorAlpha.proposals(ONE);
        expect(proposalData.id).to.eq(ONE);
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

        await governanceModule.propose(setToken.address, compoundLikeGovernanceAdapterIntegrationName, proposalData);
        await increaseTimeAsync(ONE_DAY_IN_SECONDS);

        subjectSetToken = setToken.address;
        subjectIntegrationName = compoundLikeGovernanceAdapterIntegrationName;
        subjectProposalId = ONE;
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

      it("should vote in Uniswap", async () => {
        await subject();

        const proposalData = await uniswapSetup.uniswapGovernorAlpha.proposals(ONE);
        expect(proposalData.forVotes).to.eq(ether(20000000));
        expect(proposalData.againstVotes).to.eq(ZERO);
      });
    });

    describe("#delegate", async () => {
      let subjectSetToken: Address;
      let subjectDelegatee: Address;
      let subjectIntegrationName: string;
      let subjectCaller: Account;

      beforeEach(async () => {
        subjectSetToken = setToken.address;
        subjectIntegrationName = compoundLikeGovernanceAdapterIntegrationName;
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

        const delegatee = await uniswapSetup.uni.delegates(subjectSetToken);
        expect(delegatee).to.eq(subjectDelegatee);
      });
    });

    describe("#register", async () => {
      let subjectSetToken: Address;
      let subjectIntegrationName: string;
      let subjectCaller: Account;

      beforeEach(async () => {
        subjectSetToken = setToken.address;
        subjectIntegrationName = compoundLikeGovernanceAdapterIntegrationName;
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

        const delegatee = await uniswapSetup.uni.delegates(subjectSetToken);
        expect(delegatee).to.eq(subjectSetToken);
      });
    });

    describe("#revoke", async () => {
      let subjectSetToken: Address;
      let subjectIntegrationName: string;
      let subjectCaller: Account;

      beforeEach(async () => {
        subjectSetToken = setToken.address;
        subjectIntegrationName = compoundLikeGovernanceAdapterIntegrationName;
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

        const delegatee = await uniswapSetup.uni.delegates(subjectSetToken);
        expect(delegatee).to.eq(ADDRESS_ZERO);
      });
    });
  });
});
