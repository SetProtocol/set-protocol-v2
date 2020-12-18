import "module-alias/register";

import { BigNumber } from "ethers/utils";

import { Account, Address } from "@utils/types";
import { ADDRESS_ZERO, ZERO } from "@utils/constants";
import { Controller } from "@utils/contracts";
import DeployHelper from "@utils/deploys";
import {
  addSnapshotBeforeRestoreAfterEach,
  getRandomAccount,
  getWaffleExpect,
  getAccounts,
} from "@utils/index";
import { One } from "ethers/constants";

const expect = getWaffleExpect();

describe("Controller", () => {
  let owner: Account;
  let feeRecipient: Account;
  let mockBasicIssuanceModule: Account;
  let mockSetTokenFactory: Account;
  let mockPriceOracle: Account;
  let mockSetToken: Account;
  let mockUser: Account;
  let controller: Controller;
  let deployer: DeployHelper;

  let shouldInitialize: boolean = true;
  let subjectCaller: Account;

  beforeEach(async () => {
    [
      owner,
      feeRecipient,
      mockBasicIssuanceModule,
      mockSetTokenFactory,
      mockPriceOracle,
      mockSetToken,
      mockUser,
    ] = await getAccounts();

    deployer = new DeployHelper(owner.wallet);

    controller = await deployer.core.deployController(feeRecipient.address);
  });

  addSnapshotBeforeRestoreAfterEach();

  describe("constructor", async () => {
    beforeEach(async () => {
      controller = await deployer.core.deployController(feeRecipient.address);
    });

    it("should have the correct feeRecipient address", async () => {
      const actualFeeRecipient = await controller.feeRecipient();
      expect(actualFeeRecipient).to.eq(feeRecipient.address);
    });

    it("should be returned as a valid system contract", async () => {
      const isSystemContract = await controller.isSystemContract(controller.address);
      expect(isSystemContract).to.eq(true);
    });
  });

  describe("initialize", async () => {
    let subjectResourceId: BigNumber[];
    let subjectFactory: Address[];
    let subjectModule: Address[];
    let subjectResource: Address[];

    let resourceId: BigNumber;

    beforeEach(async () => {
      resourceId = new BigNumber(1);

      subjectFactory = [mockSetTokenFactory.address];
      subjectModule = [mockBasicIssuanceModule.address];
      subjectResource = [mockPriceOracle.address];
      subjectResourceId = [resourceId];
      subjectCaller = owner;
    });

    async function subject(): Promise<any> {
      controller = controller.connect(subjectCaller.wallet);
      return controller.initialize(
        subjectFactory,
        subjectModule,
        subjectResource,
        subjectResourceId,
      );
    }

    it("should have set the correct modules length of 1", async () => {
      await subject();

      const modules = await controller.getModules();
      expect(modules.length).to.eq(1);
    });

    it("should have set the correct factories length of 1", async () => {
      await subject();

      const factories = await controller.getFactories();
      expect(factories.length).to.eq(1);
    });

    it("should have set the correct resources length of 1", async () => {
      await subject();

      const resources = await controller.getResources();
      expect(resources.length).to.eq(1);
    });

    it("should have a valid module", async () => {
      await subject();

      const validModule = await controller.isModule(mockBasicIssuanceModule.address);
      expect(validModule).to.eq(true);
    });

    it("should have a valid factory", async () => {
      await subject();

      const validFactory = await controller.isFactory(mockSetTokenFactory.address);
      expect(validFactory).to.eq(true);
    });

    it("should have a valid resource", async () => {
      await subject();

      const validResource = await controller.isResource(mockPriceOracle.address);
      expect(validResource).to.eq(true);
    });

    it("should update the resourceId mapping", async () => {
      await subject();

      const resourceIdMapping = await controller.resourceId(resourceId);
      expect(resourceIdMapping).to.eq(mockPriceOracle.address);
    });

    describe("when zero address passed for factory", async () => {
      beforeEach(async () => {
        subjectFactory = [ADDRESS_ZERO];
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Zero address submitted.");
      });
    });

    describe("when zero address passed for module", async () => {
      beforeEach(async () => {
        subjectModule = [ADDRESS_ZERO];
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Zero address submitted.");
      });
    });

    describe("when zero address passed for resource", async () => {
      beforeEach(async () => {
        subjectResource = [ADDRESS_ZERO];
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Zero address submitted.");
      });
    });

    describe("when resource and resourceId lengths don't match", async () => {
      beforeEach(async () => {
        subjectResource = [mockPriceOracle.address];
        subjectResourceId = [ZERO, One];
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Array lengths do not match.");
      });
    });

    describe("when the Controller is already initialized", async () => {
      beforeEach(async () => {
        await subject();
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Controller is already initialized");
      });
    });

    describe("when the resourceId already exists", async () => {
      beforeEach(async () => {
        subjectResource = [mockPriceOracle.address, owner.address];
        subjectResourceId = [resourceId, resourceId];
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Resource ID already exists");
      });
    });

    shouldRevertIfNotAuthorized(subject);
  });

  describe("addSet", async () => {
    let subjectSet: Address;

    beforeEach(async () => {
      if (shouldInitialize) {
        await controller.initialize([], [], [], []);
        await controller.addFactory(mockSetTokenFactory.address);
      }

      subjectSet = mockSetToken.address;
      subjectCaller = mockSetTokenFactory;
    });

    async function subject(): Promise<any> {
      controller = controller.connect(subjectCaller.wallet);
      return controller.addSet(subjectSet);
    }

    it("should be stored in the set array", async () => {
      await subject();

      const sets = await controller.getSets();
      expect(sets.length).to.eq(1);
    });

    it("should be returned as a valid Set", async () => {
      await subject();

      const validSet = await controller.isSet(mockSetToken.address);
      expect(validSet).to.eq(true);
    });

    it("should be returned as a valid system contract", async () => {
      await subject();

      const isSystemContract = await controller.isSystemContract(mockSetToken.address);
      expect(isSystemContract).to.eq(true);
    });

    it("should emit the SetAdded event", async () => {
      await expect(subject()).to.emit(controller, "SetAdded").withArgs(subjectSet, subjectCaller.address);
    });

    describe("when the Set already exists", async () => {
      beforeEach(async () => {
        await subject();
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Set already exists");
      });
    });

    describe("when the caller is not a factory", async () => {
      beforeEach(async () => {
        subjectCaller = await getRandomAccount();
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Only valid factories can call");
      });
    });

    shouldRevertIfNotInitialized(subject);
  });

  describe("removeSet", async () => {
    let subjectSetToken: Address;

    beforeEach(async () => {
      if (shouldInitialize) {
        await controller.initialize([], [], [], []);
        await controller.addFactory(mockSetTokenFactory.address);
        // Add Set from factory
        await controller.connect(mockSetTokenFactory.wallet).addSet(mockSetToken.address);
      }

      subjectSetToken = mockSetToken.address;
      subjectCaller = owner;
    });

    async function subject(): Promise<any> {
      return controller.connect(subjectCaller.wallet).removeSet(subjectSetToken);
    }

    it("should remove factory from sets array", async () => {
      await subject();

      const sets = await controller.getSets();
      expect(sets.length).to.eq(0);
    });

    it("should return false as a valid Set", async () => {
      await subject();

      const isSet = await controller.isSet(mockSetToken.address);
      expect(isSet).to.eq(false);
    });

    it("should return false as a valid system contract", async () => {
      await subject();

      const isSystemContract = await controller.isSystemContract(mockSetToken.address);
      expect(isSystemContract).to.eq(false);
    });

    it("should emit the SetRemoved event", async () => {
      await expect(subject()).to.emit(controller, "SetRemoved").withArgs(subjectSetToken);
    });

    describe("when the Set does not exist", async () => {
      beforeEach(async () => {
        await subject();
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Set does not exist");
      });
    });

    shouldRevertIfNotAuthorized(subject);
    shouldRevertIfNotInitialized(subject);
  });

  describe("addFactory", async () => {
    let subjectFactory: Address;

    beforeEach(async () => {
      if (shouldInitialize) {
        await controller.initialize([], [], [], []);
      }

      subjectFactory = mockSetTokenFactory.address;
      subjectCaller = owner;
    });

    async function subject(): Promise<any> {
      controller = controller.connect(subjectCaller.wallet);
      return controller.addFactory(subjectFactory);
    }

    it("should be stored in the factories array", async () => {
      await subject();

      const factories = await controller.getFactories();
      expect(factories.length).to.eq(1);
    });

    it("should be returned as a valid factory", async () => {
      await subject();

      const isFactory = await controller.isFactory(mockSetTokenFactory.address);
      expect(isFactory).to.eq(true);
    });

    it("should be returned as a valid system contract", async () => {
      await subject();

      const isSystemContract = await controller.isSystemContract(mockSetTokenFactory.address);
      expect(isSystemContract).to.eq(true);
    });

    it("should emit the FactoryAdded event", async () => {
      await expect(subject()).to.emit(controller, "FactoryAdded").withArgs(subjectFactory);
    });

    describe("when the factory already exists", async () => {
      beforeEach(async () => {
        await subject();
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Factory already exists");
      });
    });

    shouldRevertIfNotAuthorized(subject);
    shouldRevertIfNotInitialized(subject);
  });

  describe("removeFactory", async () => {
    let subjectFactory: Address;

    beforeEach(async () => {
      if (shouldInitialize) {
        await controller.initialize([], [], [], []);
        await controller.addFactory(mockSetTokenFactory.address);
      }

      subjectFactory = mockSetTokenFactory.address;
      subjectCaller = owner;
    });

    async function subject(): Promise<any> {
      controller = controller.connect(subjectCaller.wallet);
      return controller.removeFactory(subjectFactory);
    }

    it("should remove factory from factories array", async () => {
      await subject();

      const factories = await controller.getFactories();
      expect(factories.length).to.eq(0);
    });

    it("should return false as a valid factory", async () => {
      await subject();

      const isFactory = await controller.isFactory(mockSetTokenFactory.address);
      expect(isFactory).to.eq(false);
    });

    it("should return false as a valid system contract", async () => {
      await subject();

      const isSystemContract = await controller.isSystemContract(mockSetTokenFactory.address);
      expect(isSystemContract).to.eq(false);
    });

    it("should emit the FactoryRemoved event", async () => {
      await expect(subject()).to.emit(controller, "FactoryRemoved").withArgs(subjectFactory);
    });

    describe("when the factory does not exist", async () => {
      beforeEach(async () => {
        await subject();
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Factory does not exist");
      });
    });

    shouldRevertIfNotAuthorized(subject);
    shouldRevertIfNotInitialized(subject);
  });

  describe("addModule", async () => {
    let subjectModule: Address;

    beforeEach(async () => {
      if (shouldInitialize) {
        await controller.initialize([], [], [], []);
      }

      subjectModule = mockBasicIssuanceModule.address;
      subjectCaller = owner;
    });

    async function subject(): Promise<any> {
      controller = controller.connect(subjectCaller.wallet);
      return controller.addModule(subjectModule);
    }

    it("should be stored in the modules array", async () => {
      await subject();

      const modules = await controller.getModules();
      expect(modules.length).to.eq(1);
    });

    it("should be returned as a valid module", async () => {
      await subject();

      const isModule = await controller.isModule(mockBasicIssuanceModule.address);
      expect(isModule).to.eq(true);
    });

    it("should be returned as a valid system contract", async () => {
      await subject();

      const isSystemContract = await controller.isSystemContract(mockBasicIssuanceModule.address);
      expect(isSystemContract).to.eq(true);
    });

    it("should emit the ModuleAdded event", async () => {
      await expect(subject()).to.emit(controller, "ModuleAdded").withArgs(subjectModule);
    });

    describe("when the module already exists", async () => {
      beforeEach(async () => {
        await subject();
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Module already exists");
      });
    });

    shouldRevertIfNotAuthorized(subject);
    shouldRevertIfNotInitialized(subject);
  });

  describe("removeModule", async () => {
    let subjectModule: Address;

    beforeEach(async () => {
      if (shouldInitialize) {
        await controller.initialize([], [], [], []);
        await controller.addModule(mockBasicIssuanceModule.address);
      }

      subjectModule = mockBasicIssuanceModule.address;
      subjectCaller = owner;
    });

    async function subject(): Promise<any> {
      controller = controller.connect(subjectCaller.wallet);
      return controller.removeModule(subjectModule);
    }

    it("should remove module from modules array", async () => {
      await subject();

      const modules = await controller.getModules();
      expect(modules.length).to.eq(0);
    });

    it("should return false as a valid module", async () => {
      await subject();

      const isModule = await controller.isModule(mockBasicIssuanceModule.address);
      expect(isModule).to.eq(false);
    });

    it("should return false as a valid system contract", async () => {
      await subject();

      const isSystemContract = await controller.isSystemContract(mockBasicIssuanceModule.address);
      expect(isSystemContract).to.eq(false);
    });

    it("should emit the ModuleRemoved event", async () => {
      await expect(subject()).to.emit(controller, "ModuleRemoved").withArgs(subjectModule);
    });

    describe("when the module does not exist", async () => {
      beforeEach(async () => {
        await subject();
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Module does not exist");
      });
    });

    shouldRevertIfNotAuthorized(subject);
    shouldRevertIfNotInitialized(subject);
  });

  describe("addResource", async () => {
    let resourceId: BigNumber;
    let priceOracleAddress: Address;

    let subjectResource: Address;
    let subjectResourceId: BigNumber;

    beforeEach(async () => {
      if (shouldInitialize) {
        await controller.initialize([], [], [], []);
      }

      priceOracleAddress = mockPriceOracle.address;
      resourceId = new BigNumber(0);

      subjectResource = priceOracleAddress;
      subjectResourceId = resourceId;
      subjectCaller = owner;
    });

    async function subject(): Promise<any> {
      controller = controller.connect(subjectCaller.wallet);
      return controller.addResource(subjectResource, subjectResourceId);
    }

    it("should be stored in the resources array", async () => {
      await subject();

      const resources = await controller.getResources();
      expect(resources.length).to.eq(1);
    });

    it("should be returned as a valid resource", async () => {
      await subject();

      const isResource = await controller.isResource(mockPriceOracle.address);
      expect(isResource).to.eq(true);
    });

    it("should update the resourceId mapping", async () => {
      await subject();

      const resource = await controller.resourceId(resourceId);
      expect(resource).to.eq(priceOracleAddress);
    });

    it("should be returned as a valid system contract", async () => {
      await subject();

      const isSystemContract = await controller.isSystemContract(mockPriceOracle.address);
      expect(isSystemContract).to.eq(true);
    });

    it("should emit the ResourceAdded event", async () => {
      await expect(subject()).to.emit(controller, "ResourceAdded").withArgs(subjectResource, subjectResourceId);
    });

    describe("when the resource already exists", async () => {
      beforeEach(async () => {
        await subject();
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Resource already exists");
      });
    });

    describe("when the resourceId already exists", async () => {
      beforeEach(async () => {
        await subject();

        subjectResource = mockUser.address;
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Resource ID already exists");
      });
    });

    shouldRevertIfNotAuthorized(subject);
    shouldRevertIfNotInitialized(subject);
  });

  describe("removeResource", async () => {
    let resource: Address;
    let resourceId: BigNumber;

    let subjectResourceId: BigNumber;

    beforeEach(async () => {
      if (shouldInitialize) {
        await controller.initialize([], [], [], []);

        resource = mockPriceOracle.address;
        resourceId = new BigNumber(0);

        await controller.addResource(resource, resourceId);
      }

      subjectResourceId = resourceId;
      subjectCaller = owner;
    });

    async function subject(): Promise<any> {
      controller = controller.connect(subjectCaller.wallet);
      return controller.removeResource(subjectResourceId);
    }

    it("should remove resource from resources array", async () => {
      await subject();

      const resources = await controller.getResources();
      expect(resources.length).to.eq(0);
    });

    it("should return false as a valid resource", async () => {
      await subject();

      const isResource = await controller.isResource(mockPriceOracle.address);
      expect(isResource).to.eq(false);
    });

    it("should update the resourceId mapping", async () => {
      await subject();

      const resource = await controller.resourceId(resourceId);
      expect(resource).to.eq(ADDRESS_ZERO);
    });

    it("should return false as a valid system contract", async () => {
      await subject();

      const isSystemContract = await controller.isSystemContract(mockPriceOracle.address);
      expect(isSystemContract).to.eq(false);
    });

    it("should emit the ResourceRemoved event", async () => {
      await expect(subject()).to.emit(controller, "ResourceRemoved").withArgs(resource, subjectResourceId);
    });

    describe("when the resource does not exist", async () => {
      beforeEach(async () => {
        await subject();
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Resource does not exist");
      });
    });

    shouldRevertIfNotAuthorized(subject);
    shouldRevertIfNotInitialized(subject);
  });

  describe("addFee", async () => {
    let subjectModule: Address;
    let subjectFeeType: BigNumber;
    let subjectFeePercentage: BigNumber;

    beforeEach(async () => {
      if (shouldInitialize) {
        await controller.initialize([], [], [], []);
        await controller.addModule(mockBasicIssuanceModule.address);
      }

      subjectModule = mockBasicIssuanceModule.address;
      subjectFeeType = new BigNumber(1);
      subjectFeePercentage = new BigNumber(5);
      subjectCaller = owner;
    });

    async function subject(): Promise<any> {
      controller = controller.connect(subjectCaller.wallet);
      return controller.addFee(subjectModule, subjectFeeType, subjectFeePercentage);
    }

    it("should be added to the fees mapping", async () => {
      await subject();

      const feePercentage = await controller.getModuleFee(
        mockBasicIssuanceModule.address,
        new BigNumber(1),
      );
      expect(feePercentage).to.eq(5);
    });

    it("should emit the FeeEdited event", async () => {
      await expect(subject()).to.emit(controller, "FeeEdited").withArgs(
        subjectModule,
        subjectFeeType,
        subjectFeePercentage
      );
    });

    describe("when the module does not exist", async () => {
      beforeEach(async () => {
        subjectModule = mockUser.address;
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Module does not exist");
      });
    });

    describe("when the feeType already exists on the module", async () => {
      beforeEach(async () => {
        await subject();
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Fee type already exists on module");
      });
    });

    shouldRevertIfNotAuthorized(subject);
    shouldRevertIfNotInitialized(subject);
  });

  describe("editFee", async () => {
    let moduleAddress: Address;
    let feeType: BigNumber;

    let subjectModule: Address;
    let subjectFeeType: BigNumber;
    let subjectFeePercentage: BigNumber;

    beforeEach(async () => {
      if (shouldInitialize) {
        await controller.initialize([], [], [], []);

        moduleAddress = mockBasicIssuanceModule.address;
        feeType = new BigNumber(1);

        await controller.addModule(mockBasicIssuanceModule.address);
        await controller.addFee(moduleAddress, feeType, new BigNumber(10));
      }

      subjectModule = moduleAddress;
      subjectFeeType = feeType;
      subjectFeePercentage = ZERO;
      subjectCaller = owner;
    });

    async function subject(): Promise<any> {
      controller = controller.connect(subjectCaller.wallet);
      return controller.editFee(subjectModule, subjectFeeType, subjectFeePercentage);
    }

    it("should edit the fees mapping", async () => {
      await subject();

      const feePercentage = await controller.getModuleFee(moduleAddress, feeType);
      expect(feePercentage).to.eq(ZERO);
    });

    it("should emit the FeeEdited event", async () => {
      await expect(subject()).to.emit(controller, "FeeEdited").withArgs(
        subjectModule,
        subjectFeeType,
        subjectFeePercentage
      );
    });

    describe("when the module does not exist", async () => {
      beforeEach(async () => {
        subjectModule = mockUser.address;
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Module does not exist");
      });
    });

    describe("when the feeType does not exist on the module", async () => {
      beforeEach(async () => {
        await subject();
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Fee type does not exist on module");
      });
    });

    shouldRevertIfNotAuthorized(subject);
  });

  describe("editFeeRecipient", async () => {
    let subjectFeeRecipient: Address;

    beforeEach(async () => {
      if (shouldInitialize) {
        await controller.initialize([], [], [], []);
      }

      subjectFeeRecipient = mockUser.address;
      subjectCaller = owner;
    });

    async function subject(): Promise<any> {
      controller = controller.connect(subjectCaller.wallet);
      return controller.editFeeRecipient(subjectFeeRecipient);
    }

    it("should edit the fee recipient", async () => {
      await subject();

      const newFeeRecipient = await controller.feeRecipient();
      expect(newFeeRecipient).to.eq(mockUser.address);
    });

    it("should emit the FeeRecipientChanged event", async () => {
      await expect(subject()).to.emit(controller, "FeeRecipientChanged").withArgs(subjectFeeRecipient);
    });

    describe("when the new address is empty", async () => {
      beforeEach(async () => {
        subjectFeeRecipient = ADDRESS_ZERO;
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Address must not be 0");
      });
    });

    shouldRevertIfNotAuthorized(subject);
    shouldRevertIfNotInitialized(subject);
  });

  // Reusable specs
  function shouldRevertIfNotAuthorized(subject: any) {
    describe("when the caller is not the owner", async () => {
      beforeEach(async () => {
        subjectCaller = await getRandomAccount();
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Ownable: caller is not the owner");
      });
    });
  }

  function shouldRevertIfNotInitialized(subject: any) {
    describe("when the module is not initialized", async () => {
      before(async () => {
        shouldInitialize = false;
      });

      after(async () => {
        shouldInitialize = true;
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Contract must be initialized.");
      });
    });
  }
});
