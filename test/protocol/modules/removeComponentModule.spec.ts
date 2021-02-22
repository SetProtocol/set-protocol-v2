import "module-alias/register";

import { Address } from "@utils/types";
import { Account } from "@utils/test/types";
import { RemoveComponentModuleMock, SetToken } from "@utils/contracts";
import DeployHelper from "@utils/deploys";
import {
  ether,
  bitcoin,
} from "@utils/index";
import {
  getAccounts,
  getRandomAccount,
  getSystemFixture,
  getWaffleExpect,
  addSnapshotBeforeRestoreAfterEach,
} from "@utils/test/index";
import { SystemFixture } from "@utils/fixtures";

const expect = getWaffleExpect();

describe.only("RemoveComponentModule", () => {
  let owner: Account;
  let deployer: DeployHelper;

  let setup: SystemFixture;

  let removeComponentModule: RemoveComponentModuleMock;
  let setToken: SetToken;

  before(async () => {
    [
      owner,
    ] = await getAccounts();

    setup = getSystemFixture(owner.address);
    await setup.initialize();
    deployer = new DeployHelper(owner.wallet);

    setToken = await setup.createSetToken(
      [setup.weth.address, setup.usdc.address, setup.wbtc.address],
      [ether(1), ether(200), bitcoin(.002)],
      [setup.issuanceModule.address],
    );
  });

  addSnapshotBeforeRestoreAfterEach();

  describe("#constructor", async () => {
    let subjectController: Address;
    let subjectSetToken: Address;
    let subjectComponent: Address;

    beforeEach(async () => {
      subjectController = setup.controller.address;
      subjectSetToken = setToken.address;
      subjectComponent = setup.usdc.address;
    });

    async function subject(): Promise<RemoveComponentModuleMock> {
      return deployer.mocks.deployRemoveComponentModuleMock(
        subjectController,
        subjectSetToken,
        subjectComponent
      );
    }

    it("should have the correct controller", async () => {
      removeComponentModule = await subject();
      const actualController = await removeComponentModule.controller();
      expect(actualController).to.eq(subjectController);
    });

    it("should have the correct setToken", async () => {
      removeComponentModule = await subject();
      const actualSetToken = await removeComponentModule.setToken();
      expect(actualSetToken).to.eq(subjectSetToken);
    });

    it("should have the correct component", async () => {
      removeComponentModule = await subject();
      const actualComponent = await removeComponentModule.component();
      expect(actualComponent).to.eq(subjectComponent);
    });
  });

  context("when the module has been deployed and added to the system and Set", async () => {
    let component: Address;

    beforeEach(async () => {
      component = setup.usdc.address;
      removeComponentModule = await deployer.mocks.deployRemoveComponentModuleMock(
        setup.controller.address,
        setToken.address,
        component
      );

      await setup.controller.addModule(removeComponentModule.address);

      await setToken.addModule(removeComponentModule.address);
    });

    describe("#initialize", async () => {
      let subjectCaller: Account;

      beforeEach(async () => {
        subjectCaller = owner;
      });

      async function subject(): Promise<any> {
        return removeComponentModule.connect(subjectCaller.wallet).initialize();
      }

      it("should enable the Module on the SetToken", async () => {
        await subject();
        const isModuleEnabled = await setToken.isInitializedModule(removeComponentModule.address);
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

      describe("when the module is not pending", async () => {
        beforeEach(async () => {
          await subject();
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("Must be pending initialization");
        });
      });
    });

    describe("#removeComponent", async () => {
      let subjectCaller: Account;

      let addedComponent: Address;
      let addComponent: boolean;

      before(async () => {
        addComponent = true;
        addedComponent = setup.usdc.address;
      });

      beforeEach(async () => {
        await removeComponentModule.initialize();

        if (addComponent) {
          await removeComponentModule.addComponent(addedComponent);
        }

        subjectCaller = owner;
      });

      async function subject(): Promise<any> {
        return removeComponentModule.connect(subjectCaller.wallet).removeComponent();
      }

      it("should remove the double counted component from the array", async () => {
        const preComponents = await setToken.getComponents();
        const expectedPreComponents = [
          setup.weth.address,
          setup.usdc.address,
          setup.wbtc.address,
          setup.usdc.address,
        ];
        expect(JSON.stringify(preComponents)).to.eq(JSON.stringify(expectedPreComponents));

        await subject();

        const postComponents = await setToken.getComponents();
        const expectedPostComponents = [
          setup.weth.address,
          setup.wbtc.address,
          setup.usdc.address,
        ];
        expect(JSON.stringify(postComponents)).to.eq(JSON.stringify(expectedPostComponents));
      });

      it("should flip the used flag to true", async () => {
        await subject();

        const isUsed = await removeComponentModule.used();
        expect(isUsed).to.be.true;
      });

      describe("when the module has already been used", async () => {
        beforeEach(async () => {
          await subject();
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("Module has been used");
        });
      });

      describe("when no duplicate entry exists for the passed component", async () => {
        before(async () => {
          addedComponent = setup.weth.address;
        });

        after(async () => {
          addedComponent = setup.usdc.address;
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("Component does not have duplicate");
        });
      });

      describe("when the caller is not the SetToken manager", async () => {
        beforeEach(async () => {
          subjectCaller = await getRandomAccount();
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("Must be the SetToken manager");
        });
      });
    });
  });
});