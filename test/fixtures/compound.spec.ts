import "module-alias/register";

import { Account } from "@utils/types";
import {
  addSnapshotBeforeRestoreAfterEach,
  ether,
  getAccounts,
  getCompoundFixture,
  getSystemFixture,
  getWaffleExpect
} from "@utils/index";
import { CERc20 } from "../../typechain/CERc20";
import { CEther } from "../../typechain/CEther";
import { CompoundFixture, SystemFixture } from "@utils/fixtures";

const expect = getWaffleExpect();

describe("CompoundFixture", () => {
  let owner: Account;

  let setup: SystemFixture;
  let compoundSetup: CompoundFixture;

  before(async () => {
    [
      owner,
    ] = await getAccounts();

    setup = getSystemFixture(owner.address);
    compoundSetup = getCompoundFixture(owner.address);

    await setup.initialize();
    await compoundSetup.initialize();
  });

  addSnapshotBeforeRestoreAfterEach();

  describe("#createAndEnableCToken", async () => {
    async function subject(): Promise<CERc20> {
      return await compoundSetup.createAndEnableCToken(
        setup.dai.address,
        ether(0.02),
        compoundSetup.comptroller.address,
        compoundSetup.interestRateModel.address,
        "Compound DAI",
        "cDAI",
        8,
        ether(75), // 75% collateral factor
        ether(1)
      );
    }

    it("should create and enable a cToken", async () => {
      const cToken = await subject();

      const isCToken = await cToken.isCToken();
      expect(isCToken).to.be.true;
    });
  });

  describe("#createAndEnableCEther", async () => {
    async function subject(): Promise<CEther> {
      return await compoundSetup.createAndEnableCEther(
        ether(0.02),
        compoundSetup.comptroller.address,
        compoundSetup.interestRateModel.address,
        "Compound ether",
        "cETH",
        8,
        ether(75), // 75% collateral factor
        ether(590)
      );
    }

    it("should create and enable cETH", async () => {
      const cETH = await subject();

      const isCToken = await cETH.isCToken();
      expect(isCToken).to.be.true;
    });
  });
});