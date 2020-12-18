import "module-alias/register";

import { Address, Account, Bytes } from "@utils/types";
import { GovernanceModule, GovernanceAdapterMock, SetToken } from "@utils/contracts";
import DeployHelper from "@utils/deploys";
import {
  addSnapshotBeforeRestoreAfterEach,
  ether,
  getAccounts,
  getWaffleExpect,
  getSystemFixture,
  getRandomAccount,
  getRandomAddress,
  bigNumberToData,
} from "@utils/index";
import { SystemFixture } from "@utils/fixtures";
import { BigNumber } from "ethers/utils";
import { ADDRESS_ZERO, ONE, TWO, ZERO, EMPTY_BYTES } from "@utils/constants";

const expect = getWaffleExpect();

describe("GovernanceModule", () => {
  let owner: Account;
  let deployer: DeployHelper;
  let setup: SystemFixture;

  let governanceModule: GovernanceModule;
  let governanceAdapterMock: GovernanceAdapterMock;
  let governanceAdapterMock2: GovernanceAdapterMock;

  const governanceAdapterMockIntegrationName: string = "MOCK_GOV";
  const governanceAdapterMockIntegrationName2: string = "MOCK2_GOV";

  before(async () => {
    [
      owner,
    ] = await getAccounts();

    deployer = new DeployHelper(owner.wallet);
    setup = getSystemFixture(owner.address);
    await setup.initialize();

    governanceModule = await deployer.modules.deployGovernanceModule(setup.controller.address);
    await setup.controller.addModule(governanceModule.address);

    governanceAdapterMock = await deployer.mocks.deployGovernanceAdapterMock(ZERO);
    await setup.integrationRegistry.addIntegration(governanceModule.address, governanceAdapterMockIntegrationName, governanceAdapterMock.address);
    governanceAdapterMock2 = await deployer.mocks.deployGovernanceAdapterMock(ONE);
    await setup.integrationRegistry.addIntegration(governanceModule.address, governanceAdapterMockIntegrationName2, governanceAdapterMock2.address);
  });

  addSnapshotBeforeRestoreAfterEach();

  describe("#constructor", async () => {
    let subjectController: Address;

    beforeEach(async () => {
      subjectController = setup.controller.address;
    });

    async function subject(): Promise<any> {
      return deployer.modules.deployGovernanceModule(subjectController);
    }

    it("should set the correct controller", async () => {
      const governanceModule = await subject();

      const controller = await governanceModule.controller();
      expect(controller).to.eq(subjectController);
    });
  });

  describe("#initialize", async () => {
    let setToken: SetToken;
    let subjectSetToken: Address;
    let subjectCaller: Account;

    beforeEach(async () => {
      setToken = await setup.createSetToken(
        [setup.weth.address],
        [ether(1)],
        [governanceModule.address]
      );
      subjectSetToken = setToken.address;
      subjectCaller = owner;
    });

    async function subject(): Promise<any> {
      return governanceModule.connect(subjectCaller.wallet).initialize(subjectSetToken);
    }

    it("should enable the Module on the SetToken", async () => {
      await subject();
      const isModuleEnabled = await setToken.isInitializedModule(governanceModule.address);
      expect(isModuleEnabled).to.eq(true);
    });

    describe("when the caller is not the SetToken manager", async () => {
      beforeEach(async () => {
        subjectCaller = await getRandomAccount();
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Must be the SetToken manager");
      });
    });

    describe("when module is in NONE state", async () => {
      beforeEach(async () => {
        await subject();
        await setToken.removeModule(governanceModule.address);
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Must be pending initialization");
      });
    });

    describe("when module is in INITIALIZED state", async () => {
      beforeEach(async () => {
        await subject();
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Must be pending initialization");
      });
    });

    describe("when the SetToken is not enabled on the controller", async () => {
      beforeEach(async () => {
        const nonEnabledSetToken = await setup.createNonControllerEnabledSetToken(
          [setup.weth.address],
          [ether(1)],
          [governanceModule.address]
        );

        subjectSetToken = nonEnabledSetToken.address;
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Must be controller-enabled SetToken");
      });
    });
  });

  describe("#removeModule", async () => {
    let setToken: SetToken;
    let subjectModule: Address;
    let subjectCaller: Account;

    beforeEach(async () => {
      setToken = await setup.createSetToken(
        [setup.weth.address],
        [ether(1)],
        [governanceModule.address]
      );

      subjectModule = governanceModule.address;
      subjectCaller = owner;

      await governanceModule.initialize(setToken.address);
    });

    async function subject(): Promise<any> {
      return setToken.connect(subjectCaller.wallet).removeModule(subjectModule);
    }

    it("should properly remove the module and settings", async () => {
      await subject();

      const isModuleEnabled = await setToken.isInitializedModule(subjectModule);
      expect(isModuleEnabled).to.eq(false);
    });
  });

  describe("#vote", async () => {
    let setToken: SetToken;
    let isInitialized: boolean;

    let subjectCaller: Account;
    let subjectIntegration: string;
    let subjectProposalId: BigNumber;
    let subjectSupport: boolean;
    let subjectSetToken: Address;
    let subjectData: Bytes;

    before(async () => {
      isInitialized = true;
    });

    beforeEach(async () => {
      setToken = await setup.createSetToken(
        [setup.weth.address],
        [ether(1)],
        [governanceModule.address]
      );

      subjectCaller = owner;

      subjectProposalId = ZERO;
      subjectSetToken = setToken.address;
      subjectIntegration = governanceAdapterMockIntegrationName;
      subjectSupport = true;
      subjectData = EMPTY_BYTES;

      if (isInitialized) {
        await governanceModule.initialize(setToken.address);
      }
    });

    async function subject(): Promise<any> {
      return governanceModule.connect(subjectCaller.wallet).vote(
        subjectSetToken,
        subjectIntegration,
        subjectProposalId,
        subjectSupport,
        subjectData
      );
    }

    it("should vote in proposal for the governance integration", async () => {
      const proposalStatusBefore = await governanceAdapterMock.proposalToVote(subjectProposalId);
      expect(proposalStatusBefore).to.eq(false);

      await subject();

      const proposalStatusAfter = await governanceAdapterMock.proposalToVote(subjectProposalId);
      expect(proposalStatusAfter).to.eq(true);
    });

    it("emits the correct ProposalVoted event", async () => {
      await expect(subject()).to.emit(governanceModule, "ProposalVoted").withArgs(
        subjectSetToken,
        governanceAdapterMock.address,
        subjectProposalId,
        subjectSupport
      );
    });

    describe("when the governance integration is not present", async () => {
      beforeEach(async () => {
        subjectIntegration = await getRandomAddress();
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Must be valid adapter");
      });
    });

    describe("when caller is not manager", async () => {
      beforeEach(async () => {
        subjectCaller = await getRandomAccount();
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Must be the SetToken manager");
      });
    });

    describe("when module is not initialized", async () => {
      before(async () => {
        isInitialized = false;
      });

      after(async () => {
        isInitialized = true;
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Must be a valid and initialized SetToken");
      });
    });

    describe("when SetToken is not valid", async () => {
      beforeEach(async () => {
        const nonEnabledSetToken = await setup.createNonControllerEnabledSetToken(
          [setup.weth.address],
          [ether(1)],
          [governanceModule.address]
        );

        subjectSetToken = nonEnabledSetToken.address;
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Must be a valid and initialized SetToken");
      });
    });
  });

  describe("#propose", async () => {
    let setToken: SetToken;
    let isInitialized: boolean;

    let subjectCaller: Account;
    let subjectIntegration: string;
    let subjectSetToken: Address;
    let subjectProposalData: Bytes;

    before(async () => {
      isInitialized = true;
    });

    beforeEach(async () => {
      setToken = await setup.createSetToken(
        [setup.weth.address],
        [ether(1)],
        [governanceModule.address]
      );

      // Get proposal data for mock governance adapter
      const proposalData = "0x" + bigNumberToData(TWO);

      subjectCaller = owner;

      subjectSetToken = setToken.address;
      subjectIntegration = governanceAdapterMockIntegrationName;
      subjectProposalData = proposalData;

      if (isInitialized) {
        await governanceModule.initialize(setToken.address);
      }
    });

    async function subject(): Promise<any> {
      return governanceModule.connect(subjectCaller.wallet).propose(
        subjectSetToken,
        subjectIntegration,
        subjectProposalData
      );
    }

    it("should create a new proposal for the governance integration", async () => {
      const proposalStatusBefore = await governanceAdapterMock.proposalCreated(TWO);
      expect(proposalStatusBefore).to.eq(false);

      await subject();

      const proposalStatusAfter = await governanceAdapterMock.proposalCreated(TWO);
      expect(proposalStatusAfter).to.eq(true);
    });

    it("emits the correct ProposalCreated event", async () => {
      await expect(subject()).to.emit(governanceModule, "ProposalCreated").withArgs(
        subjectSetToken,
        governanceAdapterMock.address,
        subjectProposalData
      );
    });

    describe("when the governance integration is not present", async () => {
      beforeEach(async () => {
        subjectIntegration = await getRandomAddress();
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Must be valid adapter");
      });
    });

    describe("when caller is not manager", async () => {
      beforeEach(async () => {
        subjectCaller = await getRandomAccount();
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Must be the SetToken manager");
      });
    });

    describe("when module is not initialized", async () => {
      before(async () => {
        isInitialized = false;
      });

      after(async () => {
        isInitialized = true;
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Must be a valid and initialized SetToken");
      });
    });

    describe("when SetToken is not valid", async () => {
      beforeEach(async () => {
        const nonEnabledSetToken = await setup.createNonControllerEnabledSetToken(
          [setup.weth.address],
          [ether(1)],
          [governanceModule.address]
        );

        subjectSetToken = nonEnabledSetToken.address;
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Must be a valid and initialized SetToken");
      });
    });
  });

  describe("#delegate", async () => {
    let setToken: SetToken;
    let isInitialized: boolean;

    let subjectCaller: Account;
    let subjectIntegration: string;
    let subjectSetToken: Address;
    let subjectDelegatee: Address;

    before(async () => {
      isInitialized = true;
    });

    beforeEach(async () => {
      setToken = await setup.createSetToken(
        [setup.weth.address],
        [ether(1)],
        [governanceModule.address]
      );

      subjectCaller = owner;

      subjectSetToken = setToken.address;
      subjectIntegration = governanceAdapterMockIntegrationName;
      subjectDelegatee = owner.address; // Delegate to owner

      if (isInitialized) {
        await governanceModule.initialize(setToken.address);
      }
    });

    async function subject(): Promise<any> {
      return governanceModule.connect(subjectCaller.wallet).delegate(
        subjectSetToken,
        subjectIntegration,
        subjectDelegatee,
      );
    }

    it("should delegate to the correct ETH address", async () => {
      await subject();

      const delegatee = await governanceAdapterMock.delegatee();
      expect(delegatee).to.eq(subjectDelegatee);
    });

    it("emits the correct VoteDelegated event", async () => {
      await expect(subject()).to.emit(governanceModule, "VoteDelegated").withArgs(
        subjectSetToken,
        governanceAdapterMock.address,
        subjectDelegatee
      );
    });

    describe("when the governance integration is not present", async () => {
      beforeEach(async () => {
        subjectIntegration = await getRandomAddress();
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Must be valid adapter");
      });
    });

    describe("when caller is not manager", async () => {
      beforeEach(async () => {
        subjectCaller = await getRandomAccount();
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Must be the SetToken manager");
      });
    });

    describe("when module is not initialized", async () => {
      before(async () => {
        isInitialized = false;
      });

      after(async () => {
        isInitialized = true;
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Must be a valid and initialized SetToken");
      });
    });

    describe("when SetToken is not valid", async () => {
      beforeEach(async () => {
        const nonEnabledSetToken = await setup.createNonControllerEnabledSetToken(
          [setup.weth.address],
          [ether(1)],
          [governanceModule.address]
        );

        subjectSetToken = nonEnabledSetToken.address;
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Must be a valid and initialized SetToken");
      });
    });
  });

  describe("#register", async () => {
    let setToken: SetToken;
    let isInitialized: boolean;

    let subjectCaller: Account;
    let subjectIntegration: string;
    let subjectSetToken: Address;

    before(async () => {
      isInitialized = true;
    });

    beforeEach(async () => {
      setToken = await setup.createSetToken(
        [setup.weth.address],
        [ether(1)],
        [governanceModule.address]
      );

      subjectCaller = owner;

      subjectSetToken = setToken.address;
      subjectIntegration = governanceAdapterMockIntegrationName;

      if (isInitialized) {
        await governanceModule.initialize(setToken.address);
      }
    });

    async function subject(): Promise<any> {
      return governanceModule.connect(subjectCaller.wallet).register(
        subjectSetToken,
        subjectIntegration,
      );
    }

    it("should register the SetToken for voting", async () => {
      await subject();

      const delegatee = await governanceAdapterMock.delegatee();
      expect(delegatee).to.eq(subjectSetToken);
    });

    it("emits the correct RegistrationSubmitted event", async () => {
      await expect(subject()).to.emit(governanceModule, "RegistrationSubmitted").withArgs(
        subjectSetToken,
        governanceAdapterMock.address
      );
    });

    describe("when the governance integration is not present", async () => {
      beforeEach(async () => {
        subjectIntegration = await getRandomAddress();
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Must be valid adapter");
      });
    });

    describe("when caller is not manager", async () => {
      beforeEach(async () => {
        subjectCaller = await getRandomAccount();
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Must be the SetToken manager");
      });
    });

    describe("when module is not initialized", async () => {
      before(async () => {
        isInitialized = false;
      });

      after(async () => {
        isInitialized = true;
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Must be a valid and initialized SetToken");
      });
    });

    describe("when SetToken is not valid", async () => {
      beforeEach(async () => {
        const nonEnabledSetToken = await setup.createNonControllerEnabledSetToken(
          [setup.weth.address],
          [ether(1)],
          [governanceModule.address]
        );

        subjectSetToken = nonEnabledSetToken.address;
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Must be a valid and initialized SetToken");
      });
    });
  });

  describe("#revoke", async () => {
    let setToken: SetToken;
    let isInitialized: boolean;

    let subjectCaller: Account;
    let subjectIntegration: string;
    let subjectSetToken: Address;

    before(async () => {
      isInitialized = true;
    });

    beforeEach(async () => {
      setToken = await setup.createSetToken(
        [setup.weth.address],
        [ether(1)],
        [governanceModule.address]
      );

      subjectCaller = owner;

      subjectSetToken = setToken.address;
      subjectIntegration = governanceAdapterMockIntegrationName;

      if (isInitialized) {
        await governanceModule.initialize(setToken.address);
      }
    });

    async function subject(): Promise<any> {
      return governanceModule.connect(subjectCaller.wallet).revoke(
        subjectSetToken,
        subjectIntegration,
      );
    }

    it("should revoke the SetToken for voting", async () => {
      await subject();

      const delegatee = await governanceAdapterMock.delegatee();
      expect(delegatee).to.eq(ADDRESS_ZERO);
    });

    it("emits the correct RegistrationRevoked event", async () => {
      await expect(subject()).to.emit(governanceModule, "RegistrationRevoked").withArgs(
        subjectSetToken,
        governanceAdapterMock.address
      );
    });

    describe("when the governance integration is not present", async () => {
      beforeEach(async () => {
        subjectIntegration = await getRandomAddress();
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Must be valid adapter");
      });
    });

    describe("when caller is not manager", async () => {
      beforeEach(async () => {
        subjectCaller = await getRandomAccount();
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Must be the SetToken manager");
      });
    });

    describe("when module is not initialized", async () => {
      before(async () => {
        isInitialized = false;
      });

      after(async () => {
        isInitialized = true;
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Must be a valid and initialized SetToken");
      });
    });

    describe("when SetToken is not valid", async () => {
      beforeEach(async () => {
        const nonEnabledSetToken = await setup.createNonControllerEnabledSetToken(
          [setup.weth.address],
          [ether(1)],
          [governanceModule.address]
        );

        subjectSetToken = nonEnabledSetToken.address;
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Must be a valid and initialized SetToken");
      });
    });
  });
});
