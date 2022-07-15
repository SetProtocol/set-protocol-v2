import "module-alias/register";
import { Account } from "@utils/test/types";
// import DeployHelper from "@utils/deploys";
import {
  getAccounts,
  getSystemFixture,
} from "@utils/test/index";

import { SystemFixture } from "@utils/fixtures";

describe("ArrakisUniswapV3AmmAdapter", () => {
  let owner: Account;
  // let deployer: DeployHelper;
  let setup: SystemFixture;

  before(async () => {
    [
      owner,
    ] = await getAccounts();

    // deployer = new DeployHelper(owner.wallet);
    setup = getSystemFixture(owner.address);
    await setup.initialize();
  });

});
