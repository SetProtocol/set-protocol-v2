import "module-alias/register";

import { Address } from "@utils/types";
import { Account } from "@utils/test/types";
import { SetTokenAccessibleMock, SetToken } from "@utils/contracts";
import DeployHelper from "@utils/deploys";
import { ether } from "@utils/index";
import {
  getAccounts,
  getRandomAddress,
  getRandomAccount,
  getSystemFixture,
  getWaffleExpect,
  addSnapshotBeforeRestoreAfterEach,
} from "@utils/test/index";
import { SystemFixture } from "@utils/fixtures";

const expect = getWaffleExpect();

describe("SetTokenAccessible", () => {
  let owner: Account;
  let deployer: DeployHelper;
  let setToken: SetToken;

  let setup: SystemFixture;
  let setTokenAccessible: SetTokenAccessibleMock;

  before(async () => {
    [ owner ] = await getAccounts();

    setup = getSystemFixture(owner.address);
    await setup.initialize();
    deployer = new DeployHelper(owner.wallet);

    setTokenAccessible = await deployer.mocks.deploySetTokenAccessibleMock(setup.controller.address);

    await setup.controller.addModule(setTokenAccessible.address);
    setToken = await setup.createSetToken(
      [setup.weth.address],
      [ether(1)],
      [setTokenAccessible.address],
      owner.address,
    );
  });

  addSnapshotBeforeRestoreAfterEach();

  describe("#updateAllowedSetToken", async () => {
    let subjectSetToken: Address;
    let subjectStatus: boolean;
    let subjectCaller: Account;

    beforeEach(async () => {
      subjectSetToken = await setToken.address;
      subjectStatus = true;
      subjectCaller = owner;
    });

    async function subject(): Promise<any> {
      return setTokenAccessible.connect(subjectCaller.wallet).updateAllowedSetToken(
        subjectSetToken,
        subjectStatus
      );
    }

    it("should add Set to allow list", async () => {
      await subject();

      const isAllowed = await setTokenAccessible.allowedSetTokens(subjectSetToken);

      expect(isAllowed).to.be.true;
    });

    it("should emit the correct SetTokenStatusUpdated event", async () => {
      await expect(subject()).to.emit(setTokenAccessible, "SetTokenStatusUpdated").withArgs(
        subjectSetToken,
        subjectStatus
      );
    });

    describe("when disabling a Set", async () => {
      beforeEach(async () => {
        await subject();
        subjectStatus = false;
      });

      it("should remove Set from allow list", async () => {
        await subject();

        const isAllowed = await setTokenAccessible.allowedSetTokens(subjectSetToken);

        expect(isAllowed).to.be.false;
      });

      it("should emit the correct SetTokenStatusUpdated event", async () => {
        await expect(subject()).to.emit(setTokenAccessible, "SetTokenStatusUpdated").withArgs(
          subjectSetToken,
          subjectStatus
        );
      });

      describe("when Set Token is removed on controller", async () => {
        beforeEach(async () => {
          await setup.controller.removeSet(setToken.address);
        });

        it("should remove the Set from allow list", async () => {
          await subject();

          const isAllowed = await setTokenAccessible.allowedSetTokens(subjectSetToken);

          expect(isAllowed).to.be.false;
        });
      });
    });

    describe("when Set is removed on controller", async () => {
      beforeEach(async () => {
        await setup.controller.removeSet(setToken.address);
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Invalid SetToken");
      });
    });

    describe("when not called by owner", async () => {
      beforeEach(async () => {
        subjectCaller = await getRandomAccount();
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Ownable: caller is not the owner");
      });
    });
  });

  describe("#updateAnySetAllowed", async () => {
    let subjectAnySetAllowed: boolean;
    let subjectCaller: Account;

    beforeEach(async () => {
      subjectAnySetAllowed = true;
      subjectCaller = owner;
    });

    async function subject(): Promise<any> {
      return setTokenAccessible.connect(subjectCaller.wallet).updateAnySetAllowed(subjectAnySetAllowed);
    }

    it("should update anySetAllowed to true", async () => {
      await subject();

      const anySetAllowed = await setTokenAccessible.anySetAllowed();

      expect(anySetAllowed).to.be.true;
    });

    it("should emit the correct AnySetAllowedUpdated event", async () => {
      await expect(subject()).to.emit(setTokenAccessible, "AnySetAllowedUpdated").withArgs(
        subjectAnySetAllowed
      );
    });

    describe("when not called by owner", async () => {
      beforeEach(async () => {
        subjectCaller = await getRandomAccount();
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Ownable: caller is not the owner");
      });
    });
  });

  describe("#onlyAllowedSet", async () => {
    let subjectCaller: Account;
    let subjectSetToken: Address;

    beforeEach(async () => {
      subjectSetToken = setToken.address;
      subjectCaller = owner;
    });

    async function subject(): Promise<any> {
      return setTokenAccessible.connect(subjectCaller.wallet).testOnlyAllowedSet(subjectSetToken);
    }

    describe("when anySetAllowed is true", () => {
      beforeEach(async () => {
        await setTokenAccessible.connect(subjectCaller.wallet).updateAnySetAllowed(true);
      });

      it("should be ok", async () => {
        await subject();
      });
    });

    describe("when anySetAllowed is false and specific set is allowed", () => {
      beforeEach(async () => {
        await setTokenAccessible.connect(subjectCaller.wallet).updateAnySetAllowed(false);
        await setTokenAccessible.updateAllowedSetToken(subjectSetToken, true);
      });

      it("should be ok", async () => {
        await subject();
      });
    });

    describe("when anySetAllowed is false and specific set is not allowed", () => {
      beforeEach(async () => {
        subjectSetToken = await getRandomAddress();
        await setTokenAccessible.connect(subjectCaller.wallet).updateAnySetAllowed(false);
        await setTokenAccessible.allowedSetTokens(subjectSetToken);
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Not allowed SetToken");
      });
    });
  });
});
