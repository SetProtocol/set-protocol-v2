import "module-alias/register";

import { Account } from "@utils/test/types";
import {
  ether,
} from "@utils/index";
import {
  addSnapshotBeforeRestoreAfterEach,
  getAccounts,
  getSystemFixture,
  getBalancerFixture,
} from "@utils/test/index";
import { SystemFixture, BalancerFixture } from "@utils/fixtures";
import { THREE } from "@utils/constants";

describe("BalancerFixture", () => {
  let owner: Account;

  let setup: SystemFixture;
  let balancerSetup: BalancerFixture;

  before(async () => {
    [
      owner,
    ] = await getAccounts();

    setup = getSystemFixture(owner.address);
    balancerSetup = getBalancerFixture(owner.address);

    await setup.initialize();
  });

  addSnapshotBeforeRestoreAfterEach();

  describe("#initialize", async () => {
    async function subject(): Promise<any> {
      await balancerSetup.initialize(
        owner,
        setup.weth,
        setup.wbtc,
        setup.dai
      );
    }

    it("should deploy a WETH/DAI balancer pool", async () => {
      await subject();

      await setup.weth.approve(balancerSetup.exchange.address, ether(5));
      await balancerSetup.exchange.smartSwapExactOut(
        setup.weth.address,
        setup.dai.address,
        ether(1000),
        ether(5),
        THREE
      );
    });
  });
});