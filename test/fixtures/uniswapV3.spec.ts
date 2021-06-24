import "module-alias/register";

import { Account } from "@utils/test/types";
import { BigNumber, BigNumberish } from "ethers";
import { StandardTokenMock } from "@typechain/StandardTokenMock";
import { parseEther } from "ethers/lib/utils";
import { SystemFixture, UniswapV3Fixture } from "@utils/fixtures";

import {
  addSnapshotBeforeRestoreAfterEach,
  getAccounts,
  getSystemFixture,
  getUniswapV3Fixture,
  getWaffleExpect,
} from "@utils/test/index";

import { UniswapV3Pool } from "../../typechain/UniswapV3Pool";
import { WETH9 } from "../../typechain/WETH9";
import { MAX_UINT_256 } from "@utils/constants";
import { ether } from "@utils/common";

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
      return await uniswapV3Fixture.initialize(owner, setup.weth, 2350, setup.wbtc, 35000, setup.dai);
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
    let subjectRatio: number;

    beforeEach(async () => {
      await uniswapV3Fixture.initialize(owner, setup.weth, 2350, setup.wbtc, 35000, setup.dai);

      subjectTokenOne = setup.dai;
      subjectTokenTwo = setup.usdc;
      subjectFee = 3000;
      subjectRatio = 1;
    });

    async function subject(): Promise<UniswapV3Pool> {
      return await uniswapV3Fixture.createNewPair(subjectTokenOne, subjectTokenTwo, subjectFee, subjectRatio);
    }

    it("should create a V3 pool with the correct initial price", async () => {
      const pool = await subject();

      const slot0 = await pool.slot0();

      const ratio = subjectTokenOne.address.toLowerCase() > subjectTokenTwo.address.toLowerCase() ? 1e12 : 1e-12;
      const expectedSqrtPrice = uniswapV3Fixture._getSqrtPriceX96(ratio);

      expect(slot0.sqrtPriceX96).to.eq(expectedSqrtPrice);
    });
  });

  describe("#addLiquidityWide", async () => {

    let subjectTokenOne: StandardTokenMock;
    let subjectTokenTwo: StandardTokenMock | WETH9;
    let subjectFee: number;
    let subjectAmountOne: BigNumber;
    let subjectAmountTwo: BigNumber;

    beforeEach(async () => {
      await uniswapV3Fixture.initialize(owner, setup.weth, 2350, setup.wbtc, 35000, setup.dai);

      subjectTokenOne = setup.dai;
      subjectTokenTwo = setup.weth;
      subjectFee = 3000;
      subjectAmountOne = parseEther("2350");
      subjectAmountTwo = parseEther("1");

      await uniswapV3Fixture.createNewPair(
        subjectTokenOne,
        subjectTokenTwo,
        subjectFee,
        1
      );

      await subjectTokenOne.approve(uniswapV3Fixture.nftPositionManager.address, MAX_UINT_256);
      await subjectTokenTwo.approve(uniswapV3Fixture.nftPositionManager.address, MAX_UINT_256);
    });

    async function subject(): Promise<void> {
      await uniswapV3Fixture.addLiquidityWide(
        subjectTokenOne,
        subjectTokenTwo,
        subjectFee,
        subjectAmountOne,
        subjectAmountTwo,
        owner.address
      );
    }

    it("should add liquidity into the pool", async () => {
      await subject();

      const pool = await uniswapV3Fixture.getPool(subjectTokenOne, subjectTokenTwo, subjectFee);

      expect(await subjectTokenOne.balanceOf(pool.address)).to.gt(subjectAmountOne.sub(ether(1)));
      expect(await subjectTokenTwo.balanceOf(pool.address)).to.eq(subjectAmountTwo);
    });
  });
});