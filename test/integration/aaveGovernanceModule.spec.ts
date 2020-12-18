import "module-alias/register";
import { BigNumber, defaultAbiCoder, keccak256 } from "ethers/utils";

import { Address, Account, Bytes } from "@utils/types";
import { ADDRESS_ZERO, EMPTY_BYTES, ONE_DAY_IN_SECONDS, ZERO } from "@utils/constants";
import { AaveGovernanceAdapter, SetToken, GovernanceModule } from "@utils/contracts";
import DeployHelper from "@utils/deploys";
import {
  addSnapshotBeforeRestoreAfterEach,
  ether,
  getAccounts,
  getWaffleExpect,
  getSystemFixture,
  getAaveFixture,
  getRandomAddress,
  increaseTimeAsync,
} from "@utils/index";
import { AaveFixture, SystemFixture } from "@utils/fixtures";

const expect = getWaffleExpect();

describe("AaveGovernanceModule", () => {
  let owner: Account;
  let deployer: DeployHelper;
  let setup: SystemFixture;

  let aaveSetup: AaveFixture;

  let governanceModule: GovernanceModule;
  let aaveGovernanceAdapter: AaveGovernanceAdapter;

  const aaveGovernanceAdapterIntegrationName: string = "AAVE";

  before(async () => {
    [
      owner,
    ] = await getAccounts();

    // System setup
    deployer = new DeployHelper(owner.wallet);
    setup = getSystemFixture(owner.address);
    await setup.initialize();

    // Aave setup
    aaveSetup = getAaveFixture(owner.address);
    await aaveSetup.initialize();

    // GovernanceModule setup
    governanceModule = await deployer.modules.deployGovernanceModule(setup.controller.address);
    await setup.controller.addModule(governanceModule.address);

    // AaveGovernanceAdapter setup
    aaveGovernanceAdapter = await deployer.adapters.deployAaveGovernanceAdapter(
      aaveSetup.aaveProtoGovernance.address,
      aaveSetup.aaveToken.address,
    );

    await setup.integrationRegistry.addIntegration(
      governanceModule.address,
      aaveGovernanceAdapterIntegrationName,
      aaveGovernanceAdapter.address
    );
  });

  addSnapshotBeforeRestoreAfterEach();

  context("when a SetToken has been deployed and issued", async () => {
    let setToken: SetToken;
    let setTokensIssued: BigNumber;

    let componentUnits: BigNumber[];

    before(async () => {
      componentUnits = [ether(1000), ether(100)]; // 1000 AAVE, 100 LEND
      setToken = await setup.createSetToken(
        [aaveSetup.aaveToken.address, aaveSetup.lendToken.address],
        componentUnits,
        [setup.issuanceModule.address, governanceModule.address]
      );

      // Initialize modules
      await setup.issuanceModule.initialize(setToken.address, ADDRESS_ZERO);
      await governanceModule.initialize(setToken.address);

      // Issue some Sets
      setTokensIssued = ether(1);
      await aaveSetup.aaveToken.approve(setup.issuanceModule.address, componentUnits[0]);
      await aaveSetup.lendToken.approve(setup.issuanceModule.address, componentUnits[1]);
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
        await aaveSetup.aaveProtoGovernance.newProposal(
          keccak256(new Buffer("ProposalOne")),
          keccak256(new Buffer("RandomIPFSHash")),
          ether(13000000),
          await getRandomAddress(),
          1660,
          1660,
          5
        );

        const proposalReviewPeriod = ONE_DAY_IN_SECONDS;
        await increaseTimeAsync(proposalReviewPeriod);

        subjectSetToken = setToken.address;
        subjectIntegrationName = aaveGovernanceAdapterIntegrationName;
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

        const votesData = await aaveSetup.aaveProtoGovernance.getVotesData(ZERO);
        expect(votesData[0]).to.eq(ZERO);
        expect(votesData[1]).to.eq(componentUnits[0]);
        expect(votesData[2]).to.eq(ZERO);
      });

      describe("when voting with another supported token", () => {
        beforeEach(async () => {
          subjectData = defaultAbiCoder.encode(
            ["address"],
            [aaveSetup.lendToken.address]
          );
        });

        it("should vote with LEND token", async () => {
          await subject();

          const votesData = await aaveSetup.aaveProtoGovernance.getVotesData(ZERO);
          expect(votesData[0]).to.eq(ZERO);
          expect(votesData[1]).to.eq(componentUnits[1]);
          expect(votesData[2]).to.eq(ZERO);
        });
      });

      describe("when voting against a proposal", () => {
        beforeEach(async () => {
          subjectSupport = false;
        });

        it("should vote false", async () => {
          await subject();

          const votesData = await aaveSetup.aaveProtoGovernance.getVotesData(ZERO);
          expect(votesData[0]).to.eq(ZERO);
          expect(votesData[1]).to.eq(ZERO);
          expect(votesData[2]).to.eq(componentUnits[0]);
        });
      });
    });
  });
});
