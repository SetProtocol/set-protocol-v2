import "module-alias/register";

import { Account } from "@utils/test/types";
import {
  addSnapshotBeforeRestoreAfterEach,
  getAccounts,
  getSystemFixture,
  getUniswapV3Fixture,
  getWaffleExpect,
} from "@utils/test/index";
import { SystemFixture, UniswapV3Fixture } from "@utils/fixtures";

const expect = getWaffleExpect();

describe("UniswapV3Fixture", () => {

  let owner: Account;

  let setup: SystemFixture;
  let uniswapV3Fixture: UniswapV3Fixture;

  before(async () => {
    [ owner ] = await getAccounts();

    setup = getSystemFixture(owner.address);
    uniswapV3Fixture = getUniswapV3Fixture(owner.address);

    await setup.initialize();
  });

  addSnapshotBeforeRestoreAfterEach();

  describe("#initialize", async () => {

    async function subject(): Promise<void> {
      return await uniswapV3Fixture.initialize(owner, setup.weth.address);
    }

    it("should deploy a factory with the correct owner", async () => {
      await subject();

      expect(await uniswapV3Fixture.factory.owner()).to.eq(owner.address);
    });

    it("should deploy a SwapRouter with the correct WETH address", async () => {
      await subject();

      expect(await uniswapV3Fixture.swapRouter.WETH9()).to.eq(setup.weth.address);
    });
  });
});