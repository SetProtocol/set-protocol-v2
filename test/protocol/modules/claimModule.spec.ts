import "module-alias/register";

import { Address, Account } from "@utils/types";
import { ClaimModule, ClaimAdapterMock, SetToken } from "@utils/contracts";
import DeployHelper from "@utils/deploys";
import {
  addSnapshotBeforeRestoreAfterEach,
  ether,
  getAccounts,
  getWaffleExpect,
  getSystemFixture,
  getRandomAccount,
  getRandomAddress,
} from "@utils/index";
import { SystemFixture } from "@utils/fixtures";
import { BigNumber } from "@ethersproject/bignumber";
import { ZERO } from "@utils/constants";

const expect = getWaffleExpect();

describe("ClaimModule", () => {
  let owner: Account;
  let deployer: DeployHelper;
  let setup: SystemFixture;

  let claimModule: ClaimModule;
  let claimAdapterMock: ClaimAdapterMock;
  let claimAdapterMock2: ClaimAdapterMock;

  const claimAdapterMockIntegrationName: string = "MOCK_CLAIM";
  const claimAdapterMockIntegrationName2: string = "MOCK2_CLAIM";

  before(async () => {
    [
      owner,
    ] = await getAccounts();

    deployer = new DeployHelper(owner.wallet);
    setup = getSystemFixture(owner.address);
    await setup.initialize();

    claimModule = await deployer.modules.deployClaimModule(setup.controller.address);
    await setup.controller.addModule(claimModule.address);

    claimAdapterMock = await deployer.mocks.deployClaimAdapterMock();
    await setup.integrationRegistry.addIntegration(claimModule.address, claimAdapterMockIntegrationName, claimAdapterMock.address);
    claimAdapterMock2 = await deployer.mocks.deployClaimAdapterMock();
    await setup.integrationRegistry.addIntegration(claimModule.address, claimAdapterMockIntegrationName2, claimAdapterMock2.address);
  });

  addSnapshotBeforeRestoreAfterEach();

  describe("#constructor", async () => {
    let subjectController: Address;

    beforeEach(async () => {
      subjectController = setup.controller.address;
    });

    async function subject(): Promise<any> {
      return deployer.modules.deployClaimModule(subjectController);
    }

    it("should set the correct controller", async () => {
      const claimModule = await subject();

      const controller = await claimModule.controller();
      expect(controller).to.eq(subjectController);
    });
  });

  describe("#initialize", async () => {
    let setToken: SetToken;
    let subjectSetToken: Address;
    let subjectRewardPools: Address[];
    let subjectIntegrations: string[];
    let subjectAnyoneClaim: boolean;
    let subjectCaller: Account;

    beforeEach(async () => {
      setToken = await setup.createSetToken(
        [setup.weth.address],
        [ether(1)],
        [claimModule.address]
      );
      subjectSetToken = setToken.address;
      subjectRewardPools = [await getRandomAddress(), await getRandomAddress()];
      subjectIntegrations = [claimAdapterMockIntegrationName, claimAdapterMockIntegrationName2];
      subjectCaller = owner;
      subjectAnyoneClaim = true;
    });

    async function subject(): Promise<any> {
      return claimModule.connect(subjectCaller.wallet).initialize(subjectSetToken, subjectAnyoneClaim, subjectRewardPools, subjectIntegrations);
    }

    it("should enable the Module on the SetToken", async () => {
      await subject();
      const isModuleEnabled = await setToken.isInitializedModule(claimModule.address);
      expect(isModuleEnabled).to.eq(true);
    });

    it("should set the anyoneClaim field", async () => {
      const anyoneClaimBefore = await claimModule.anyoneClaim(subjectSetToken);
      expect(anyoneClaimBefore).to.eq(false);

      await subject();

      const anyoneClaim = await claimModule.anyoneClaim(subjectSetToken);
      expect(anyoneClaim).to.eq(true);
    });

    it("should add the rewardPools to the rewardPoolList", async () => {
      expect((await claimModule.getRewardPools(subjectSetToken)).length).to.eq(0);

      await subject();

      const rewardPools = await claimModule.getRewardPools(subjectSetToken);
      expect(rewardPools[0]).to.eq(subjectRewardPools[0]);
      expect(rewardPools[1]).to.eq(subjectRewardPools[1]);
    });

    it("should add all new integrations for the rewardPools", async () => {
      await subject();

      const rewardPoolOneClaims = await claimModule.getRewardPoolClaims(setToken.address, subjectRewardPools[0]);
      const rewardPoolTwoClaims = await claimModule.getRewardPoolClaims(setToken.address, subjectRewardPools[1]);
      expect(rewardPoolOneClaims[0]).to.eq(claimAdapterMock.address);
      expect(rewardPoolTwoClaims[0]).to.eq(claimAdapterMock2.address);
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
        await setToken.removeModule(claimModule.address);
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
          [claimModule.address]
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
    let anyoneClaim: boolean;
    let rewardPool: Address;

    beforeEach(async () => {
      setToken = await setup.createSetToken(
        [setup.weth.address],
        [ether(1)],
        [claimModule.address]
      );
      anyoneClaim = true;

      subjectModule = claimModule.address;
      subjectCaller = owner;

      rewardPool = await getRandomAddress();
      await claimModule.initialize(setToken.address, anyoneClaim, [rewardPool], [claimAdapterMockIntegrationName]);
    });

    async function subject(): Promise<any> {
      return setToken.connect(subjectCaller.wallet).removeModule(subjectModule);
    }

    it("should properly remove the module and settings", async () => {
      const rewardPoolsBefore = await claimModule.getRewardPools(setToken.address);
      const rewardPoolClaimsBefore = await claimModule.getRewardPoolClaims(setToken.address, rewardPool);
      expect(rewardPoolsBefore.length).to.eq(1);
      expect(rewardPoolClaimsBefore.length).to.eq(1);

      await subject();

      const rewardPools = await claimModule.getRewardPools(setToken.address);
      const rewardPoolClaims = await claimModule.getRewardPoolClaims(setToken.address, rewardPool);
      expect(rewardPools.length).to.eq(0);
      expect(rewardPoolClaims.length).to.eq(0);
      const isModuleEnabled = await setToken.isInitializedModule(subjectModule);
      expect(isModuleEnabled).to.eq(false);
    });
  });

  describe("#updateAnyoneClaim", async () => {
    let setToken: SetToken;
    let isInitialized: boolean;

    let subjectSetToken: Address;
    let subjectCaller: Account;

    before(async () => {
      isInitialized = true;
    });

    beforeEach(async () => {
      setToken = await setup.createSetToken(
        [setup.weth.address],
        [ether(1)],
        [claimModule.address]
      );

      if (isInitialized) {
        await claimModule.initialize(setToken.address, true, [await getRandomAddress()], [claimAdapterMockIntegrationName2]);
      }

      subjectSetToken = setToken.address;
      subjectCaller = owner;
    });

    async function subject(): Promise<any> {
      return claimModule.connect(subjectCaller.wallet).updateAnyoneClaim(subjectSetToken);
    }

    it("should flip the anyoneClaim indicator", async () => {
      const anyoneClaimBefore = await claimModule.anyoneClaim(subjectSetToken);
      expect(anyoneClaimBefore).to.eq(true);

      await subject();

      const anyoneClaim = await claimModule.anyoneClaim(subjectSetToken);
      expect(anyoneClaim).to.eq(false);

      await subject();

      const anyoneClaimAfter = await claimModule.anyoneClaim(subjectSetToken);
      expect(anyoneClaimAfter).to.eq(true);
    });

    describe("when caller is not SetToken manager", async () => {
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

    describe("when the SetToken is not valid", async () => {
      beforeEach(async () => {
        const nonEnabledSetToken = await setup.createNonControllerEnabledSetToken(
          [setup.weth.address],
          [ether(1)],
          [claimModule.address]
        );

        subjectSetToken = nonEnabledSetToken.address;
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Must be a valid and initialized SetToken");
      });
    });
  });

  describe("#batchAddClaim", async () => {
    let setToken: SetToken;
    let isInitialized: boolean;

    let subjectSetToken: Address;
    let subjectRewardPools: Address[];
    let subjectIntegrations: string[];
    let subjectCaller: Account;

    before(async () => {
      isInitialized = true;
    });

    beforeEach(async () => {
      setToken = await setup.createSetToken(
        [setup.weth.address],
        [ether(1)],
        [claimModule.address]
      );

      subjectCaller = owner;
      const [rewardPoolOne, rewardPoolTwo] = [await getRandomAddress(), await getRandomAddress()];
      subjectRewardPools = [rewardPoolOne, rewardPoolOne, rewardPoolTwo];
      subjectIntegrations = [claimAdapterMockIntegrationName, claimAdapterMockIntegrationName2, claimAdapterMockIntegrationName];
      subjectSetToken = setToken.address;

      if (isInitialized) {
        await claimModule.initialize(setToken.address, true, [await getRandomAddress()], [claimAdapterMockIntegrationName2]);
      }
    });

    async function subject(): Promise<any> {
      return claimModule.connect(subjectCaller.wallet).batchAddClaim(subjectSetToken, subjectRewardPools, subjectIntegrations);
    }

    it("should add the rewardPools to the rewardPoolList", async () => {
      expect((await claimModule.getRewardPools(subjectSetToken)).length).to.eq(1);

      await subject();

      const rewardPools = await claimModule.getRewardPools(subjectSetToken);
      expect(rewardPools[1]).to.eq(subjectRewardPools[0]);
      expect(rewardPools[2]).to.eq(subjectRewardPools[2]);
    });

    it("should add all new integrations for the rewardPools", async () => {
      await subject();

      const rewardPoolOneClaims = await claimModule.getRewardPoolClaims(setToken.address, subjectRewardPools[0]);
      const rewardPoolTwoClaims = await claimModule.getRewardPoolClaims(setToken.address, subjectRewardPools[2]);
      expect(rewardPoolOneClaims[0]).to.eq(claimAdapterMock.address);
      expect(rewardPoolOneClaims[1]).to.eq(claimAdapterMock2.address);
      expect(rewardPoolTwoClaims[0]).to.eq(claimAdapterMock.address);
    });

    describe("when passed arrays are different length", async () => {
      beforeEach(async () => {
        subjectIntegrations = [claimAdapterMockIntegrationName, claimAdapterMockIntegrationName];
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Array length mismatch");
      });
    });

    describe("when passed arrays are empty", async () => {
      beforeEach(async () => {
        subjectRewardPools = [];
        subjectIntegrations = [];
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Arrays must not be empty");
      });
    });

    describe("when claim already added", async () => {
      beforeEach(async () => {
        subjectIntegrations = [claimAdapterMockIntegrationName, claimAdapterMockIntegrationName, claimAdapterMockIntegrationName];
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Integration names must be unique");
      });
    });

    describe("when caller is not SetToken manager", async () => {
      beforeEach(async () => {
        subjectCaller = await getRandomAccount();
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Must be the SetToken manager");
      });
    });

    describe("when the SetToken is not valid", async () => {
      beforeEach(async () => {
        const nonEnabledSetToken = await setup.createNonControllerEnabledSetToken(
          [setup.weth.address],
          [ether(1)],
          [claimModule.address]
        );

        subjectSetToken = nonEnabledSetToken.address;
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Must be a valid and initialized SetToken");
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
  });

  describe("#addClaim", async () => {
    let setToken: SetToken;
    let isInitialized: boolean;

    let subjectSetToken: Address;
    let subjectRewardPool: Address;
    let subjectIntegration: string;
    let subjectCaller: Account;

    before(async () => {
      isInitialized = true;
    });

    beforeEach(async () => {
      setToken = await setup.createSetToken(
        [setup.weth.address],
        [ether(1)],
        [claimModule.address]
      );

      subjectCaller = owner;

      subjectRewardPool = await getRandomAddress();
      subjectIntegration = claimAdapterMockIntegrationName2;
      subjectSetToken = setToken.address;

      if (isInitialized) {
        await claimModule.initialize(setToken.address, true, [await getRandomAddress()], [claimAdapterMockIntegrationName2]);
      }
    });

    async function subject(): Promise<any> {
      return claimModule.connect(subjectCaller.wallet).addClaim(subjectSetToken, subjectRewardPool, subjectIntegration);
    }

    it("should add the rewardPool to the rewardPoolList", async () => {
      expect(await claimModule.isRewardPool(subjectSetToken, subjectRewardPool)).to.be.false;

      await subject();

      expect(await claimModule.isRewardPool(subjectSetToken, subjectRewardPool)).to.be.true;
    });

    it("should add new integration for the rewardPool", async () => {
      const rewardPoolClaimsBefore = await claimModule.getRewardPoolClaims(setToken.address, subjectRewardPool);
      expect(rewardPoolClaimsBefore.length).to.eq(0);

      await subject();

      const rewardPoolClaims = await claimModule.getRewardPoolClaims(setToken.address, subjectRewardPool);
      expect(rewardPoolClaims.length).to.eq(1);
      expect(rewardPoolClaims[0]).to.eq(claimAdapterMock2.address);
    });

    describe("when new claim is being added to existing rewardPool", async () => {
      beforeEach(async () => {
        await claimModule.addClaim(subjectSetToken, subjectRewardPool, claimAdapterMockIntegrationName);
      });

      it("should add new integration for the rewardPool", async () => {
        const rewardPoolClaimsBefore = await claimModule.getRewardPoolClaims(setToken.address, subjectRewardPool);
        expect(rewardPoolClaimsBefore.length).to.eq(1);

        await subject();

        const rewardPoolClaims = await claimModule.getRewardPoolClaims(setToken.address, subjectRewardPool);
        expect(rewardPoolClaims.length).to.eq(2);
        expect(rewardPoolClaims[1]).to.eq(claimAdapterMock2.address);
      });

      it("should not add the rewardPool again", async () => {
        expect(await claimModule.isRewardPool(subjectSetToken, subjectRewardPool)).to.be.true;

        await subject();

        const rewardPools = await claimModule.getRewardPools(subjectSetToken);
        expect(rewardPools.length).to.eq(2);
        expect(rewardPools[1]).to.eq(subjectRewardPool);
      });
    });

    describe("when claim already added", async () => {
      beforeEach(async () => {
        await claimModule.addClaim(subjectSetToken, subjectRewardPool, subjectIntegration);
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Integration names must be unique");
      });
    });

    describe("when caller is not SetToken manager", async () => {
      beforeEach(async () => {
        subjectCaller = await getRandomAccount();
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Must be the SetToken manager");
      });
    });

    describe("when the SetToken is not valid", async () => {
      beforeEach(async () => {
        const nonEnabledSetToken = await setup.createNonControllerEnabledSetToken(
          [setup.weth.address],
          [ether(1)],
          [claimModule.address]
        );

        subjectSetToken = nonEnabledSetToken.address;
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Must be a valid and initialized SetToken");
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
  });

  describe("#batchRemoveClaim", async () => {
    let setToken: SetToken;
    let subjectCaller: Account;
    let subjectRewardPools: Address[];
    let subjectIntegrations: string[];
    let subjectSetToken: Address;
    let isInitialized: boolean;

    before(async () => {
      isInitialized = true;
    });

    beforeEach(async () => {
      setToken = await setup.createSetToken(
        [setup.weth.address],
        [ether(1)],
        [claimModule.address]
      );

      subjectCaller = owner;

      subjectRewardPools = [await getRandomAddress(), await getRandomAddress()];
      subjectSetToken = setToken.address;
      subjectIntegrations = [claimAdapterMockIntegrationName, claimAdapterMockIntegrationName];

      if (isInitialized) {
        await claimModule.initialize(setToken.address, true, [await getRandomAddress()], [claimAdapterMockIntegrationName2]);
        await claimModule.batchAddClaim(subjectSetToken, subjectRewardPools, subjectIntegrations);
      }
    });

    async function subject(): Promise<any> {
      return claimModule.connect(subjectCaller.wallet).batchRemoveClaim(subjectSetToken, subjectRewardPools, subjectIntegrations);
    }

    it("should remove the adapter associated to the reward pool", async () => {
      const rewardPoolOneClaimsBefore = await claimModule.getRewardPoolClaims(setToken.address, subjectRewardPools[0]);
      const rewardPoolTwoClaimsBefore = await claimModule.getRewardPoolClaims(setToken.address, subjectRewardPools[1]);
      expect(rewardPoolOneClaimsBefore.length).to.eq(1);
      expect(rewardPoolTwoClaimsBefore.length).to.eq(1);

      await subject();

      const rewardPoolOneClaims = await claimModule.getRewardPoolClaims(setToken.address, subjectRewardPools[0]);
      const rewardPoolTwoClaims = await claimModule.getRewardPoolClaims(setToken.address, subjectRewardPools[1]);
      expect(rewardPoolOneClaims.length).to.eq(0);
      expect(rewardPoolTwoClaims.length).to.eq(0);
    });

    it("should remove the rewardPool from the rewardPoolList", async () => {
      expect(await claimModule.isRewardPool(subjectSetToken, subjectRewardPools[0])).to.be.true;
      expect(await claimModule.isRewardPool(subjectSetToken, subjectRewardPools[1])).to.be.true;

      await subject();

      expect(await claimModule.isRewardPool(subjectSetToken, subjectRewardPools[0])).to.be.false;
      expect(await claimModule.isRewardPool(subjectSetToken, subjectRewardPools[1])).to.be.false;
    });

    describe("when the claim integration is not present", async () => {
      beforeEach(async () => {
        subjectRewardPools = [owner.address, owner.address];
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Integration must be added");
      });
    });

    describe("when passed arrays are different length", async () => {
      beforeEach(async () => {
        subjectIntegrations = [claimAdapterMockIntegrationName];
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Array length mismatch");
      });
    });

    describe("when passed arrays are empty", async () => {
      beforeEach(async () => {
        subjectRewardPools = [];
        subjectIntegrations = [];
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Arrays must not be empty");
      });
    });

    describe("when caller is not SetToken manager", async () => {
      beforeEach(async () => {
        subjectCaller = await getRandomAccount();
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Must be the SetToken manager");
      });
    });

    describe("when the SetToken is not valid", async () => {
      beforeEach(async () => {
        const nonEnabledSetToken = await setup.createNonControllerEnabledSetToken(
          [setup.weth.address],
          [ether(1)],
          [claimModule.address]
        );

        subjectSetToken = nonEnabledSetToken.address;
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Must be a valid and initialized SetToken");
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
  });

  describe("#removeClaim", async () => {
    let setToken: SetToken;
    let subjectCaller: Account;
    let subjectRewardPool: Address;
    let subjectIntegration: string;
    let subjectSetToken: Address;
    let isInitialized: boolean;

    before(async () => {
      isInitialized = true;
    });

    beforeEach(async () => {
      setToken = await setup.createSetToken(
        [setup.weth.address],
        [ether(1)],
        [claimModule.address]
      );

      subjectCaller = owner;

      subjectRewardPool = await getRandomAddress();
      subjectSetToken = setToken.address;
      subjectIntegration = claimAdapterMockIntegrationName;

      if (isInitialized) {
        await claimModule.initialize(setToken.address, true, [await getRandomAddress()], [claimAdapterMockIntegrationName2]);
        await claimModule.addClaim(subjectSetToken, subjectRewardPool, subjectIntegration);
      }
    });

    async function subject(): Promise<any> {
      return claimModule.connect(subjectCaller.wallet).removeClaim(subjectSetToken, subjectRewardPool, subjectIntegration);
    }

    it("should remove the adapter associated to the reward pool", async () => {
      const rewardPoolClaimsBefore = await claimModule.getRewardPoolClaims(setToken.address, subjectRewardPool);
      expect(rewardPoolClaimsBefore.length).to.eq(1);

      await subject();

      const rewardPoolClaims = await claimModule.getRewardPoolClaims(setToken.address, subjectRewardPool);
      expect(rewardPoolClaims.length).to.eq(0);
    });

    it("should remove the rewardPool from the rewardPoolList", async () => {
      expect(await claimModule.isRewardPool(subjectSetToken, subjectRewardPool)).to.be.true;

      await subject();

      expect(await claimModule.isRewardPool(subjectSetToken, subjectRewardPool)).to.be.false;
    });

    describe("when the rewardPool still has integrations left after removal", async () => {
      beforeEach(async () => {
        await claimModule.addClaim(subjectSetToken, subjectRewardPool, claimAdapterMockIntegrationName2);
      });

      it("should remove the adapter associated to the reward pool", async () => {
        const rewardPoolClaimsBefore = await claimModule.getRewardPoolClaims(setToken.address, subjectRewardPool);
        expect(rewardPoolClaimsBefore.length).to.eq(2);

        await subject();

        const rewardPoolClaims = await claimModule.getRewardPoolClaims(setToken.address, subjectRewardPool);
        expect(rewardPoolClaims.length).to.eq(1);
        expect(rewardPoolClaims[0]).to.eq(claimAdapterMock2.address);
      });

      it("should not remove the rewardPool from the rewardPoolList", async () => {
        expect(await claimModule.isRewardPool(subjectSetToken, subjectRewardPool)).to.be.true;

        await subject();

        expect(await claimModule.isRewardPool(subjectSetToken, subjectRewardPool)).to.be.true;
      });
    });

    describe("when the claim integration is not present", async () => {
      beforeEach(async () => {
        subjectIntegration = claimAdapterMockIntegrationName2;
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Integration must be added");
      });
    });

    describe("when caller is not SetToken manager", async () => {
      beforeEach(async () => {
        subjectCaller = await getRandomAccount();
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Must be the SetToken manager");
      });
    });

    describe("when the SetToken is not valid", async () => {
      beforeEach(async () => {
        const nonEnabledSetToken = await setup.createNonControllerEnabledSetToken(
          [setup.weth.address],
          [ether(1)],
          [claimModule.address]
        );

        subjectSetToken = nonEnabledSetToken.address;
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Must be a valid and initialized SetToken");
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
  });

  describe("#getRewards", async () => {
    let setToken: SetToken;
    let subjectRewardPool: Address;
    let subjectIntegration: string;
    let subjectSetToken: Address;
    let subjectRewards: BigNumber;

    beforeEach(async () => {
      setToken = await setup.createSetToken(
        [setup.weth.address],
        [ether(1)],
        [claimModule.address]
      );

      subjectRewardPool = await getRandomAddress();
      subjectSetToken = setToken.address;
      subjectIntegration = claimAdapterMockIntegrationName;
      subjectRewards = ether(1);

      await claimModule.initialize(setToken.address, true, [await getRandomAddress()], [claimAdapterMockIntegrationName2]);
      await claimModule.addClaim(subjectSetToken, subjectRewardPool, subjectIntegration);
      await claimAdapterMock.setRewards(subjectRewards);
    });

    async function subject(): Promise<any> {
      return claimModule.getRewards(subjectSetToken, subjectRewardPool, subjectIntegration);
    }

    it("should return the rewards and tokens associated", async () => {
      const rewards = await subject();
      expect(rewards).to.eq(subjectRewards);
    });

    describe("when the rewardPool is not present", async () => {

      beforeEach(async () => {
        subjectRewardPool = await getRandomAddress();
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Adapter integration not present");
      });
    });

    describe("when the claim integration is not present", async () => {

      beforeEach(async () => {
        subjectIntegration = claimAdapterMockIntegrationName2;
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Adapter integration not present");
      });
    });
  });

  describe("#isRewardPoolClaim", async () => {
    let setToken: SetToken;
    let subjectRewardPool: Address;
    let subjectIntegration: string;
    let subjectSetToken: Address;

    beforeEach(async () => {
      setToken = await setup.createSetToken(
        [setup.weth.address],
        [ether(1)],
        [claimModule.address]
      );

      subjectRewardPool = await getRandomAddress();
      subjectSetToken = setToken.address;
      subjectIntegration = claimAdapterMockIntegrationName;

      await claimModule.initialize(setToken.address, true, [await getRandomAddress()], [claimAdapterMockIntegrationName2]);
      await claimModule.addClaim(subjectSetToken, subjectRewardPool, subjectIntegration);
    });

    async function subject(): Promise<any> {
      return claimModule.isRewardPoolClaim(subjectSetToken, subjectRewardPool, subjectIntegration);
    }

    it("should return true", async () => {
      const isReward = await subject();
      expect(isReward).to.be.true;
    });

    describe("when the rewardPool is not present", async () => {
      beforeEach(async () => {
        subjectIntegration = claimAdapterMockIntegrationName2;
      });

      it("should return false", async () => {
        const isReward = await subject();
        expect(isReward).to.be.false;
      });
    });
  });

  describe("#claim", async () => {
    let setToken: SetToken;
    let rewards: BigNumber;
    let anyoneClaim: boolean;
    let isInitialized: boolean;

    let subjectCaller: Account;
    let subjectRewardPool: Address;
    let subjectIntegration: string;
    let subjectSetToken: Address;

    before(async () => {
      rewards = ether(1);
      anyoneClaim = true;
      isInitialized = true;
    });

    beforeEach(async () => {
      setToken = await setup.createSetToken(
        [setup.weth.address],
        [ether(1)],
        [claimModule.address]
      );

      subjectCaller = owner;

      subjectRewardPool = await getRandomAddress();
      subjectSetToken = setToken.address;
      subjectIntegration = claimAdapterMockIntegrationName;

      if (isInitialized) {
        await claimModule.initialize(setToken.address, anyoneClaim, [subjectRewardPool], [subjectIntegration]);
      }

      await claimAdapterMock.setRewards(rewards);
    });

    async function subject(): Promise<any> {
      return claimModule.connect(subjectCaller.wallet).claim(subjectSetToken, subjectRewardPool, subjectIntegration);
    }

    it("should claim the rewards on the rewardPool for the claim integration", async () => {
      const balanceBefore = await claimAdapterMock.balanceOf(subjectSetToken);
      expect(balanceBefore).to.eq(ZERO);

      await subject();

      const balance = await claimAdapterMock.balanceOf(subjectSetToken);
      expect(balance).to.eq(rewards);
    });

    it("emits the correct RewardClaimed event", async () => {
      await expect(subject()).to.emit(claimModule, "RewardClaimed").withArgs(
        subjectSetToken,
        subjectRewardPool,
        claimAdapterMock.address,
        rewards
      );
    });

    describe("when anyoneClaim is true and caller is not manager", async () => {
      beforeEach(async () => {
        subjectCaller = await getRandomAccount();
      });

      it("should claim the rewards on the rewardPool for the claim integration", async () => {
        const balanceBefore = await claimAdapterMock.balanceOf(subjectSetToken);
        expect(balanceBefore).to.eq(ZERO);

        await subject();

        const balance = await claimAdapterMock.balanceOf(subjectSetToken);
        expect(balance).to.eq(rewards);
      });

      it("emits the correct RewardClaimed event", async () => {
        await expect(subject()).to.emit(claimModule, "RewardClaimed").withArgs(
          subjectSetToken,
          subjectRewardPool,
          claimAdapterMock.address,
          rewards
        );
      });
    });

    describe("when anyoneClaim is false and caller is the manager", async () => {
      before(async () => {
        anyoneClaim = false;
      });

      after(async () => {
        anyoneClaim = true;
      });

      it("should claim the rewards on the rewardPool for the claim integration", async () => {
        const balanceBefore = await claimAdapterMock.balanceOf(subjectSetToken);
        expect(balanceBefore).to.eq(ZERO);

        await subject();

        const balance = await claimAdapterMock.balanceOf(subjectSetToken);
        expect(balance).to.eq(rewards);
      });

      it("emits the correct RewardClaimed event", async () => {
        await expect(subject()).to.emit(claimModule, "RewardClaimed").withArgs(
          subjectSetToken,
          subjectRewardPool,
          claimAdapterMock.address,
          rewards
        );
      });
    });

    describe("when the rewardPool is not present", async () => {
      beforeEach(async () => {
        subjectRewardPool = await getRandomAddress();
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("RewardPool not present");
      });
    });

    describe("when the claim integration is not present", async () => {

      beforeEach(async () => {
        subjectIntegration = claimAdapterMockIntegrationName2;
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Adapter integration not present");
      });
    });

    describe("when anyoneClaim is false and caller is not manager", async () => {
      before(async () => {
        anyoneClaim = false;
      });

      beforeEach(async () => {
        subjectCaller = await getRandomAccount();
      });

      after(async () => {
        anyoneClaim = true;
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Must be valid caller");
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
          [claimModule.address]
        );

        subjectSetToken = nonEnabledSetToken.address;
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Must be a valid and initialized SetToken");
      });
    });
  });

  describe("#batchClaim", async () => {
    let setToken: SetToken;
    let rewards: BigNumber;
    let anyoneClaim: boolean;
    let isInitialized: boolean;

    let subjectCaller: Account;
    let subjectRewardPools: Address[];
    let subjectIntegrations: string[];
    let subjectSetToken: Address;

    before(async () => {
      rewards = ether(1);
      anyoneClaim = true;
      isInitialized = true;
    });

    beforeEach(async () => {
      setToken = await setup.createSetToken(
        [setup.weth.address],
        [ether(1)],
        [claimModule.address]
      );

      subjectCaller = owner;

      subjectRewardPools = [await getRandomAddress(), await getRandomAddress()];
      subjectSetToken = setToken.address;
      subjectIntegrations = [claimAdapterMockIntegrationName, claimAdapterMockIntegrationName2];

      if (isInitialized) {
        await claimModule.initialize(setToken.address, anyoneClaim, subjectRewardPools, subjectIntegrations);
      }

      await claimAdapterMock.setRewards(rewards);
      await claimAdapterMock2.setRewards(rewards);
    });

    async function subject(): Promise<any> {
      return claimModule.connect(subjectCaller.wallet).batchClaim(subjectSetToken, subjectRewardPools, subjectIntegrations);
    }

    it("should claim the rewards on the rewardPool for the claim integration", async () => {
      const balanceBefore = await claimAdapterMock.balanceOf(subjectSetToken);
      expect(balanceBefore).to.eq(ZERO);

      await subject();

      const balance = await claimAdapterMock.balanceOf(subjectSetToken);
      expect(balance).to.eq(rewards);
    });

    it("emits the correct RewardClaimed event", async () => {
      await expect(subject()).to.emit(claimModule, "RewardClaimed").withArgs(
        subjectSetToken,
        subjectRewardPools[0],
        claimAdapterMock.address,
        rewards
      );
    });

    it("emits the correct RewardClaimed event", async () => {
      await expect(subject()).to.emit(claimModule, "RewardClaimed").withArgs(
        subjectSetToken,
        subjectRewardPools[1],
        claimAdapterMock2.address,
        rewards
      );
    });

    describe("when anyoneClaim is true and caller is not manager", async () => {
      beforeEach(async () => {
        subjectCaller = await getRandomAccount();
      });

      it("should claim the rewards on the rewardPool for the claim integration", async () => {
        const balanceBefore = await claimAdapterMock.balanceOf(subjectSetToken);
        expect(balanceBefore).to.eq(ZERO);

        await subject();

        const balance = await claimAdapterMock.balanceOf(subjectSetToken);
        expect(balance).to.eq(rewards);
      });

      it("emits the correct RewardClaimed event", async () => {
        await expect(subject()).to.emit(claimModule, "RewardClaimed").withArgs(
          subjectSetToken,
          subjectRewardPools[0],
          claimAdapterMock.address,
          rewards
        );
      });

      it("emits the correct RewardClaimed event", async () => {
        await expect(subject()).to.emit(claimModule, "RewardClaimed").withArgs(
          subjectSetToken,
          subjectRewardPools[1],
          claimAdapterMock2.address,
          rewards
        );
      });
    });

    describe("when anyoneClaim is false and caller is the manager", async () => {
      before(async () => {
        anyoneClaim = false;
      });

      after(async () => {
        anyoneClaim = true;
      });

      it("should claim the rewards on the rewardPool for the claim integration", async () => {
        const balanceBefore = await claimAdapterMock.balanceOf(subjectSetToken);
        expect(balanceBefore).to.eq(ZERO);

        await subject();

        const balance = await claimAdapterMock.balanceOf(subjectSetToken);
        expect(balance).to.eq(rewards);
      });

      it("emits the correct RewardClaimed event", async () => {
        await expect(subject()).to.emit(claimModule, "RewardClaimed").withArgs(
          subjectSetToken,
          subjectRewardPools[0],
          claimAdapterMock.address,
          rewards
        );
      });

      it("emits the correct RewardClaimed event", async () => {
        await expect(subject()).to.emit(claimModule, "RewardClaimed").withArgs(
          subjectSetToken,
          subjectRewardPools[1],
          claimAdapterMock2.address,
          rewards
        );
      });
    });

    describe("when the rewardPool is not present", async () => {
      beforeEach(async () => {
        subjectRewardPools = [await getRandomAddress(), await getRandomAddress()];
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("RewardPool not present");
      });
    });

    describe("when the claim integration is not present", async () => {
      beforeEach(async () => {
        subjectIntegrations = [claimAdapterMockIntegrationName2, claimAdapterMockIntegrationName];
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Adapter integration not present");
      });
    });

    describe("when passed arrays are different length", async () => {
      beforeEach(async () => {
        subjectIntegrations = [claimAdapterMockIntegrationName];
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Array length mismatch");
      });
    });

    describe("when passed arrays are empty", async () => {
      beforeEach(async () => {
        subjectRewardPools = [];
        subjectIntegrations = [];
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Arrays must not be empty");
      });
    });

    describe("when anyoneClaim is false and caller is not manager", async () => {
      before(async () => {
        anyoneClaim = false;
      });

      beforeEach(async () => {
        subjectCaller = await getRandomAccount();
      });

      after(async () => {
        anyoneClaim = true;
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Must be valid caller");
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
          [claimModule.address]
        );

        subjectSetToken = nonEnabledSetToken.address;
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Must be a valid and initialized SetToken");
      });
    });
  });
});
