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
import { UniswapV3Pool } from "../../typechain/UniswapV3Pool";
import { BigNumber, BigNumberish } from "ethers";
import { StandardTokenMock } from "@typechain/StandardTokenMock";

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
      return await uniswapV3Fixture.initialize(owner, setup.weth.address, setup.wbtc.address, setup.dai.address);
    }

    it("should deploy a factory with the correct owner", async () => {
      await subject();

      expect(await uniswapV3Fixture.factory.owner()).to.eq(owner.address);
    });

    it("should deploy a SwapRouter with the correct WETH address", async () => {
      await subject();

      expect(await uniswapV3Fixture.swapRouter.WETH9()).to.eq(setup.weth.address);
    });

    it("should deploy a NonfungiblePositionManager with the correct WETH address", async () => {
      await subject();

      expect(await uniswapV3Fixture.nftPositionManager.WETH9()).to.eq(setup.weth.address);
    });

    it("should deploy a quoter with the correct WETH address", async () => {
      await subject();

      expect(await uniswapV3Fixture.quoter.WETH9()).to.eq(setup.weth.address);
    });
  });

  describe("#createPool", async () => {

    let subjectTokenOne: StandardTokenMock;
    let subjectTokenTwo: StandardTokenMock;
    let subjectFee: BigNumberish;
    let subjectSqrtPriceX96: BigNumber;

    async function subject(): Promise<UniswapV3Pool> {
      return uniswapV3Fixture.createNewPair(subjectTokenOne.address, subjectTokenTwo.address, subjectFee, subjectSqrtPriceX96);
    }

    beforeEach(async () => {
      await uniswapV3Fixture.initialize(owner, setup.weth.address, setup.wbtc.address, setup.dai.address);

      subjectTokenOne = setup.dai;
      subjectTokenTwo = setup.usdc;
      subjectFee = 3000;
      subjectSqrtPriceX96 = BigNumber.from("79276522817742843495375");
    });

    it("should create a V3 pool with the correct initial price", async () => {
      const pool = await subject();

      const slot0 = await pool.slot0();
      expect(slot0.sqrtPriceX96).to.eq(subjectSqrtPriceX96);
    });
  });
});