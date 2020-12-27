import "module-alias/register";
import { BigNumber, defaultAbiCoder } from "ethers/utils";

import { Address, Account, Bytes } from "@utils/types";
import { ADDRESS_ZERO, EMPTY_BYTES, ONE, ONE_DAY_IN_SECONDS, ZERO } from "@utils/constants";
import { MakerPollingGovernanceAdapter, SetToken, GovernanceModule } from "@utils/contracts";
import DeployHelper from "@utils/deploys";
import {
  addSnapshotBeforeRestoreAfterEach,
  ether,
  getAccounts,
  getWaffleExpect,
  getSystemFixture,
  getMakerFixture,
  getRandomAddress,
  increaseTimeAsync,
} from "@utils/index";
import { MakerFixture, SystemFixture } from "@utils/fixtures";

const expect = getWaffleExpect();

describe("Maker Governance", () => {
  let owner: Account;
  let deployer: DeployHelper;
  let setup: SystemFixture;

  let makerSetup: MakerFixture;

  let governanceModule: GovernanceModule;
  let makerPollingGovernanceAdapter: MakerPollingGovernanceAdapter;

  const makerPollingGovernanceAdapterIntegrationName: string = "MAKER_POLLING";

  before(async () => {
    [
      owner,
    ] = await getAccounts();

    // System setup
    deployer = new DeployHelper(owner.wallet);
    setup = getSystemFixture(owner.address);
    await setup.initialize();

    // Maker setup
    makerSetup = getMakerFixture(owner.address);
    await makerSetup.initialize(owner);

    // GovernanceModule setup
    governanceModule = await deployer.modules.deployGovernanceModule(setup.controller.address);
    await setup.controller.addModule(governanceModule.address);

    // makerPollingGovernanceAdapter setup
    makerPollingGovernanceAdapter = await deployer.adapters.deployMakerPollingGovernanceAdapter(
      makerSetup.makerPollingEmitter.address,
      makerSetup.mkr.address,
    );

    await setup.integrationRegistry.addIntegration(
      governanceModule.address,
      makerPollingGovernanceAdapterIntegrationName,
      makerPollingGovernanceAdapter.address
    );
  });

  addSnapshotBeforeRestoreAfterEach();

  context("when a SetToken has been deployed and issued with MKR as a component", async () => {
    let setToken: SetToken;
    let setTokensIssued: BigNumber;

    before(async () => {
      setToken = await setup.createSetToken(
        [makerSetup.mkr.address],
        [ether(20000000)], // 20m Mkr
        [setup.issuanceModule.address, governanceModule.address]
      );

      // Initialize modules
      await setup.issuanceModule.initialize(setToken.address, ADDRESS_ZERO);
      await governanceModule.initialize(setToken.address);

      // Issue some Sets
      setTokensIssued = ether(1);
      const underlyingRequired = ether(20000000);
      await makerSetup.mkr.approve(setup.issuanceModule.address, underlyingRequired);
      await setup.issuanceModule.issue(setToken.address, setTokensIssued, owner.address);
    });

    // describe("#propose", async () => {
    //   let targets: Address[];
    //   let values: BigNumber[];
    //   let signatures: string[];
    //   let calldatas: Bytes[];
    //   let description: string;

    //   let subjectSetToken: Address;
    //   let subjectProposalData: Bytes;
    //   let subjectIntegrationName: string;
    //   let subjectCaller: Account;

    //   beforeEach(async () => {
    //     targets = [await getRandomAddress(), await getRandomAddress()];
    //     values = [ZERO, ZERO];
    //     // Random functions from sample Compound governance proposal
    //     signatures = ["_supportMarket(address)", "_setReserveFactor(uint256)"];
    //     // Random bytes from sample Compound governance proposal
    //     calldatas = [
    //       "0x00000000000000000000000070e36f6bf80a52b3b46b3af8e106cc0ed743e8e4",
    //       "0x00000000000000000000000000000000000000000000000002c68af0bb140000",
    //     ];
    //     description = "Create A Proposal";

    //     subjectSetToken = setToken.address;
    //     subjectIntegrationName = makerPollingGovernanceAdapterIntegrationName;
    //     subjectProposalData = defaultAbiCoder.encode(
    //       ["address[]", "uint256[]", "string[]", "bytes[]", "string"],
    //       [targets, values, signatures, calldatas, description]
    //     );
    //     subjectCaller = owner;
    //   });

    //   async function subject(): Promise<any> {
    //     return governanceModule.connect(subjectCaller.wallet).propose(
    //       subjectSetToken,
    //       subjectIntegrationName,
    //       subjectProposalData
    //     );
    //   }

    //   it("should create a proposal in Maker", async () => {
    //     await subject();

    //     const proposalData = await makerSetup.MakerGovernorAlpha.proposals(ONE);
    //     expect(proposalData.id).to.eq(ONE);
    //     expect(proposalData.proposer).to.eq(subjectSetToken);
    //   });
    // });

    describe("#getDelegateCalldata", async () => {
      let subjectDelegatee: Address;

      beforeEach(async () => {
        subjectDelegatee = await getRandomAddress();
      });

      async function subject(): Promise<any> {
        return makerPollingGovernanceAdapter.getDelegateCalldata(subjectDelegatee);
      }

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("No delegation available in MKR community polling");
      });
    });

    describe("#getRegisterCalldata", async () => {
      let subjectSetToken: Address;

      beforeEach(async () => {
        subjectSetToken = setToken.address;
      });

      async function subject(): Promise<any> {
        return makerPollingGovernanceAdapter.getRegisterCalldata(subjectSetToken);
      }

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("No register available in MKR community polling");
      });
    });

    describe("#getRevokeCalldata", async () => {
      async function subject(): Promise<any> {
        return makerPollingGovernanceAdapter.getRevokeCalldata();
      }

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("No revoke available in MKR community polling");
      });
    });

    describe("#vote", async () => {
      let optionId: BigNumber;

      let subjectSetToken: Address;
      let subjectIntegrationName: string;
      let subjectProposalId: BigNumber;
      let subjectSupport: boolean;
      let subjectData: Bytes;
      let subjectCaller: Account;

      beforeEach(async () => {
        const optionId = ONE;
        const optionIdCallData = defaultAbiCoder.encode(
          ["uint256"],
          [optionId]
        );

        subjectSetToken = setToken.address;
        subjectIntegrationName = makerPollingGovernanceAdapterIntegrationName;
        subjectProposalId = ONE;
        subjectSupport = false;
        subjectData = optionIdCallData;
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

      it("should vote in Maker", async () => {
        await expect(subject()).to.emit(makerSetup.makerPollingEmitter, "Voted").withArgs(
          subjectSetToken,
          subjectProposalId,
          optionId,
        );
      });
    });
  });
});
