import "module-alias/register";
import { BigNumber } from "@ethersproject/bignumber";

import { Address } from "@utils/types";
import { Account } from "@utils/test/types";
import { SetToken, DebtModuleMock, StandardTokenWithRoundingErrorMock, DebtIssuanceModuleV2 } from "@utils/contracts";
import { ADDRESS_ZERO, ONE, ZERO } from "@utils/constants";
import DeployHelper from "@utils/deploys";
import {
  ether,
} from "@utils/index";
import {
  getAccounts,
  getSystemFixture,
  getWaffleExpect,
  addSnapshotBeforeRestoreAfterEach,
} from "@utils/test/index";
import { SystemFixture } from "@utils/fixtures";

const expect = getWaffleExpect();

describe("DebtIssuanceModuleV2", async () => {
  let owner: Account;
  let deployer: DeployHelper;

  let setup: SystemFixture;

  let debtIssuanceModule: DebtIssuanceModuleV2;
  let debtModule: DebtModuleMock;
  let setToken: SetToken;
  let tokenWithRoundingError: StandardTokenWithRoundingErrorMock;

  before(async () => {
    [
      owner,
    ] = await getAccounts();

    deployer = new DeployHelper(owner.wallet);
    setup = getSystemFixture(owner.address);
    await setup.initialize();

    tokenWithRoundingError = await deployer.mocks.deployTokenWithErrorMock(owner.address, ether(1000000), ZERO);

    debtIssuanceModule = await deployer.modules.deployDebtIssuanceModuleV2(setup.controller.address);
    await setup.controller.addModule(debtIssuanceModule.address);

    debtModule = await deployer.mocks.deployDebtModuleMock(setup.controller.address, debtIssuanceModule.address);
    await setup.controller.addModule(debtModule.address);

    setToken = await setup.createSetToken(
      [tokenWithRoundingError.address],
      [ether(1)],
      [debtIssuanceModule.address, debtModule.address]
    );

    await debtIssuanceModule.initialize(setToken.address, ZERO, ZERO, ZERO, ADDRESS_ZERO, ADDRESS_ZERO);
    await debtModule.initialize(setToken.address);

    // Add external debt position to SetToken
    const debtUnits: BigNumber = ether(100);
    await debtModule.addDebt(setToken.address, setup.dai.address, debtUnits);
    await setup.dai.transfer(debtModule.address, ether(100.5));
  });

  addSnapshotBeforeRestoreAfterEach();

  describe("#issue", async () => {
    let subjectSetToken: Address;
    let subjectQuantity: BigNumber;
    let subjectTo: Address;
    let subjectCaller: Account;

    beforeEach(async () => {
      await tokenWithRoundingError.connect(owner.wallet).approve(debtIssuanceModule.address, ether(100));

      subjectSetToken = setToken.address;
      subjectQuantity = ether(1);
      subjectTo = owner.address;
      subjectCaller = owner;
    });


    async function subject(): Promise<any> {
      await debtIssuanceModule.connect(subjectCaller.wallet).issue(
        subjectSetToken,
        subjectQuantity,
        subjectTo
      );
    }

    describe("when rounding error is negative one", async () => {
      beforeEach(async () => {
        await tokenWithRoundingError.setError(BigNumber.from(-1));
      });

      describe("when set is exactly collateralized", async () => {
        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith(
            "Invalid transfer. Results in undercollateralization"
          );
        });
      });

      describe("when set is over-collateralized by at least 1 wei", async () => {
        beforeEach(async () => {
          await tokenWithRoundingError.connect(owner.wallet).transfer(setToken.address, ONE);
        });

        it("should not revert", async () => {
          await expect(subject()).to.not.be.reverted;
        });
      });
    });

    describe("when rounding error is positive one", async () => {
      beforeEach(async () => {
        await tokenWithRoundingError.setError(ONE);
      });

      describe("when set is exactly collateralized", async () => {
        it("should not revert", async () => {
          await expect(subject()).to.not.be.reverted;
        });
      });

      describe("when set is over-collateralized by at least 1 wei", async () => {
        beforeEach(async () => {
          await tokenWithRoundingError.connect(owner.wallet).transfer(setToken.address, ONE);
        });

        it("should not revert", async () => {
          await expect(subject()).to.not.be.reverted;
        });
      });
    });
  });

  describe("#redeem", async () => {
    let subjectSetToken: Address;
    let subjectQuantity: BigNumber;
    let subjectTo: Address;
    let subjectCaller: Account;

    beforeEach(async () => {
      await tokenWithRoundingError.connect(owner.wallet).approve(debtIssuanceModule.address, ether(100));

      // Add debt to DebtModule to be transferred back to issuer
      await setup.dai.transfer(debtModule.address, ether(200.5));

      await debtIssuanceModule.issue(setToken.address, ether(2), owner.address);

      // Approve debt to be returned
      await setup.dai.connect(owner.wallet).approve(debtIssuanceModule.address, ether(100));

      subjectSetToken = setToken.address;
      subjectQuantity = ether(1);
      subjectTo = owner.address;
      subjectCaller = owner;
    });

    async function subject(): Promise<any> {
      await debtIssuanceModule.connect(subjectCaller.wallet).redeem(
        subjectSetToken,
        subjectQuantity,
        subjectTo
      );
    }

    describe("when rounding error is negative one", async () => {
      beforeEach(async () => {
        await tokenWithRoundingError.setError(BigNumber.from(-1));
      });

      describe("when set is exactly collateralized", async () => {
        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith(
            "Invalid transfer. Results in undercollateralization"
          );
        });
      });

      describe("when set is over-collateralized by at least 1 wei", async () => {
        beforeEach(async () => {
          await tokenWithRoundingError.connect(owner.wallet).transfer(setToken.address, ONE);
        });

        it("should not revert", async () => {
          await expect(subject()).to.not.be.reverted;
        });
      });
    });

    describe("when rounding error is positive one", async () => {
      beforeEach(async () => {
        await tokenWithRoundingError.setError(ONE);
      });

      describe("when set is exactly collateralized", async () => {
        it("should not revert", async () => {
          await expect(subject()).to.not.be.reverted;
        });
      });

      describe("when set is over-collateralized by at least 1 wei", async () => {
        beforeEach(async () => {
          await tokenWithRoundingError.connect(owner.wallet).transfer(setToken.address, ONE);
        });

        it("should not revert", async () => {
          await expect(subject()).to.not.be.reverted;
        });
      });
    });
  });
});