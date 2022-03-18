import "module-alias/register";
import { BigNumber } from "ethers";
import { PositionV2, PositionV2Mock, SetToken, StandardTokenMock } from "@utils/contracts";
import DeployHelper from "@utils/deploys";
import {
  ether,
  preciseMul,
  preciseDiv,
  preciseDivCeil,
} from "@utils/index";
import {
  getRandomAddress,
  getSystemFixture,
  getWaffleExpect,
  getAccounts,
  addSnapshotBeforeRestoreAfterEach,
} from "@utils/test/index";

import { Address } from "@utils/types";
import { Account } from "@utils/test/types";
import { ZERO, PRECISE_UNIT, ADDRESS_ZERO, ONE } from "@utils/constants";
import { SystemFixture } from "@utils/fixtures";

const expect = getWaffleExpect();

describe("PositionV2", () => {
  let owner: Account, moduleOne: Account, moduleTwo: Account;
  let setToken: SetToken;
  let deployer: DeployHelper;
  let setup: SystemFixture;

  let positionLib: PositionV2;
  let componentOne: StandardTokenMock;
  let componentTwo: StandardTokenMock;
  let componentThree: StandardTokenMock;

  let components: Address[];
  let units: BigNumber[];
  let modules: Address[];

  let positionLibMock: PositionV2Mock;

  before(async () => {
    [
      owner,
      moduleOne,
      moduleTwo,
    ] = await getAccounts();

    deployer = new DeployHelper(owner.wallet);
    setup = getSystemFixture(owner.address);
    await setup.initialize();

    positionLib = await deployer.libraries.deployPositionV2();
    positionLibMock = await deployer.mocks.deployPositionV2Mock(
      "contracts/protocol/lib/PositionV2.sol:PositionV2",
      positionLib.address
    );
    await setup.controller.addModule(positionLibMock.address);
    await setup.controller.addModule(moduleOne.address);

    componentOne = await deployer.mocks.deployTokenMock(owner.address);
    componentTwo = await deployer.mocks.deployTokenMock(owner.address);
    componentThree = await deployer.mocks.deployTokenMock(owner.address);

    components = [componentOne.address, componentTwo.address];
    units = [ether(1), ether(2)];
    modules = [moduleOne.address, positionLibMock.address, setup.issuanceModule.address];

    setToken = await setup.createSetToken(components, units, modules);

    setToken = setToken.connect(moduleOne.wallet);
    await setToken.initializeModule();

    await positionLibMock.initialize(setToken.address);
    await setup.issuanceModule.initialize(setToken.address, ADDRESS_ZERO);
  });

  addSnapshotBeforeRestoreAfterEach();

  describe("#hasDefaultPosition", async () => {
    let subjectSetToken: Address;
    let subjectComponent: Address;

    beforeEach(async () => {
      subjectSetToken = setToken.address;
      subjectComponent = componentTwo.address;
    });

    async function subject(): Promise<any> {
      return positionLibMock.testHasDefaultPosition(subjectSetToken, subjectComponent);
    }

    it("should find the asked for position", async () => {
      const isDefaultPositionFound = await subject();
      expect(isDefaultPositionFound).to.eq(true);
    });

    describe("when the component does not have a positive value on the SetToken", async () => {
      beforeEach(async () => {
        await setToken.connect(moduleOne.wallet).editDefaultPositionUnit(subjectComponent, ZERO);
      });

      it("should return false", async () => {
        const isDefaultPositionFound = await subject();
        expect(isDefaultPositionFound).to.eq(false);
      });
    });
  });

  describe("#hasExternalPosition", async () => {
    let subjectSetToken: Address;
    let subjectComponent: Address;

    beforeEach(async () => {
      subjectSetToken = setToken.address;
      subjectComponent = componentTwo.address;

      await setToken.connect(moduleOne.wallet).addExternalPositionModule(
        subjectComponent,
        moduleOne.address,
      );
    });

    async function subject(): Promise<any> {
      return positionLibMock.testHasExternalPosition(subjectSetToken, subjectComponent);
    }

    it("should find the asked for position", async () => {
      const isDefaultPositionFound = await subject();
      expect(isDefaultPositionFound).to.eq(true);
    });

    describe("when the component does not have an external module", async () => {
      beforeEach(async () => {
        await setToken.connect(moduleOne.wallet).removeExternalPositionModule(
          subjectComponent,
          moduleOne.address,
        );
      });

      it("should return false", async () => {
        const isDefaultPositionFound = await subject();
        expect(isDefaultPositionFound).to.eq(false);
      });
    });
  });

  describe("#hasSufficientDefaultUnits", async () => {
    let subjectSetToken: Address;
    let subjectComponent: Address;
    let subjectUnit: BigNumber;

    beforeEach(async () => {
      subjectSetToken = setToken.address;
      subjectComponent = componentTwo.address;
      subjectUnit = ether(2);
    });

    async function subject(): Promise<any> {
      return positionLibMock.testHasSufficientDefaultUnits(
        subjectSetToken,
        subjectComponent,
        subjectUnit,
      );
    }

    it("should return true", async () => {
      const hasSufficientUnits = await subject();
      expect(hasSufficientUnits).to.eq(true);
    });

    describe("when the is less than the Position Unit", async () => {
      beforeEach(async () => {
        subjectUnit = ether(1);
      });

      it("should return false", async () => {
        const hasSufficientUnits = await subject();
        expect(hasSufficientUnits).to.eq(true);
      });
    });

    describe("when the is more than the Position Unit", async () => {
      beforeEach(async () => {
        subjectUnit = ether(3);
      });

      it("should return false", async () => {
        const hasSufficientUnits = await subject();
        expect(hasSufficientUnits).to.eq(false);
      });
    });
  });

  describe("#hasSufficientExternalUnits", async () => {
    let subjectSetToken: Address;
    let subjectComponent: Address;
    let subjectModule: Address;
    let subjectUnit: BigNumber;

    beforeEach(async () => {
      subjectSetToken = setToken.address;
      subjectComponent = componentOne.address;
      subjectModule = moduleOne.address;
      subjectUnit = ether(2);

      await setToken.connect(moduleOne.wallet).editExternalPositionUnit(
        subjectComponent,
        subjectModule,
        ether(2)
      );
    });

    async function subject(): Promise<any> {
      return positionLibMock.testHasSufficientExternalUnits(
        subjectSetToken,
        subjectComponent,
        subjectModule,
        subjectUnit,
      );
    }

    it("should return true", async () => {
      const hasSufficientUnits = await subject();
      expect(hasSufficientUnits).to.eq(true);
    });

    describe("when the is less than the Position Unit", async () => {
      beforeEach(async () => {
        subjectUnit = ether(1);
      });

      it("should return false", async () => {
        const hasSufficientUnits = await subject();
        expect(hasSufficientUnits).to.eq(true);
      });
    });

    describe("when the is more than the Position Unit", async () => {
      beforeEach(async () => {
        subjectUnit = ether(3);
      });

      it("should return false", async () => {
        const hasSufficientUnits = await subject();
        expect(hasSufficientUnits).to.eq(false);
      });
    });
  });

  describe("#editDefaultPosition", async () => {
    let subjectSetTokenAddress: Address;
    let subjectComponent: Address;
    let subjectUnit: BigNumber;

    beforeEach(async () => {
      subjectSetTokenAddress = setToken.address;
      subjectComponent = componentTwo.address;
      subjectUnit = ether(3);
    });

    async function subject(): Promise<any> {
      return positionLibMock.testEditDefaultPosition(
        subjectSetTokenAddress,
        subjectComponent,
        subjectUnit
      );
    }

    context("when the position exists", async () => {
      it("should set the units", async () => {
        await subject();

        const afterEditPosition = await setToken.getDefaultPositionRealUnit(subjectComponent);
        const expectedUnit = subjectUnit;
        expect(afterEditPosition).to.eq(expectedUnit);
      });
    });

    describe("when the default position is originally 0", async () => {
      beforeEach(async () => {
        subjectComponent = await getRandomAddress();
      });

      it("should set the units", async () => {
        await subject();

        const afterEditPosition = await setToken.getDefaultPositionRealUnit(subjectComponent);
        const expectedUnit = subjectUnit;
        expect(afterEditPosition).to.eq(expectedUnit);
      });

      it("should add the component to the components array", async () => {
        const previousComponents = await setToken.getComponents();

        await subject();

        const currentComponents = await setToken.getComponents();
        expect(currentComponents.length).to.eq(previousComponents.length + 1);
      });

      describe("when the component has an external position", async () => {
        beforeEach(async () => {
          await setToken.connect(moduleOne.wallet).addExternalPositionModule(
            subjectComponent,
            moduleOne.address
          );
        });

        it("should not add the component from the components array", async () => {
          const previousComponents = await setToken.getComponents();

          await subject();

          const currentComponents = await setToken.getComponents();
          expect(currentComponents.length).to.eq(previousComponents.length);
        });
      });

      describe("when the component unit is 0", async () => {
        beforeEach(async () => {
          subjectUnit = ZERO;
        });

        it("should not add any components", async () => {
          const previousComponents = await setToken.getComponents();

          await subject();

          const currentComponents = await setToken.getComponents();
          expect(currentComponents.length).to.eq(previousComponents.length);
        });
      });
    });

    describe("when the position is set to 0", async () => {
      beforeEach(async () => {
        subjectUnit = ZERO;
      });

      it("should set the default units 0", async () => {
        await subject();

        const retrievedRealUnit = await setToken.getDefaultPositionRealUnit(subjectComponent);
        expect(retrievedRealUnit).to.eq(ZERO);
      });

      it("should remove the component from the components array", async () => {
        const previousComponents = await setToken.getComponents();

        await subject();

        const currentComponents = await setToken.getComponents();
        expect(currentComponents.length).to.eq(previousComponents.length - 1);
      });

      describe("when the component has an external position", async () => {
        beforeEach(async () => {
          await setToken.connect(moduleOne.wallet).addExternalPositionModule(
            subjectComponent,
            moduleOne.address
          );
        });

        it("should not remove the component from the components array", async () => {
          const previousComponents = await setToken.getComponents();

          await subject();

          const currentComponents = await setToken.getComponents();
          expect(currentComponents.length).to.eq(previousComponents.length);
        });
      });
    });
  });

  describe("#calculateAndEditDefaultPosition", async () => {
    let subjectSetTokenAddress: Address;
    let subjectComponent: Address;
    let subjectSetTokenSupply: BigNumber;
    let subjectPreviousComponentBalance: BigNumber;

    beforeEach(async () => {
      subjectSetTokenAddress = setToken.address;
      subjectComponent = componentTwo.address;
      subjectSetTokenSupply = ether(3);
      subjectPreviousComponentBalance = preciseMul(subjectSetTokenSupply, ether(2));

      // Mint some set tokens
      await setup.approveAndIssueSetToken(setToken, subjectSetTokenSupply);
    });

    async function subject(): Promise<any> {
      return positionLibMock.testCalculateAndEditDefaultPosition(
        subjectSetTokenAddress,
        subjectComponent,
        subjectSetTokenSupply,
        subjectPreviousComponentBalance
      );
    }

    it("should set the correct units", async () => {
      const componentTwoUnit = ether(2);

      await subject();

      const componentTwoBalance = await componentTwo.balanceOf(setToken.address);
      const newPositionUnit = await setToken.getDefaultPositionRealUnit(subjectComponent);
      const expectedPosition = await positionLibMock.testCalculateDefaultEditPositionUnit(
        subjectSetTokenSupply,
        subjectPreviousComponentBalance,
        componentTwoBalance,
        componentTwoUnit
      );

      expect(newPositionUnit).to.eq(expectedPosition);
    });

    describe("when the amount of the subjectComponent is 0", async () => {
      beforeEach(async () => {
        subjectComponent = componentThree.address;
      });

      it("should not add the component to the components array", async () => {
        await subject();

        const postComponents = await setToken.getDefaultPositionRealUnit(subjectComponent);
        expect(postComponents).to.eq(ZERO);
      });
    });
  });

  describe("#editExternalPosition", async () => {
    let subjectSetToken: Address;
    let subjectComponent: Address;
    let subjectModule: Address;
    let subjectNewUnit: BigNumber;
    let subjectData: string;

    beforeEach(async () => {
      subjectSetToken = setToken.address;
      subjectComponent = componentThree.address;
      subjectModule = moduleOne.address;
      subjectNewUnit = ether(3);
      subjectData = "0x1234";
    });

    async function subject(): Promise<any> {
      return positionLibMock.testEditExternalPosition(
        subjectSetToken,
        subjectComponent,
        subjectModule,
        subjectNewUnit,
        subjectData
      );
    }

    context("no position exists for the component", async () => {
      it("should add the component to the components array", async () => {
        const preComponents = await setToken.getComponents();
        expect(preComponents).to.not.contain(subjectComponent);

        await subject();

        const postComponents = await setToken.getComponents();
        expect(postComponents).to.contain(subjectComponent);
      });

      it("should add the new external position", async () => {
        const preModules = await setToken.getExternalPositionModules(subjectComponent);
        expect(preModules.length).to.eq(0);

        await subject();

        const postModules = await setToken.getExternalPositionModules(subjectComponent);
        const unit = await setToken.getExternalPositionRealUnit(subjectComponent, subjectModule);
        const data = await setToken.getExternalPositionData(subjectComponent, subjectModule);
        expect(postModules).to.contain(subjectModule);
        expect(unit).to.eq(subjectNewUnit);
        expect(data).to.eq("0x1234");
      });

      describe("and calling module is calling with 0 unit", async () => {
        beforeEach(async () => {
          subjectNewUnit = ZERO;
          subjectData = "0x";
        });

        it("should not add the component to the components array", async () => {
          const preComponents = await setToken.getComponents();
          expect(preComponents).to.not.contain(subjectComponent);

          await subject();

          const postComponents = await setToken.getComponents();
          expect(postComponents).to.not.contain(subjectComponent);
        });

        it("should not add the new external position", async () => {
          const preModules = await setToken.getExternalPositionModules(subjectComponent);
          expect(preModules.length).to.eq(0);

          await subject();

          const postModules = await setToken.getExternalPositionModules(subjectComponent);
          const unit = await setToken.getExternalPositionRealUnit(subjectComponent, subjectModule);
          const data = await setToken.getExternalPositionData(subjectComponent, subjectModule);
          expect(postModules).to.not.contain(subjectModule);
          expect(unit).to.eq(ZERO);
          expect(data).to.eq("0x");
        });
      });
    });

    context("only a default position exists for the component", async () => {
      beforeEach(async () => {
        subjectComponent = componentTwo.address;
      });

      it("should not add anything to the components array", async () => {
        const preComponents = await setToken.getComponents();
        expect(preComponents).to.contain(subjectComponent);
        expect(preComponents.length).to.eq(2);

        await subject();

        const postComponents = await setToken.getComponents();
        expect(postComponents).to.contain(subjectComponent);
        expect(preComponents.length).to.eq(2);
      });

      it("should add the new external position", async () => {
        const preModules = await setToken.getExternalPositionModules(subjectComponent);
        expect(preModules.length).to.eq(0);

        await subject();

        const modules = await setToken.getExternalPositionModules(subjectComponent);
        const unit = await setToken.getExternalPositionRealUnit(subjectComponent, subjectModule);
        const data = await setToken.getExternalPositionData(subjectComponent, subjectModule);
        expect(modules).to.contain(subjectModule);
        expect(unit).to.eq(subjectNewUnit);
        expect(data).to.eq("0x1234");
      });
    });

    context("when adding to an existing external position", async () => {
      beforeEach(async () => {
        await subject();

        subjectNewUnit = ether(2);
        subjectData = "0x4567";
      });

      it("should add the new external position", async () => {
        const preModules = await setToken.getExternalPositionModules(subjectComponent);
        expect(preModules.length).to.eq(1);

        await subject();

        const modules = await setToken.getExternalPositionModules(subjectComponent);
        const unit = await setToken.getExternalPositionRealUnit(subjectComponent, subjectModule);
        const data = await setToken.getExternalPositionData(subjectComponent, subjectModule);
        expect(modules).to.contain(subjectModule);
        expect(unit).to.eq(subjectNewUnit);
        expect(data).to.eq("0x4567");
      });
    });

    context("when removing an external position but default position still exists", async () => {
      beforeEach(async () => {
        subjectComponent = componentTwo.address;
        await subject();
        subjectNewUnit = ZERO;
        subjectData = "0x";
      });

      it("should remove the module from the modules array, components stay the same", async () => {
        const preComponents = await setToken.getComponents();
        const preModules = await setToken.getExternalPositionModules(subjectComponent);
        expect(preComponents).to.contain(subjectComponent);
        expect(preComponents.length).to.eq(2);
        expect(preModules.length).to.eq(1);

        await subject();

        const postComponents = await setToken.getComponents();
        const postModules = await setToken.getExternalPositionModules(subjectComponent);
        expect(postComponents).to.contain(subjectComponent);
        expect(preComponents.length).to.eq(2);
        expect(postModules.length).to.eq(0);
      });

      it("should update the unit and delete the data", async () => {
        await subject();

        const postUnit = await setToken.getExternalPositionRealUnit(subjectComponent, subjectModule);
        const data = await setToken.getExternalPositionData(subjectComponent, subjectModule);
        expect(postUnit).to.eq(ZERO);
        expect(data).to.eq("0x");
      });

      describe("but passed data is not 0", async () => {
        beforeEach(async () => {
          subjectData = "0x4567";
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("Passed data must be null");
        });
      });
    });

    context("when removing an external position and no default position", async () => {
      beforeEach(async () => {
        await subject();
        subjectNewUnit = ZERO;
        subjectData = "0x";
      });

      it("should remove entry from the modules and components array", async () => {
        const preComponents = await setToken.getComponents();
        const preModules = await setToken.getExternalPositionModules(subjectComponent);
        expect(preComponents).to.contain(subjectComponent);
        expect(preComponents.length).to.eq(3);
        expect(preModules.length).to.eq(1);

        await subject();

        const postComponents = await setToken.getComponents();
        const postModules = await setToken.getExternalPositionModules(subjectComponent);
        expect(postComponents).to.not.contain(subjectComponent);
        expect(postComponents.length).to.eq(2);
        expect(postModules.length).to.eq(0);
      });

      it("should update the unit and delete the data", async () => {
        await subject();

        const postUnit = await setToken.getExternalPositionRealUnit(subjectComponent, subjectModule);
        const data = await setToken.getExternalPositionData(subjectComponent, subjectModule);
        expect(postUnit).to.eq(ZERO);
        expect(data).to.eq("0x");
      });

      describe("but passed module is not the one being tracked", async () => {
        beforeEach(async () => {
          await setToken.connect(moduleOne.wallet).editExternalPositionUnit(subjectComponent, moduleTwo.address, ONE);
          subjectModule = moduleTwo.address;
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("External positions must be 0 to remove component");
        });
      });
    });
  });

  describe("#getDefaultTrackedBalance", async () => {
    let subjectSetToken: Address;
    let subjectComponent: Address;

    let totalSupply: BigNumber;

    beforeEach(async () => {
      subjectSetToken = setToken.address;
      subjectComponent = componentTwo.address;
      totalSupply = ether(5);

      await componentOne.approve(setup.issuanceModule.address, ether(100));
      await componentTwo.approve(setup.issuanceModule.address, ether(100));
      await setup.issuanceModule.issue(subjectSetToken, totalSupply, owner.address);
    });

    async function subject(): Promise<BigNumber> {
      return positionLibMock.testGetDefaultTrackedBalance(
        subjectSetToken,
        subjectComponent
      );
    }

    it("should return correct position unit quantity", async () => {
      const retrievedQuantity = await subject();
      const expectedResult = preciseMul(totalSupply, ether(2));
      expect(retrievedQuantity).to.eq(expectedResult);
    });
  });

  describe("#getDefaultTotalNotional", async () => {
    let subjectSetTokenSupply: BigNumber;
    let subjectPositionUnit: BigNumber;

    beforeEach(async () => {
      subjectSetTokenSupply = ether(2);
      subjectPositionUnit = ether(10);
    });

    async function subject(): Promise<any> {
      return positionLibMock.testGetDefaultTotalNotional(
        subjectSetTokenSupply,
        subjectPositionUnit
      );
    }

    it("should return correct total notional", async () => {
      const totalNotional = await subject();
      const expectedTotalNotional = subjectPositionUnit.mul(subjectSetTokenSupply).div(PRECISE_UNIT);
      expect(totalNotional).to.eq(expectedTotalNotional);
    });
  });

  describe("#getDefaultPositionUnit", async () => {
    let subjectSetTokenSupply: BigNumber;
    let subjectTotalNotional: BigNumber;

    beforeEach(async () => {
      subjectSetTokenSupply = ether(2);
      subjectTotalNotional = ether(10);
    });

    async function subject(): Promise<any> {
      return positionLibMock.testGetDefaultPositionUnit(
        subjectSetTokenSupply,
        subjectTotalNotional
      );
    }

    it("should return correct position unit", async () => {
      const positionUnit = await subject();
      const expectedPositionUnit = subjectTotalNotional.mul(PRECISE_UNIT).div(subjectSetTokenSupply);
      expect(positionUnit).to.eq(expectedPositionUnit);
    });
  });

  describe("#calculateDefaultEditPositionUnit", async () => {
    let subjectSetTokenSupply: BigNumber;
    let subjectPreTotalNotional: BigNumber;
    let subjectPostTotalNotional: BigNumber;
    let subjectPrePositionUnit: BigNumber;

    beforeEach(async () => {
      subjectSetTokenSupply = ether(2);
      subjectPreTotalNotional = ether(2);
      subjectPostTotalNotional = ether(1);
      subjectPrePositionUnit = ether(1);
    });

    async function subject(): Promise<any> {
      return positionLibMock.testCalculateDefaultEditPositionUnit(
        subjectSetTokenSupply,
        subjectPreTotalNotional,
        subjectPostTotalNotional,
        subjectPrePositionUnit
      );
    }

    it("should calculate correct new position unit", async () => {
      const newPositionUnit = await subject();

      const unitToSub = preciseDivCeil(subjectPreTotalNotional.sub(subjectPostTotalNotional), subjectSetTokenSupply);
      const expectedPositionUnit = subjectPrePositionUnit.sub(unitToSub);
      expect(newPositionUnit).to.eq(expectedPositionUnit);
    });

    describe("when post action notional is greater than pre action notional", async () => {
      beforeEach(async () => {
        subjectPreTotalNotional = ether(1);
        subjectPrePositionUnit = ether(.5);
        subjectPostTotalNotional = ether(2);
      });

      it("should calculate correct new position unit", async () => {
        const newPositionUnit = await subject();

        const unitToAdd = preciseDiv(subjectPostTotalNotional.sub(subjectPreTotalNotional), subjectSetTokenSupply);
        const expectedPositionUnit = subjectPrePositionUnit.add(unitToAdd);
        expect(newPositionUnit).to.eq(expectedPositionUnit);
      });
    });

    describe("when resulting position unit requires rounding, it rounds down", async () => {
      beforeEach(async () => {
        subjectPrePositionUnit = ether(.99999999999999999);
      });

      it("should calculate correct new position unit", async () => {
        const newPositionUnit = await subject();

        const unitToAdd = preciseDiv(subjectPostTotalNotional.sub(subjectPreTotalNotional), subjectSetTokenSupply);
        const expectedPositionUnit = subjectPrePositionUnit.add(unitToAdd);

        expect(newPositionUnit).to.eq(expectedPositionUnit);
      });
    });
  });
});
