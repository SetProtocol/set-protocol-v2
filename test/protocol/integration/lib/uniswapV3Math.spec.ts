import "module-alias/register";

import { BigNumber } from "ethers";

import { Account } from "@utils/test/types";
import { UniswapV3MathMock } from "@utils/contracts";
import DeployHelper from "@utils/deploys";
import {
  addSnapshotBeforeRestoreAfterEach,
  getAccounts,
  getSystemFixture,
  getWaffleExpect,
  getUniswapV3Fixture,
  getPerpV2Fixture
} from "@utils/test/index";

import { SystemFixture, UniswapV3Fixture, PerpV2Fixture } from "@utils/fixtures";

const expect = getWaffleExpect();

describe("UniswapV3MathLib", () => {
  let owner: Account;
  let deployer: DeployHelper;
  let setup: SystemFixture;
  let uniswapV3Fixture: UniswapV3Fixture;
  let perpV2Fixture: PerpV2Fixture;

  let uniswapV3MathMock: UniswapV3MathMock;

  before(async () => {
    [
      owner,
    ] = await getAccounts();

    deployer = new DeployHelper(owner.wallet);
    setup = getSystemFixture(owner.address);
    await setup.initialize();

    perpV2Fixture = getPerpV2Fixture(owner.address);
    uniswapV3Fixture = getUniswapV3Fixture(owner.address);
    await uniswapV3Fixture.initialize(
      owner,
      setup.weth,
      2500,
      setup.wbtc,
      35000,
      setup.dai
    );

    uniswapV3MathMock = await deployer.mocks.deployUniswapV3MathMock();
  });

  addSnapshotBeforeRestoreAfterEach();

  describe("integration test for #formatSqrtPriceX96ToPriceX96, #formatX96ToX10_18", async () => {
    let subjectSqrtPriceX96: BigNumber;

    beforeEach(async () => {
      subjectSqrtPriceX96 = (await uniswapV3Fixture.wethWbtcPool.slot0()).sqrtPriceX96;
    });

    async function subject(): Promise<BigNumber> {
      const priceX86 = await uniswapV3MathMock.testFormatSqrtPriceX96ToPriceX96(subjectSqrtPriceX96);
      return uniswapV3MathMock.testFormatX96ToX10_18(priceX86);
    };

    it("should format UniswapV3 pool sqrt price correctly", async () => {
      const expectedPrice = await perpV2Fixture.getPriceFromSqrtPriceX96(subjectSqrtPriceX96);
      const price = await subject();

      expect(price).eq(expectedPrice);
    });
  });
});
