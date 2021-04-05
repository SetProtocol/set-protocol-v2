import "module-alias/register";

import { Account } from "@utils/test/types";
import DeployHelper from "@utils/deploys";
import {
  ether,
} from "@utils/index";
import {
  addSnapshotBeforeRestoreAfterEach,
  getAccounts,
  getYearnFixture,
  getWaffleExpect
} from "@utils/test/index";
import { StandardTokenMock } from "../../typechain/StandardTokenMock";
import { YearnFixture } from "@utils/fixtures";
import { Vault } from "../../typechain/Vault";


const expect = getWaffleExpect();

describe("YearnFixture", () => {
  let owner: Account;

  // let setup: SystemFixture;
  let yearnSetup: YearnFixture;
  let dai: StandardTokenMock;

  before(async () => {
    [
      owner,
    ] = await getAccounts();

    // setup = getSystemFixture(owner.address);
    const deployer = new DeployHelper(owner.wallet);
    dai = await deployer.mocks.deployTokenMock(owner.address, ether(10000), 18);

    yearnSetup = getYearnFixture(owner.address);

    // await setup.initialize();
    await yearnSetup.initialize();
  });

  addSnapshotBeforeRestoreAfterEach();

  describe("#createAndEnableVaultWithStrategyMock", async () => {
    async function subject(): Promise<Vault> {
      return await yearnSetup.createAndEnableVaultWithStrategyMock(
        dai.address,
        owner.address,
        owner.address,
        owner.address,
        "MockStrategy",
        "M",
        ether(100)
      );
    }

    it("should create and enable a vault", async () => {
      const vault = await subject();

      const governance = await vault.pricePerShare();
      expect(governance).to.eq(ether(1));

      // const strategies = await vault.strategies();
      // console.log("strategies", strategies);
    });
  });

});
