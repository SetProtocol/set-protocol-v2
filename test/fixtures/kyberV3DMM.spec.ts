import "module-alias/register";

import { Account } from "@utils/test/types";
import {
  ether,
} from "@utils/index";
import {
  addSnapshotBeforeRestoreAfterEach,
  getAccounts,
  getSystemFixture,
  getKyberV3DMMFixture,
  getWaffleExpect,
} from "@utils/test/index";
import { SystemFixture, KyberV3DMMFixture } from "@utils/fixtures";
import { ZERO, MAX_UINT_256 } from "@utils/constants";
import { BigNumber } from "ethers";
import { Address } from "@utils/types";
import { DMMPool } from "../../typechain/DMMPool";

const expect = getWaffleExpect();

describe("KyberV3DMMFixture", () => {
  let owner: Account;

  let setup: SystemFixture;
  let kyberSetup: KyberV3DMMFixture;

  before(async () => {
    [
      owner,
    ] = await getAccounts();

    setup = getSystemFixture(owner.address);
    kyberSetup = getKyberV3DMMFixture(owner.address);

    await setup.initialize();
  });

  addSnapshotBeforeRestoreAfterEach();

  describe("#initialize", async () => {
    let subjectOwner: Account;
    let subjectWethAddress: Address;
    let subjectWbtcAddress: Address;
    let subjectDaiAddress: Address;

    beforeEach(async () => {
      subjectOwner = owner;
      subjectWethAddress = setup.weth.address;
      subjectWbtcAddress = setup.wbtc.address;
      subjectDaiAddress = setup.dai.address;
    });

    async function subject(): Promise<void> {
      await kyberSetup.initialize(
        subjectOwner,
        subjectWethAddress,
        subjectWbtcAddress,
        subjectDaiAddress
      );
    }

    it("should deploy a WETH/DAI pool", async () => {
      await subject();

      const poolTokenZero = await kyberSetup.wethDaiPool.token0();
      const poolTokenOne = await kyberSetup.wethDaiPool.token1();

      const [expectedTokenZero, expectedTokenOne] = kyberSetup.getTokenOrder(
        setup.weth.address,
        setup.dai.address
      );

      expect(poolTokenZero).to.eq(expectedTokenZero);
      expect(poolTokenOne).to.eq(expectedTokenOne);
    });

    it("should deploy a WETH/WBTC pool", async () => {
      await subject();

      const poolTokenZero = await kyberSetup.wethWbtcPool.token0();
      const poolTokenOne = await kyberSetup.wethWbtcPool.token1();

      const [expectedTokenZero, expectedTokenOne] = kyberSetup.getTokenOrder(
        setup.weth.address,
        setup.wbtc.address
      );

      expect(poolTokenZero).to.eq(expectedTokenZero);
      expect(poolTokenOne).to.eq(expectedTokenOne);
    });
  });

  describe("#createNewPool", async () => {
    let subjectTokenA: Address;
    let subjectTokenB: Address;
    let subjectAmpBps: BigNumber;

    beforeEach(async () => {
      await kyberSetup.initialize(owner, setup.weth.address, setup.wbtc.address, setup.dai.address);

      subjectTokenA = setup.weth.address;
      subjectTokenB = setup.dai.address;
      subjectAmpBps = BigNumber.from(19000);
    });

    async function subject(): Promise<DMMPool> {
      return await kyberSetup.createNewPool(
        subjectTokenA,
        subjectTokenB,
        subjectAmpBps
      );
    }

    it("should create a new pool with correct amplification factor", async () => {
      const pool = await subject();

      const ampFactor = await pool.ampBps();
      const poolTokenZero = await pool.token0();
      const poolTokenOne = await pool.token1();

      const expectedAmpFactor = BigNumber.from(19000);
      const [expectedTokenZero, expectedTokenOne] = kyberSetup.getTokenOrder(
        setup.weth.address,
        setup.dai.address
      );

      expect(ampFactor).to.eq(expectedAmpFactor);
      expect(poolTokenZero).to.eq(expectedTokenZero);
      expect(poolTokenOne).to.eq(expectedTokenOne);
    });
  });

  describe("mint WETH/DAI pool share", async () => {
    beforeEach(async () => {
      await kyberSetup.initialize(
        owner,
        setup.weth.address,
        setup.wbtc.address,
        setup.dai.address
      );

      await setup.weth.approve(kyberSetup.dmmRouter.address, ether(1));
      await setup.dai.approve(kyberSetup.dmmRouter.address, ether(350));
    });

    async function subject(): Promise<any> {
      await kyberSetup.dmmRouter.addLiquidity(
        setup.weth.address,
        setup.dai.address,
        kyberSetup.wethDaiPool.address,
        ether(1),
        ether(350),
        ether(.99),
        ether(347.5),
        [0, MAX_UINT_256],
        owner.address,
        MAX_UINT_256
      );
    }

    it("should return lp token to owner and decrement amounts", async () => {
      const preDaiBalance = await setup.dai.balanceOf(owner.address);
      const preWethBalance = await setup.weth.balanceOf(owner.address);

      await subject();

      const postDaiBalance = await setup.dai.balanceOf(owner.address);
      const postWethBalance = await setup.weth.balanceOf(owner.address);
      const lpTokenBalance = await kyberSetup.wethDaiPool.balanceOf(owner.address);

      expect(preDaiBalance.sub(ether(350))).to.eq(postDaiBalance);
      expect(preWethBalance.sub(ether(1))).to.eq(postWethBalance);
      expect(lpTokenBalance).to.be.gt(ZERO);
    });
  });
});
