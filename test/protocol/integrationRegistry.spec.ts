import "module-alias/register";

import { Account, Address } from "@utils/types";
import { ADDRESS_ZERO } from "@utils/constants";
import { Controller, IntegrationRegistry } from "@utils/contracts";
import DeployHelper from "@utils/deploys";
import {
  addSnapshotBeforeRestoreAfterEach,
  getWaffleExpect,
  getAccounts,
  getRandomAccount,
  hashAdapterName
} from "@utils/index";

const expect = getWaffleExpect();


describe("IntegrationRegistry", () => {
  let owner: Account;
  let mockFirstAdapter: Account;
  let mockSecondAdapter: Account;
  let mockFirstModule: Account;
  let mockSecondModule: Account;
  let mockThirdModule: Account;

  let firstAdapterName: string;
  let secondAdapterName: string;
  let thirdAdapterName: string;

  let deployer: DeployHelper;

  let controller: Controller;
  let integrationRegistry: IntegrationRegistry;

  beforeEach(async () => {
    [
      owner,
      mockFirstAdapter,
      mockSecondAdapter,
      mockFirstModule,
      mockSecondModule,
      mockThirdModule,
    ] = await getAccounts();

    firstAdapterName = "COMPOUND";
    secondAdapterName = "KYBER";
    thirdAdapterName = "ONEINCH";

    deployer = new DeployHelper(owner.wallet);

    controller = await deployer.core.deployController(owner.address);
    await controller.initialize([], [mockFirstModule.address, mockSecondModule.address], [], []);

    integrationRegistry = await deployer.core.deployIntegrationRegistry(controller.address);
  });

  addSnapshotBeforeRestoreAfterEach();

  describe("#addIntegration", async () => {
    let subjectModule: Address;
    let subjectAdapterName: string;
    let subjectAdapter: Address;
    let subjectCaller: Account;

    beforeEach(async () => {
      subjectModule = mockFirstModule.address;
      subjectAdapterName = firstAdapterName;
      subjectAdapter = mockFirstAdapter.address;
      subjectCaller = owner;
    });

    async function subject(): Promise<any> {
      integrationRegistry = integrationRegistry.connect(subjectCaller.wallet);
      return await integrationRegistry.addIntegration(
        subjectModule,
        subjectAdapterName,
        subjectAdapter
      );
    }

    it("adds the id to the integrations mapping with correct adapters", async () => {
      const existingAddress = await integrationRegistry.getIntegrationAdapter(mockFirstModule.address, firstAdapterName);
      expect(existingAddress).to.equal(ADDRESS_ZERO);

      await subject();

      const retrievedAddress = await integrationRegistry.getIntegrationAdapter(mockFirstModule.address, firstAdapterName);
      expect(retrievedAddress).to.equal(mockFirstAdapter.address);
    });

    it("should emit the IntegrationAdded event", async () => {
      await expect(subject()).to.emit(integrationRegistry, "IntegrationAdded").withArgs(
        subjectModule,
        subjectAdapter,
        subjectAdapterName
      );
    });

    describe("when someone other than the owner tries to add an address", async () => {
      beforeEach(async () => {
        subjectCaller = await getRandomAccount();
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Ownable: caller is not the owner");
      });
    });

    describe("when the module is not initialized on Controller", async () => {
      beforeEach(async () => {
        subjectModule = mockThirdModule.address;
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Must be valid module.");
      });
    });

    describe("when the adapter is already added", async () => {
      beforeEach(async () => {
        await subject();
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Integration exists already.");
      });
    });

    describe("when an adapter is zero address", async () => {
      beforeEach(async () => {
        subjectAdapter = ADDRESS_ZERO;
      });

      it("reverts", async () => {
        await expect(subject()).to.be.revertedWith("Adapter address must exist.");
      });
    });
  });

  describe("#batchAddIntegration", async () => {
    let subjectModules: Address[];
    let subjectAdapterNames: string[];
    let subjectAdapters: Address[];
    let subjectCaller: Account;

    beforeEach(async () => {
      subjectModules = [mockFirstModule.address, mockFirstModule.address];
      subjectAdapterNames = [firstAdapterName, secondAdapterName];
      subjectAdapters = [mockFirstAdapter.address, mockSecondAdapter.address];
      subjectCaller = owner;
    });

    async function subject(): Promise<any> {
      integrationRegistry = integrationRegistry.connect(subjectCaller.wallet);
      return await integrationRegistry.batchAddIntegration(
        subjectModules,
        subjectAdapterNames,
        subjectAdapters
      );
    }

    it("adds the ids to the integrations mapping with correct adapters", async () => {
      const existingFirstAddress = await integrationRegistry.getIntegrationAdapter(mockFirstModule.address, firstAdapterName);
      const existingSecondAddress = await integrationRegistry.getIntegrationAdapter(mockFirstModule.address, secondAdapterName);

      expect(existingFirstAddress).to.equal(ADDRESS_ZERO);
      expect(existingSecondAddress).to.equal(ADDRESS_ZERO);

      await subject();

      const retrievedFirstAddress = await integrationRegistry.getIntegrationAdapter(mockFirstModule.address, firstAdapterName);
      const retrievedSecondAddress = await integrationRegistry.getIntegrationAdapter(mockFirstModule.address, secondAdapterName);

      expect(retrievedFirstAddress).to.equal(mockFirstAdapter.address);
      expect(retrievedSecondAddress).to.equal(mockSecondAdapter.address);
    });

    it("should emit the first IntegrationAdded event", async () => {
      await expect(subject()).to.emit(integrationRegistry, "IntegrationAdded").withArgs(
        subjectModules[0],
        subjectAdapters[0],
        subjectAdapterNames[0]
      );
    });

    it("should emit the second IntegrationAdded event", async () => {
      await expect(subject()).to.emit(integrationRegistry, "IntegrationAdded").withArgs(
        subjectModules[1],
        subjectAdapters[1],
        subjectAdapterNames[1]
      );
    });

    describe("when someone other than the owner tries to add an address", async () => {
      beforeEach(async () => {
        subjectCaller = await getRandomAccount();
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Ownable: caller is not the owner");
      });
    });

    describe("when a module is not initialized on Controller", async () => {
      beforeEach(async () => {
        subjectModules = [mockFirstModule.address, mockThirdModule.address];
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Must be valid module.");
      });
    });

    describe("when the adapters are already added", async () => {
      beforeEach(async () => {
        integrationRegistry = integrationRegistry.connect(owner.wallet);
        await integrationRegistry.addIntegration(
          mockFirstModule.address,
          firstAdapterName,
          mockFirstAdapter.address,
        );
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Integration exists already.");
      });
    });

    describe("when an adapter is zero address", async () => {
      beforeEach(async () => {
        subjectAdapters = [mockFirstAdapter.address, ADDRESS_ZERO];
      });

      it("reverts", async () => {
        await expect(subject()).to.be.revertedWith("Adapter address must exist.");
      });
    });

    describe("when modules length is zero", async () => {
      beforeEach(async () => {
        subjectModules = [];
      });

      it("reverts", async () => {
        await expect(subject()).to.be.revertedWith("Modules must not be empty");
      });
    });

    describe("when Module and adapter length is a mismatch", async () => {
      beforeEach(async () => {
        subjectModules = [mockFirstModule.address];
        subjectAdapterNames = [firstAdapterName, secondAdapterName];
      });

      it("reverts", async () => {
        await expect(subject()).to.be.revertedWith("Module and name lengths mismatch");
      });
    });

    describe("when module and adapter length is a mismatch", async () => {
      beforeEach(async () => {
        subjectAdapters = [mockFirstAdapter.address];
      });

      it("reverts", async () => {
        await expect(subject()).to.be.revertedWith("Module and adapter lengths mismatch");
      });
    });
  });

  describe("#removeIntegration", async () => {
    let subjectModule: Address;
    let subjectAdapterName: string;
    let subjectCaller: Account;

    beforeEach(async () => {
      await integrationRegistry.addIntegration(
        mockFirstModule.address,
        secondAdapterName,
        mockSecondAdapter.address
      );

      subjectModule = mockFirstModule.address;
      subjectAdapterName = secondAdapterName;
      subjectCaller = owner;
    });

    async function subject(): Promise<any> {
      integrationRegistry = integrationRegistry.connect(subjectCaller.wallet);
      return await integrationRegistry.removeIntegration(subjectModule, subjectAdapterName);
    }

    it("updates the address in the integrations mapping to null address", async () => {
      const existingAddress = await integrationRegistry.getIntegrationAdapter(mockFirstModule.address, secondAdapterName);
      expect(existingAddress).to.equal(mockSecondAdapter.address);

      await subject();

      const retrievedAddress = await integrationRegistry.getIntegrationAdapter(mockFirstModule.address, secondAdapterName);
      expect(retrievedAddress).to.equal(ADDRESS_ZERO);
    });

    it("should emit an IntegrationRemoved event", async () => {
      const oldAdapter = await integrationRegistry.getIntegrationAdapter(subjectModule, subjectAdapterName);
      await expect(subject()).to.emit(integrationRegistry, "IntegrationRemoved").withArgs(
        subjectModule,
        oldAdapter,
        subjectAdapterName
      );
    });

    describe("when someone other than the owner tries to remove an address", async () => {
      beforeEach(async () => {
        subjectCaller = await getRandomAccount();
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Ownable: caller is not the owner");
      });
    });

    describe("when the address is not currently added", async () => {
      beforeEach(async () => {
        subjectAdapterName = firstAdapterName;
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Integration does not exist.");
      });
    });
  });

  describe("#editIntegration", async () => {
    let subjectModule: Address;
    let subjectAdapterName: string;
    let subjectAdapter: Address;
    let subjectCaller: Account;

    beforeEach(async () => {
      await integrationRegistry.addIntegration(
        mockFirstModule.address,
        secondAdapterName,
        mockSecondAdapter.address
      );

      subjectAdapterName = secondAdapterName;
      subjectAdapter = mockFirstAdapter.address;
      subjectModule = mockFirstModule.address;
      subjectCaller = owner;
    });

    async function subject(): Promise<any> {
      integrationRegistry = integrationRegistry.connect(subjectCaller.wallet);
      return await integrationRegistry.editIntegration(
        subjectModule,
        subjectAdapterName,
        subjectAdapter
      );
    }

    it("edits the id to the integrations mapping to correct adapters", async () => {
      const existingAddress = await integrationRegistry.getIntegrationAdapter(mockFirstModule.address, secondAdapterName);
      expect(existingAddress).to.equal(mockSecondAdapter.address);

      await subject();

      const retrievedAddress = await integrationRegistry.getIntegrationAdapter(mockFirstModule.address, secondAdapterName);
      expect(retrievedAddress).to.equal(mockFirstAdapter.address);
    });

    it("should emit an IntegrationEdited event", async () => {
      await expect(subject()).to.emit(integrationRegistry, "IntegrationEdited").withArgs(
        subjectModule,
        subjectAdapter,
        subjectAdapterName
      );
    });

    describe("when someone other than the owner tries to add an address", async () => {
      beforeEach(async () => {
        subjectCaller = await getRandomAccount();
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Ownable: caller is not the owner");
      });
    });

    describe("when the module is not initialized on Controller", async () => {
      beforeEach(async () => {
        subjectModule = mockThirdModule.address;
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Must be valid module.");
      });
    });

    describe("when the address is not already added", async () => {
      beforeEach(async () => {
        subjectAdapterName = thirdAdapterName;
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Integration does not exist.");
      });
    });

    describe("when a value is zero", async () => {
      beforeEach(async () => {
        subjectAdapter = ADDRESS_ZERO;
      });

      it("reverts", async () => {
        await expect(subject()).to.be.revertedWith("Adapter address must exist.");
      });
    });
  });

  describe("#batchEditIntegration", async () => {
    let subjectModules: Address[];
    let subjectAdapterNames: string[];
    let subjectAdapters: Address[];
    let subjectCaller: Account;

    beforeEach(async () => {
      await integrationRegistry.batchAddIntegration(
        [mockFirstModule.address, mockSecondModule.address],
        [firstAdapterName, secondAdapterName],
        [mockFirstAdapter.address, mockSecondAdapter.address],
      );

      subjectModules = [mockFirstModule.address, mockSecondModule.address];
      subjectAdapterNames = [firstAdapterName, secondAdapterName];
      subjectAdapters = [mockSecondAdapter.address, mockFirstAdapter.address];
      subjectCaller = owner;
    });

    async function subject(): Promise<any> {
      integrationRegistry = integrationRegistry.connect(subjectCaller.wallet);
      return await integrationRegistry.batchEditIntegration(
        subjectModules,
        subjectAdapterNames,
        subjectAdapters
      );
    }

    it("edits the ids to the integrations mapping with correct adapters", async () => {
      const existingFirstAddress = await integrationRegistry.getIntegrationAdapter(mockFirstModule.address, firstAdapterName);
      const existingSecondAddress = await integrationRegistry.getIntegrationAdapter(mockSecondModule.address, secondAdapterName);

      expect(existingFirstAddress).to.equal(mockFirstAdapter.address);
      expect(existingSecondAddress).to.equal(mockSecondAdapter.address);

      await subject();

      const retrievedFirstAddress = await integrationRegistry.getIntegrationAdapter(mockFirstModule.address, firstAdapterName);
      const retrievedSecondAddress = await integrationRegistry.getIntegrationAdapter(mockSecondModule.address, secondAdapterName);

      expect(retrievedFirstAddress).to.equal(mockSecondAdapter.address);
      expect(retrievedSecondAddress).to.equal(mockFirstAdapter.address);
    });

    it("should emit the first IntegrationEdited event", async () => {
      await expect(subject()).to.emit(integrationRegistry, "IntegrationEdited").withArgs(
        subjectModules[0],
        subjectAdapters[0],
        subjectAdapterNames[0]
      );
    });

    it("should emit the second IntegrationEdited event", async () => {
      await expect(subject()).to.emit(integrationRegistry, "IntegrationEdited").withArgs(
        subjectModules[1],
        subjectAdapters[1],
        subjectAdapterNames[1]
      );
    });

    describe("when someone other than the owner tries to add an address", async () => {
      beforeEach(async () => {
        subjectCaller = await getRandomAccount();
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Ownable: caller is not the owner");
      });
    });

    describe("when a module is not initialized on Controller", async () => {
      beforeEach(async () => {
        subjectModules = [mockFirstModule.address, mockThirdModule.address];
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Must be valid module.");
      });
    });

    describe("when the adapter is not added", async () => {
      beforeEach(async () => {
        subjectAdapterNames = [thirdAdapterName, thirdAdapterName];
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Integration does not exist.");
      });
    });

    describe("when an adapter is zero address", async () => {
      beforeEach(async () => {
        subjectAdapters = [mockFirstAdapter.address, ADDRESS_ZERO];
      });

      it("reverts", async () => {
        await expect(subject()).to.be.revertedWith("Adapter address must exist.");
      });
    });

    describe("when modules length is zero", async () => {
      beforeEach(async () => {
        subjectModules = [];
      });

      it("reverts", async () => {
        await expect(subject()).to.be.revertedWith("Modules must not be empty");
      });
    });

    describe("when Module and adapter length is a mismatch", async () => {
      beforeEach(async () => {
        subjectModules = [mockFirstModule.address];
        subjectAdapterNames = [firstAdapterName, secondAdapterName];
      });

      it("reverts", async () => {
        await expect(subject()).to.be.revertedWith("Module and name lengths mismatch");
      });
    });

    describe("when module and adapter length is a mismatch", async () => {
      beforeEach(async () => {
        subjectAdapters = [mockFirstAdapter.address];
      });

      it("reverts", async () => {
        await expect(subject()).to.be.revertedWith("Module and adapter lengths mismatch");
      });
    });
  });

  describe("#isValidIntegration", async () => {
    let subjectModule: Address;
    let subjectAdapterName: string;
    let subjectCaller: Account;

    beforeEach(async () => {
      await integrationRegistry.addIntegration(
        mockFirstModule.address,
        firstAdapterName,
        mockFirstAdapter.address
      );

      subjectModule = mockFirstModule.address;
      subjectAdapterName = firstAdapterName;
      subjectCaller = owner;
    });

    async function subject(): Promise<Boolean> {
      integrationRegistry = integrationRegistry.connect(subjectCaller.wallet);
      return await integrationRegistry.isValidIntegration(subjectModule, subjectAdapterName);
    }

    it("returns true", async () => {
      const validity = await subject();

      expect(validity).to.equal(true);
    });

    describe("when the ID is not valid", async () => {
      beforeEach(async () => {
        subjectAdapterName = "UNISWAP";
      });

      it("returns false", async () => {
        const validity = await subject();

        expect(validity).to.equal(false);
      });
    });
  });

  describe("#getIntegrationAdapter", async () => {
    let subjectModule: Address;
    let subjectAdapterName: string;
    let subjectCaller: Account;

    beforeEach(async () => {
      await integrationRegistry.addIntegration(
        mockFirstModule.address,
        firstAdapterName,
        mockFirstAdapter.address
      );

      subjectModule = mockFirstModule.address;
      subjectAdapterName = firstAdapterName;
      subjectCaller = owner;
    });

    async function subject(): Promise<Address> {
      integrationRegistry = integrationRegistry.connect(subjectCaller.wallet);
      return await integrationRegistry.getIntegrationAdapter(subjectModule, subjectAdapterName);
    }

    it("returns the correct adapter address", async () => {
      const actualAdapter = await subject();
      const expectedAdapter = mockFirstAdapter.address;
      expect(actualAdapter).to.equal(expectedAdapter);
    });
  });

  describe("#getIntegrationAdapterWithHash", async () => {
    let subjectModule: Address;
    let subjectAdapterHash: string;
    let subjectCaller: Account;

    beforeEach(async () => {
      await integrationRegistry.addIntegration(
        mockFirstModule.address,
        firstAdapterName,
        mockFirstAdapter.address
      );

      subjectModule = mockFirstModule.address;
      subjectAdapterHash = hashAdapterName(firstAdapterName);
      subjectCaller = owner;
    });

    async function subject(): Promise<Address> {
      integrationRegistry = integrationRegistry.connect(subjectCaller.wallet);
      return await integrationRegistry.getIntegrationAdapterWithHash(subjectModule, subjectAdapterHash);
    }

    it("returns the correct adapter address", async () => {
      const actualAdapter = await subject();
      const expectedAdapter = mockFirstAdapter.address;
      expect(actualAdapter).to.equal(expectedAdapter);
    });
  });
});