import "module-alias/register";
import { BigNumber } from "@ethersproject/bignumber";

import { Address } from "@utils/types";
import { Account } from "@utils/test/types";
import { ADDRESS_ZERO, ZERO, ONE } from "@utils/constants";
import { Controller, SetTokenCreator, StandardTokenMock, SetTokenInternalUtils } from "@utils/contracts";
import DeployHelper from "@utils/deploys";
import {
  ether,
} from "@utils/index";
import {
  getAccounts,
  getProtocolUtils,
  getRandomAddress,
  getWaffleExpect,
} from "@utils/test/index";

const expect = getWaffleExpect();
const protocolUtils = getProtocolUtils();

describe("SetTokenCreator [ @ovm ]", () => {
  let owner: Account;
  let manager: Account;
  let controllerAddress: Account;

  let deployer: DeployHelper;

  before(async () => {
    [
      owner,
      manager,
      controllerAddress,
    ] = await getAccounts();

    deployer = new DeployHelper(owner.wallet);
  });

  describe("constructor", async () => {
    let subjectControllerAddress: Address;
    let setTokenInternalUtils: SetTokenInternalUtils;

    beforeEach(async () => {
      subjectControllerAddress = controllerAddress.address;
    });

    async function subject(): Promise<SetTokenCreator> {
      setTokenInternalUtils = await deployer.core.deploySetTokenInternalUtils();

      return await deployer.core.deploySetTokenCreator(
        subjectControllerAddress,
        setTokenInternalUtils.address,
      );
    }

    it("should have the correct controller", async () => {
      const newSetTokenCreator = await subject();

      const expectedController = await newSetTokenCreator.controller();
      expect(expectedController).to.eq(subjectControllerAddress);
    });
  });

  context("when there is a SetTokenCreator", async () => {
    let controller: Controller;
    let setTokenInternalUtils: SetTokenInternalUtils;
    let setTokenCreator: SetTokenCreator;

    beforeEach(async () => {
      controller = await deployer.core.deployController(owner.address);
      setTokenInternalUtils = await deployer.core.deploySetTokenInternalUtils();

      setTokenCreator = await deployer.core.deploySetTokenCreator(
        controller.address,
        setTokenInternalUtils.address,
      );

      await controller.initialize([setTokenCreator.address], [], [], []);
    });

    describe("#create", async () => {
      let firstComponent: StandardTokenMock;
      let secondComponent: StandardTokenMock;
      let firstModule: Address;
      let secondModule: Address;

      let subjectComponents: Address[];
      let subjectUnits: BigNumber[];
      let subjectModules: Address[];
      let subjectManager: Address;
      let subjectName: string;
      let subjectSymbol: string;

      beforeEach(async () => {
        firstComponent = await deployer.mocks.deployTokenMock(manager.address);
        secondComponent = await deployer.mocks.deployTokenMock(manager.address);
        firstModule = await getRandomAddress();
        secondModule = await getRandomAddress();

        await controller.addModule(firstModule);
        await controller.addModule(secondModule);

        subjectComponents = [firstComponent.address, secondComponent.address];
        subjectUnits = [ether(1), ether(2)];
        subjectModules = [firstModule, secondModule];
        subjectManager = await getRandomAddress();
        subjectName = "TestSetTokenCreator";
        subjectSymbol = "SET";
      });

      async function subject(): Promise<any> {
        return setTokenCreator.create(
          subjectComponents,
          subjectUnits,
          subjectModules,
          subjectManager,
          subjectName,
          subjectSymbol,
        );
      }

      it("should properly create the Set", async () => {
        const receipt = await subject();

        const address = await protocolUtils.getCreatedSetTokenAddress(receipt.hash);
        expect(address).to.be.properAddress;
      });

      it("should enable the Set on the controller", async () => {
        const receipt = await subject();

        const retrievedSetAddress = await protocolUtils.getCreatedSetTokenAddress(receipt.hash);
        const isSetEnabled = await controller.isSet(retrievedSetAddress);
        expect(isSetEnabled).to.eq(true);
      });

      it("should emit the correct SetTokenCreated event", async () => {
        const subjectPromise = subject();
        const retrievedSetAddress = await protocolUtils.getCreatedSetTokenAddress((await subjectPromise).hash);

        await expect(subjectPromise).to.emit(setTokenCreator, "SetTokenCreated").withArgs(
          retrievedSetAddress,
          subjectManager,
          subjectName,
          subjectSymbol
        );
      });

      describe("when no components are passed in", async () => {
        beforeEach(async () => {
          subjectComponents = [];
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("Must have at least 1 component");
        });
      });

      describe("when no components have a duplicate", async () => {
        beforeEach(async () => {
          subjectComponents = [firstComponent.address, firstComponent.address];
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("Duplicate component");
        });
      });

      describe("when the component and units arrays are not the same length", async () => {
        beforeEach(async () => {
          subjectUnits = [ether(1)];
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("Comp. & unit lengths not equal");
        });
      });

      describe("when a module is not approved by the Controller", async () => {
        beforeEach(async () => {
          const invalidModuleAddress = await getRandomAddress();

          subjectModules = [firstModule, invalidModuleAddress];
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("Must be enabled module");
        });
      });

      describe("when no modules are passed in", async () => {
        beforeEach(async () => {
          subjectModules = [];
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("Must have at least 1 module");
        });
      });

      describe("when the manager is a null address", async () => {
        beforeEach(async () => {
          subjectManager = ADDRESS_ZERO;
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("Manager must not be empty");
        });
      });

      describe("when a component is a null address", async () => {
        beforeEach(async () => {
          subjectComponents = [firstComponent.address, ADDRESS_ZERO];
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("Component is null address");
        });
      });

      describe("when a unit is 0", async () => {
        beforeEach(async () => {
          subjectUnits = [ONE, ZERO];
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("Units must be greater than 0");
        });
      });
    });
  });
});
