import "module-alias/register";

import {
  addSnapshotBeforeRestoreAfterEach,
  getAccounts,
  getSystemFixture,
  getUniswapFixture,
  getWaffleExpect,
} from "@utils/test/index";

import DeployHelper from "@utils/deploys";
import { SystemFixture, UniswapFixture } from "@utils/fixtures";
import { Account } from "@utils/test/types";
import { TradeSplitter } from "@utils/contracts";
import { UniswapV2Router02 } from "@utils/contracts";
import { Address } from "@utils/types";
import { bitcoin, ether } from "@utils/common";
import { BigNumber, ContractTransaction } from "ethers";
import { MAX_UINT_256 } from "@utils/constants";

const expect = getWaffleExpect();

describe("TradeSplitter", async () => {

  let owner: Account;
  let trader: Account;
  let deployer: DeployHelper;

  let splitter: TradeSplitter;

  let setup: SystemFixture;
  let uniswapSetup: UniswapFixture;
  let sushiswapSetup: UniswapFixture;

  before(async () => {
    [ owner, trader ] = await getAccounts();

    deployer = new DeployHelper(owner.wallet);
    setup = getSystemFixture(owner.address);
    await setup.initialize();

    uniswapSetup = getUniswapFixture(owner.address);
    await uniswapSetup.initialize(
      owner,
      setup.weth.address,
      setup.wbtc.address,
      setup.dai.address
    );

    sushiswapSetup = getUniswapFixture(owner.address);
    await sushiswapSetup.initialize(
      owner,
      setup.weth.address,
      setup.wbtc.address,
      setup.dai.address
    );

    splitter = await deployer.product.deployTradeSplitter(uniswapSetup.router.address, sushiswapSetup.router.address);
  });

  addSnapshotBeforeRestoreAfterEach();

  describe("#constructor", async () => {

    let subjectUniswapRouter: UniswapV2Router02;
    let subjectSushiswapRouter: UniswapV2Router02;

    beforeEach(() => {
      subjectUniswapRouter = uniswapSetup.router;
      subjectSushiswapRouter = sushiswapSetup.router;
    });

    async function subject(): Promise<TradeSplitter> {
      return deployer.product.deployTradeSplitter(subjectUniswapRouter.address, subjectSushiswapRouter.address);
    }

    it("should set the state variables correctly", async () => {
      const splitter = await subject();

      expect(await splitter.uniRouter()).to.eq(subjectUniswapRouter.address);
      expect(await splitter.sushiRouter()).to.eq(subjectSushiswapRouter.address);
    });
  });

  describe("#swapExactTokensForTokens", async () => {

    let subjectAmountIn: BigNumber;
    let subjectMinAmountOut: BigNumber;
    let subjectPath: Address[];
    let subjectCaller: Account;

    beforeEach(async () => {
      subjectAmountIn = ether(10);
      subjectMinAmountOut = ether(0);
      subjectPath = [ setup.weth.address, setup.dai.address ];
      subjectCaller = trader;

      await setup.weth.approve(uniswapSetup.router.address, MAX_UINT_256);
      await setup.dai.approve(uniswapSetup.router.address, MAX_UINT_256);
      await setup.weth.approve(sushiswapSetup.router.address, MAX_UINT_256);
      await setup.dai.approve(sushiswapSetup.router.address, MAX_UINT_256);

      await setup.weth.transfer(subjectCaller.address, subjectAmountIn);
      await setup.weth.connect(subjectCaller.wallet).approve(splitter.address, MAX_UINT_256);
    });

    async function subject(): Promise<ContractTransaction> {
      return await splitter.connect(subjectCaller.wallet).swapExactTokensForTokens(
        subjectAmountIn,
        subjectMinAmountOut,
        subjectPath,
        subjectCaller.address,
        MAX_UINT_256
      );
    }

    context("when the Uniswap and Sushiswap pools are equal in size", async () => {

      beforeEach(async () => {
        await uniswapSetup.router.addLiquidity(
          setup.weth.address,
          setup.dai.address,
          ether(100),
          ether(100),
          0,
          0,
          owner.address,
          MAX_UINT_256
        );

        await sushiswapSetup.router.addLiquidity(
          setup.weth.address,
          setup.dai.address,
          ether(100),
          ether(100),
          0,
          0,
          owner.address,
          MAX_UINT_256
        );
      });

      it("should split the trade equally between Uniswap and Sushiswap", async () => {

        const uniPool = await uniswapSetup.factory.getPair(setup.weth.address, setup.dai.address);
        const sushiPool = await sushiswapSetup.factory.getPair(setup.weth.address, setup.dai.address);

        const initUniWeth = await setup.weth.balanceOf(uniPool);
        const initSushiWeth = await setup.weth.balanceOf(sushiPool);

        await subject();

        const finalUniWeth = await setup.weth.balanceOf(uniPool);
        const finalSushiWeth = await setup.weth.balanceOf(sushiPool);

        expect(finalUniWeth.sub(initUniWeth)).to.eq(subjectAmountIn.div(2));
        expect(finalSushiWeth.sub(initSushiWeth)).to.eq(subjectAmountIn.div(2));
      });
    });

    context("when 70% of the liquidity is in the Uniswap pool", async () => {
      beforeEach(async () => {
        await uniswapSetup.router.addLiquidity(
          setup.weth.address,
          setup.dai.address,
          ether(70),
          ether(70 * 2500),
          0,
          0,
          owner.address,
          MAX_UINT_256
        );

        await sushiswapSetup.router.addLiquidity(
          setup.weth.address,
          setup.dai.address,
          ether(30),
          ether(30 * 2500),
          0,
          0,
          owner.address,
          MAX_UINT_256
        );
      });

      it("should route 70% of the trade through Uniswap", async () => {

        const uniPool = await uniswapSetup.factory.getPair(setup.weth.address, setup.dai.address);
        const sushiPool = await sushiswapSetup.factory.getPair(setup.weth.address, setup.dai.address);

        const initUniWeth = await setup.weth.balanceOf(uniPool);
        const initSushiWeth = await setup.weth.balanceOf(sushiPool);

        await subject();

        const finalUniWeth = await setup.weth.balanceOf(uniPool);
        const finalSushiWeth = await setup.weth.balanceOf(sushiPool);

        expect(finalUniWeth.sub(initUniWeth)).to.eq(subjectAmountIn.mul(70).div(100));
        expect(finalSushiWeth.sub(initSushiWeth)).to.eq(subjectAmountIn.mul(30).div(100));
      });
    });

    context("when there is only a Uniswap pool", async () => {

      beforeEach(async () => {
        await uniswapSetup.router.addLiquidity(
          setup.weth.address,
          setup.dai.address,
          ether(100),
          ether(100000),
          0,
          0,
          owner.address,
          MAX_UINT_256
        );
      });

      it("should route the entire trade to Uniswap", async () => {

        const uniPool = await uniswapSetup.factory.getPair(setup.weth.address, setup.dai.address);
        const sushiPool = await sushiswapSetup.factory.getPair(setup.weth.address, setup.dai.address);

        const initUniWeth = await setup.weth.balanceOf(uniPool);
        const initSushiWeth = await setup.weth.balanceOf(sushiPool);

        await subject();

        const finalUniWeth = await setup.weth.balanceOf(uniPool);
        const finalSushiWeth = await setup.weth.balanceOf(sushiPool);

        expect(finalUniWeth.sub(initUniWeth)).to.eq(subjectAmountIn);
        expect(finalSushiWeth.sub(initSushiWeth)).to.eq(0);
      });
    });

    context("when there is only a Sushiswap pool", async () => {

      beforeEach(async () => {
        await sushiswapSetup.router.addLiquidity(
          setup.weth.address,
          setup.dai.address,
          ether(100),
          ether(100000),
          0,
          0,
          owner.address,
          MAX_UINT_256
        );
      });

      it("should route the entire trade to Sushiswap", async () => {

        const uniPool = await uniswapSetup.factory.getPair(setup.weth.address, setup.dai.address);
        const sushiPool = await sushiswapSetup.factory.getPair(setup.weth.address, setup.dai.address);

        const initUniWeth = await setup.weth.balanceOf(uniPool);
        const initSushiWeth = await setup.weth.balanceOf(sushiPool);

        await subject();

        const finalUniWeth = await setup.weth.balanceOf(uniPool);
        const finalSushiWeth = await setup.weth.balanceOf(sushiPool);

        expect(finalUniWeth.sub(initUniWeth)).to.eq(0);
        expect(finalSushiWeth.sub(initSushiWeth)).to.eq(subjectAmountIn);
      });
    });

    context("when using two hops", async () => {

      beforeEach(async () => {
        subjectPath = [ setup.weth.address, setup.dai.address, setup.wbtc.address ];

        await setup.wbtc.approve(uniswapSetup.router.address, MAX_UINT_256);
        await setup.wbtc.approve(sushiswapSetup.router.address, MAX_UINT_256);
      });

      context("when the Uniswap and Sushiswap pools are equal in size", async () => {

        beforeEach(async () => {
          await uniswapSetup.router.addLiquidity(
            setup.weth.address,
            setup.dai.address,
            ether(100),
            ether(1000),
            0,
            0,
            owner.address,
            MAX_UINT_256
          );

          await sushiswapSetup.router.addLiquidity(
            setup.weth.address,
            setup.dai.address,
            ether(100),
            ether(1000),
            0,
            0,
            owner.address,
            MAX_UINT_256
          );

          await uniswapSetup.router.addLiquidity(
            setup.wbtc.address,
            setup.dai.address,
            ether(10),
            ether(1000),
            0,
            0,
            owner.address,
            MAX_UINT_256
          );

          await sushiswapSetup.router.addLiquidity(
            setup.wbtc.address,
            setup.dai.address,
            ether(10),
            ether(1000),
            0,
            0,
            owner.address,
            MAX_UINT_256
          );
        });

        it("should split the trade equally between Uniswap and Sushiswap", async () => {
          const uniPool = await uniswapSetup.factory.getPair(setup.weth.address, setup.dai.address);
          const sushiPool = await sushiswapSetup.factory.getPair(setup.weth.address, setup.dai.address);

          const initUniWeth = await setup.weth.balanceOf(uniPool);
          const initSushiWeth = await setup.weth.balanceOf(sushiPool);

          await subject();

          const finalUniWeth = await setup.weth.balanceOf(uniPool);
          const finalSushiWeth = await setup.weth.balanceOf(sushiPool);

          expect(finalUniWeth.sub(initUniWeth)).to.eq(subjectAmountIn.div(2));
          expect(finalSushiWeth.sub(initSushiWeth)).to.eq(subjectAmountIn.div(2));
        });
      });

      context("when 70% of the liquidity is in the Uniswap pools", async () => {
        beforeEach(async () => {
          await uniswapSetup.router.addLiquidity(
            setup.weth.address,
            setup.dai.address,
            ether(70),
            ether(70 * 2500),
            0,
            0,
            owner.address,
            MAX_UINT_256
          );

          await sushiswapSetup.router.addLiquidity(
            setup.weth.address,
            setup.dai.address,
            ether(30),
            ether(30 * 2500),
            0,
            0,
            owner.address,
            MAX_UINT_256
          );

          await uniswapSetup.router.addLiquidity(
            setup.wbtc.address,
            setup.dai.address,
            bitcoin(7),
            ether(7 * 40000),
            0,
            0,
            owner.address,
            MAX_UINT_256
          );

          await sushiswapSetup.router.addLiquidity(
            setup.wbtc.address,
            setup.dai.address,
            bitcoin(3),
            ether(3 * 40000),
            0,
            0,
            owner.address,
            MAX_UINT_256
          );
        });

        it("should route 70% of the trade through Uniswap", async () => {

          const uniPool = await uniswapSetup.factory.getPair(setup.weth.address, setup.dai.address);
          const sushiPool = await sushiswapSetup.factory.getPair(setup.weth.address, setup.dai.address);

          const initUniWeth = await setup.weth.balanceOf(uniPool);
          const initSushiWeth = await setup.weth.balanceOf(sushiPool);

          await subject();

          const finalUniWeth = await setup.weth.balanceOf(uniPool);
          const finalSushiWeth = await setup.weth.balanceOf(sushiPool);

          // need to do a fuzzy check here since the SC math introduces only approximates the split
          expect(finalUniWeth.sub(initUniWeth)).to.gt(subjectAmountIn.mul(69).div(100));
          expect(finalUniWeth.sub(initUniWeth)).to.lt(subjectAmountIn.mul(71).div(100));
          expect(finalSushiWeth.sub(initSushiWeth)).to.gt(subjectAmountIn.mul(29).div(100));
          expect(finalSushiWeth.sub(initSushiWeth)).to.lt(subjectAmountIn.mul(31).div(100));
        });
      });

      context("when there is only a Uniswap pool", async () => {

        beforeEach(async () => {
          await uniswapSetup.router.addLiquidity(
            setup.weth.address,
            setup.dai.address,
            ether(100),
            ether(100000),
            0,
            0,
            owner.address,
            MAX_UINT_256
          );

          await uniswapSetup.router.addLiquidity(
            setup.wbtc.address,
            setup.dai.address,
            ether(10),
            ether(1000),
            0,
            0,
            owner.address,
            MAX_UINT_256
          );
        });

        it("should route the entire trade to Uniswap", async () => {

          const uniPool = await uniswapSetup.factory.getPair(setup.weth.address, setup.dai.address);
          const sushiPool = await sushiswapSetup.factory.getPair(setup.weth.address, setup.dai.address);

          const initUniWeth = await setup.weth.balanceOf(uniPool);
          const initSushiWeth = await setup.weth.balanceOf(sushiPool);

          await subject();

          const finalUniWeth = await setup.weth.balanceOf(uniPool);
          const finalSushiWeth = await setup.weth.balanceOf(sushiPool);

          expect(finalUniWeth.sub(initUniWeth)).to.eq(subjectAmountIn);
          expect(finalSushiWeth.sub(initSushiWeth)).to.eq(0);
        });
      });

      context("when there is only a Sushiswap pool", async () => {

        beforeEach(async () => {
          await sushiswapSetup.router.addLiquidity(
            setup.weth.address,
            setup.dai.address,
            ether(100),
            ether(100000),
            0,
            0,
            owner.address,
            MAX_UINT_256
          );

          await sushiswapSetup.router.addLiquidity(
            setup.wbtc.address,
            setup.dai.address,
            ether(10),
            ether(1000),
            0,
            0,
            owner.address,
            MAX_UINT_256
          );
        });

        it("should route the entire trade to Sushiswap", async () => {

          const uniPool = await uniswapSetup.factory.getPair(setup.weth.address, setup.dai.address);
          const sushiPool = await sushiswapSetup.factory.getPair(setup.weth.address, setup.dai.address);

          const initUniWeth = await setup.weth.balanceOf(uniPool);
          const initSushiWeth = await setup.weth.balanceOf(sushiPool);

          await subject();

          const finalUniWeth = await setup.weth.balanceOf(uniPool);
          const finalSushiWeth = await setup.weth.balanceOf(sushiPool);

          expect(finalUniWeth.sub(initUniWeth)).to.eq(0);
          expect(finalSushiWeth.sub(initSushiWeth)).to.eq(subjectAmountIn);
        });
      });
    });

    context("when the path is too long", async () => {

      beforeEach(() => {
        subjectPath = [ setup.weth.address, setup.wbtc.address, setup.dai.address, setup.usdc.address ];
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("TradeSplitter: incorrect path length");
      });
    });

    context("when the output amount is below _minOutput", async () => {

      beforeEach(async () => {
        subjectMinAmountOut = ether(1000000);

        await uniswapSetup.router.addLiquidity(
          setup.weth.address,
          setup.dai.address,
          ether(100),
          ether(100000),
          0,
          0,
          owner.address,
          MAX_UINT_256
        );
        await sushiswapSetup.router.addLiquidity(
          setup.weth.address,
          setup.dai.address,
          ether(100),
          ether(100000),
          0,
          0,
          owner.address,
          MAX_UINT_256
        );
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("TradeSplitter: INSUFFICIENT_OUTPUT_AMOUNT");
      });
    });
  });

  describe("#swapTokensForExactTokens", async () => {

    let subjectAmountInMax: BigNumber;
    let subjectAmountOut: BigNumber;
    let subjectPath: Address[];
    let subjectCaller: Account;

    beforeEach(async () => {
      subjectAmountOut = ether(10);
      subjectAmountInMax = ether(10000000);
      subjectPath = [ setup.weth.address, setup.dai.address ];
      subjectCaller = trader;

      await setup.weth.approve(uniswapSetup.router.address, MAX_UINT_256);
      await setup.dai.approve(uniswapSetup.router.address, MAX_UINT_256);
      await setup.weth.approve(sushiswapSetup.router.address, MAX_UINT_256);
      await setup.dai.approve(sushiswapSetup.router.address, MAX_UINT_256);

      await setup.weth.transfer(subjectCaller.address, ether(1000));
      await setup.weth.connect(subjectCaller.wallet).approve(splitter.address, MAX_UINT_256);
    });

    async function subject(): Promise<ContractTransaction> {
      return await splitter.connect(subjectCaller.wallet).swapTokensForExactTokens(
        subjectAmountOut,
        subjectAmountInMax,
        subjectPath,
        subjectCaller.address,
        MAX_UINT_256
      );
    }

    context("when the Uniswap and Sushiswap pools are equal in size", async () => {

      beforeEach(async () => {
        await uniswapSetup.router.addLiquidity(
          setup.weth.address,
          setup.dai.address,
          ether(100),
          ether(100),
          0,
          0,
          owner.address,
          MAX_UINT_256
        );

        await sushiswapSetup.router.addLiquidity(
          setup.weth.address,
          setup.dai.address,
          ether(100),
          ether(100),
          0,
          0,
          owner.address,
          MAX_UINT_256
        );
      });

      it("should split the trade equally between Uniswap and Sushiswap", async () => {

        const uniPool = await uniswapSetup.factory.getPair(setup.weth.address, setup.dai.address);
        const sushiPool = await sushiswapSetup.factory.getPair(setup.weth.address, setup.dai.address);

        const initUniDai = await setup.dai.balanceOf(uniPool);
        const initSushiDai = await setup.dai.balanceOf(sushiPool);

        await subject();

        const finalUniDai = await setup.dai.balanceOf(uniPool);
        const finalSushiDai = await setup.dai.balanceOf(sushiPool);

        expect(initUniDai.sub(finalUniDai)).to.eq(subjectAmountOut.div(2));
        expect(initSushiDai.sub(finalSushiDai)).to.eq(subjectAmountOut.div(2));
      });
    });

    context("when 70% of the liquidity is in the Uniswap pool", async () => {
      beforeEach(async () => {
        await uniswapSetup.router.addLiquidity(
          setup.weth.address,
          setup.dai.address,
          ether(70),
          ether(70 * 2500),
          0,
          0,
          owner.address,
          MAX_UINT_256
        );

        await sushiswapSetup.router.addLiquidity(
          setup.weth.address,
          setup.dai.address,
          ether(30),
          ether(30 * 2500),
          0,
          0,
          owner.address,
          MAX_UINT_256
        );
      });

      it("should route 70% of the trade through Uniswap", async () => {

        const uniPool = await uniswapSetup.factory.getPair(setup.weth.address, setup.dai.address);
        const sushiPool = await sushiswapSetup.factory.getPair(setup.weth.address, setup.dai.address);

        const initUniDai = await setup.dai.balanceOf(uniPool);
        const initSushiDai = await setup.dai.balanceOf(sushiPool);

        await subject();

        const finalUniDai = await setup.dai.balanceOf(uniPool);
        const finalSushiDai = await setup.dai.balanceOf(sushiPool);

        expect(initUniDai.sub(finalUniDai)).to.eq(subjectAmountOut.mul(70).div(100));
        expect(initSushiDai.sub(finalSushiDai)).to.eq(subjectAmountOut.mul(30).div(100));
      });
    });

    context("when there is only a Uniswap pool", async () => {

      beforeEach(async () => {
        await uniswapSetup.router.addLiquidity(
          setup.weth.address,
          setup.dai.address,
          ether(100),
          ether(100000),
          0,
          0,
          owner.address,
          MAX_UINT_256
        );
      });

      it("should route the entire trade to Uniswap", async () => {

        const uniPool = await uniswapSetup.factory.getPair(setup.weth.address, setup.dai.address);
        const sushiPool = await sushiswapSetup.factory.getPair(setup.weth.address, setup.dai.address);

        const initUniDai = await setup.dai.balanceOf(uniPool);
        const initSushiDai = await setup.dai.balanceOf(sushiPool);

        await subject();

        const finalUniDai = await setup.dai.balanceOf(uniPool);
        const finalSushiDai = await setup.dai.balanceOf(sushiPool);

        expect(initUniDai.sub(finalUniDai)).to.eq(subjectAmountOut);
        expect(initSushiDai.sub(finalSushiDai)).to.eq(0);
      });
    });

    context("when there is only a Sushiswap pool", async () => {

      beforeEach(async () => {
        await sushiswapSetup.router.addLiquidity(
          setup.weth.address,
          setup.dai.address,
          ether(100),
          ether(100000),
          0,
          0,
          owner.address,
          MAX_UINT_256
        );
      });

      it("should route the entire trade to Sushiswap", async () => {

        const uniPool = await uniswapSetup.factory.getPair(setup.weth.address, setup.dai.address);
        const sushiPool = await sushiswapSetup.factory.getPair(setup.weth.address, setup.dai.address);

        const initUniDai = await setup.dai.balanceOf(uniPool);
        const initSushiDai = await setup.dai.balanceOf(sushiPool);

        await subject();

        const finalUniDai = await setup.dai.balanceOf(uniPool);
        const finalSushiDai = await setup.dai.balanceOf(sushiPool);

        expect(initUniDai.sub(finalUniDai)).to.eq(0);
        expect(initSushiDai.sub(finalSushiDai)).to.eq(subjectAmountOut);
      });
    });

    context("when using two hops", async () => {

      beforeEach(async () => {
        subjectPath = [ setup.weth.address, setup.dai.address, setup.wbtc.address ];
        subjectAmountOut = bitcoin(1);

        await setup.wbtc.approve(uniswapSetup.router.address, MAX_UINT_256);
        await setup.wbtc.approve(sushiswapSetup.router.address, MAX_UINT_256);
      });

      context("when the Uniswap and Sushiswap pools are equal in size", async () => {

        beforeEach(async () => {
          await uniswapSetup.router.addLiquidity(
            setup.weth.address,
            setup.dai.address,
            ether(100),
            ether(1000),
            0,
            0,
            owner.address,
            MAX_UINT_256
          );

          await sushiswapSetup.router.addLiquidity(
            setup.weth.address,
            setup.dai.address,
            ether(100),
            ether(1000),
            0,
            0,
            owner.address,
            MAX_UINT_256
          );

          await uniswapSetup.router.addLiquidity(
            setup.wbtc.address,
            setup.dai.address,
            ether(10),
            ether(1000),
            0,
            0,
            owner.address,
            MAX_UINT_256
          );

          await sushiswapSetup.router.addLiquidity(
            setup.wbtc.address,
            setup.dai.address,
            ether(10),
            ether(1000),
            0,
            0,
            owner.address,
            MAX_UINT_256
          );
        });

        it("should split the trade equally between Uniswap and Sushiswap", async () => {
          const uniPool = await uniswapSetup.factory.getPair(setup.wbtc.address, setup.dai.address);
          const sushiPool = await sushiswapSetup.factory.getPair(setup.wbtc.address, setup.dai.address);

          const initUniWbtc = await setup.wbtc.balanceOf(uniPool);
          const initSushiWbtc = await setup.wbtc.balanceOf(sushiPool);

          await subject();

          const finalUniWbtc = await setup.wbtc.balanceOf(uniPool);
          const finalSushiWbtc = await setup.wbtc.balanceOf(sushiPool);

          expect(initUniWbtc.sub(finalUniWbtc)).to.eq(subjectAmountOut.div(2));
          expect(initSushiWbtc.sub(finalSushiWbtc)).to.eq(subjectAmountOut.div(2));
        });
      });

      context("when 70% of the liquidity is in the Uniswap pools", async () => {
        beforeEach(async () => {
          await uniswapSetup.router.addLiquidity(
            setup.weth.address,
            setup.dai.address,
            ether(70),
            ether(70 * 2500),
            0,
            0,
            owner.address,
            MAX_UINT_256
          );

          await sushiswapSetup.router.addLiquidity(
            setup.weth.address,
            setup.dai.address,
            ether(30),
            ether(30 * 2500),
            0,
            0,
            owner.address,
            MAX_UINT_256
          );

          await uniswapSetup.router.addLiquidity(
            setup.wbtc.address,
            setup.dai.address,
            bitcoin(7),
            ether(7 * 40000),
            0,
            0,
            owner.address,
            MAX_UINT_256
          );

          await sushiswapSetup.router.addLiquidity(
            setup.wbtc.address,
            setup.dai.address,
            bitcoin(3),
            ether(3 * 40000),
            0,
            0,
            owner.address,
            MAX_UINT_256
          );
        });

        it("should route 70% of the trade through Uniswap", async () => {

          const uniPool = await uniswapSetup.factory.getPair(setup.wbtc.address, setup.dai.address);
          const sushiPool = await sushiswapSetup.factory.getPair(setup.wbtc.address, setup.dai.address);

          const initUniWbtc = await setup.wbtc.balanceOf(uniPool);
          const initSushiWbtc = await setup.wbtc.balanceOf(sushiPool);

          await subject();

          const finalUniWbtc = await setup.wbtc.balanceOf(uniPool);
          const finalSushiWbtc = await setup.wbtc.balanceOf(sushiPool);

          // need to do a fuzzy check here since the SC math introduces only approximates the split
          expect(initUniWbtc.sub(finalUniWbtc)).to.gt(subjectAmountOut.mul(69).div(100));
          expect(initUniWbtc.sub(finalUniWbtc)).to.lt(subjectAmountOut.mul(71).div(100));
          expect(initSushiWbtc.sub(finalSushiWbtc)).to.gt(subjectAmountOut.mul(29).div(100));
          expect(initSushiWbtc.sub(finalSushiWbtc)).to.lt(subjectAmountOut.mul(31).div(100));
        });
      });

      context("when there is only a Uniswap pool", async () => {

        beforeEach(async () => {
          await uniswapSetup.router.addLiquidity(
            setup.weth.address,
            setup.dai.address,
            ether(100),
            ether(100000),
            0,
            0,
            owner.address,
            MAX_UINT_256
          );

          await uniswapSetup.router.addLiquidity(
            setup.wbtc.address,
            setup.dai.address,
            ether(10),
            ether(1000),
            0,
            0,
            owner.address,
            MAX_UINT_256
          );
        });

        it("should route the entire trade to Uniswap", async () => {

          const uniPool = await uniswapSetup.factory.getPair(setup.wbtc.address, setup.dai.address);
          const sushiPool = await sushiswapSetup.factory.getPair(setup.wbtc.address, setup.dai.address);

          const initUniWbtc = await setup.wbtc.balanceOf(uniPool);
          const initSushiWbtc = await setup.wbtc.balanceOf(sushiPool);

          await subject();

          const finalUniWbtc = await setup.wbtc.balanceOf(uniPool);
          const finalSushiWbtc = await setup.wbtc.balanceOf(sushiPool);

          expect(initUniWbtc.sub(finalUniWbtc)).to.eq(subjectAmountOut);
          expect(initSushiWbtc.sub(finalSushiWbtc)).to.eq(0);
        });
      });

      context("when there is only a Sushiswap pool", async () => {

        beforeEach(async () => {
          await sushiswapSetup.router.addLiquidity(
            setup.weth.address,
            setup.dai.address,
            ether(100),
            ether(100000),
            0,
            0,
            owner.address,
            MAX_UINT_256
          );

          await sushiswapSetup.router.addLiquidity(
            setup.wbtc.address,
            setup.dai.address,
            ether(10),
            ether(1000),
            0,
            0,
            owner.address,
            MAX_UINT_256
          );
        });

        it("should route the entire trade to Sushiswap", async () => {

          const uniPool = await uniswapSetup.factory.getPair(setup.wbtc.address, setup.dai.address);
          const sushiPool = await sushiswapSetup.factory.getPair(setup.wbtc.address, setup.dai.address);

          const initUniWbtc = await setup.wbtc.balanceOf(uniPool);
          const initSushiWbtc = await setup.wbtc.balanceOf(sushiPool);

          await subject();

          const finalUniWbtc = await setup.wbtc.balanceOf(uniPool);
          const finalSushiWbtc = await setup.wbtc.balanceOf(sushiPool);

          expect(initUniWbtc.sub(finalUniWbtc)).to.eq(0);
          expect(initSushiWbtc.sub(finalSushiWbtc)).to.eq(subjectAmountOut);
        });
      });
    });

    context("when the path is too long", async () => {

      beforeEach(() => {
        subjectPath = [ setup.weth.address, setup.wbtc.address, setup.dai.address, setup.usdc.address ];
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("TradeSplitter: incorrect path length");
      });
    });

    context("when the output amount is below _minOutput", async () => {

      beforeEach(async () => {
        subjectAmountInMax = ether(0);

        await uniswapSetup.router.addLiquidity(
          setup.weth.address,
          setup.dai.address,
          ether(100),
          ether(100000),
          0,
          0,
          owner.address,
          MAX_UINT_256
        );
        await sushiswapSetup.router.addLiquidity(
          setup.weth.address,
          setup.dai.address,
          ether(100),
          ether(100000),
          0,
          0,
          owner.address,
          MAX_UINT_256
        );
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("TradeSplitter: INSUFFICIENT_INPUT_AMOUNT");
      });
    });
  });

  describe("#getQuoteExactInput", async () => {

    let subjectAmountIn: BigNumber;
    let subjectPath: Address[];

    beforeEach(async () => {
      subjectAmountIn = ether(10);
      subjectPath = [ setup.weth.address, setup.dai.address ];

      await setup.weth.approve(uniswapSetup.router.address, MAX_UINT_256);
      await setup.dai.approve(uniswapSetup.router.address, MAX_UINT_256);
      await setup.weth.approve(sushiswapSetup.router.address, MAX_UINT_256);
      await setup.dai.approve(sushiswapSetup.router.address, MAX_UINT_256);

      await setup.weth.transfer(trader.address, ether(1000));
      await setup.weth.connect(trader.wallet).approve(splitter.address, MAX_UINT_256);
    });

    async function subject(): Promise<BigNumber> {
      return await splitter.getQuoteExactInput(
        subjectAmountIn,
        subjectPath
      );
    }

    context("when 70% of the liquidity is in the Uniswap pool", async  () => {

      beforeEach(async () => {
        await uniswapSetup.router.addLiquidity(
          setup.weth.address,
          setup.dai.address,
          ether(70),
          ether(70 * 2500),
          0,
          0,
          owner.address,
          MAX_UINT_256
        );

        await sushiswapSetup.router.addLiquidity(
          setup.weth.address,
          setup.dai.address,
          ether(30),
          ether(30 * 2500),
          0,
          0,
          owner.address,
          MAX_UINT_256
        );
      });

      it("should return a quote that is the same as the actual trade outputs", async () => {

        const quote = await subject();

        const initTraderDai = await setup.dai.balanceOf(trader.address);
        await splitter.connect(trader.wallet).swapExactTokensForTokens(
          subjectAmountIn,
          0,
          subjectPath,
          trader.address,
          MAX_UINT_256
        );
        const finalTraderDai = await setup.dai.balanceOf(trader.address);

        expect(quote).to.eq(finalTraderDai.sub(initTraderDai));
      });
    });

    context("when there is only a Uniswap pool", async  () => {

      beforeEach(async () => {
        await uniswapSetup.router.addLiquidity(
          setup.weth.address,
          setup.dai.address,
          ether(100),
          ether(100 * 2500),
          0,
          0,
          owner.address,
          MAX_UINT_256
        );
      });

      it("should return a quote that is the same as the actual trade outputs", async () => {

        const quote = await subject();

        const initTraderDai = await setup.dai.balanceOf(trader.address);
        await splitter.connect(trader.wallet).swapExactTokensForTokens(
          subjectAmountIn,
          0,
          subjectPath,
          trader.address,
          MAX_UINT_256
        );
        const finalTraderDai = await setup.dai.balanceOf(trader.address);

        expect(quote).to.eq(finalTraderDai.sub(initTraderDai));
      });
    });

    context("when there is only a Sushiswap pool", async  () => {

      beforeEach(async () => {
        await sushiswapSetup.router.addLiquidity(
          setup.weth.address,
          setup.dai.address,
          ether(100),
          ether(100 * 2500),
          0,
          0,
          owner.address,
          MAX_UINT_256
        );
      });

      it("should return a quote that is the same as the actual trade outputs", async () => {

        const quote = await subject();

        const initTraderDai = await setup.dai.balanceOf(trader.address);
        await splitter.connect(trader.wallet).swapExactTokensForTokens(
          subjectAmountIn,
          0,
          subjectPath,
          trader.address,
          MAX_UINT_256
        );
        const finalTraderDai = await setup.dai.balanceOf(trader.address);

        expect(quote).to.eq(finalTraderDai.sub(initTraderDai));
      });
    });

    context("when the path is too long", async () => {

      beforeEach(() => {
        subjectPath = [ setup.weth.address, setup.wbtc.address, setup.dai.address, setup.usdc.address ];
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("TradeSplitter: incorrect path length");
      });
    });
  });

  describe("#getQuoteExactOutput", async () => {

    let subjectAmountOut: BigNumber;
    let subjectPath: Address[];

    beforeEach(async () => {
      subjectAmountOut = ether(10);
      subjectPath = [ setup.weth.address, setup.dai.address ];

      await setup.weth.approve(uniswapSetup.router.address, MAX_UINT_256);
      await setup.dai.approve(uniswapSetup.router.address, MAX_UINT_256);
      await setup.weth.approve(sushiswapSetup.router.address, MAX_UINT_256);
      await setup.dai.approve(sushiswapSetup.router.address, MAX_UINT_256);

      await setup.weth.transfer(trader.address, ether(1000));
      await setup.weth.connect(trader.wallet).approve(splitter.address, MAX_UINT_256);
    });

    async function subject(): Promise<BigNumber> {
      return await splitter.getQuoteExactOutput(
        subjectAmountOut,
        subjectPath
      );
    }

    context("when 70% of the liquidity is in the Uniswap pool", async  () => {

      beforeEach(async () => {
        await uniswapSetup.router.addLiquidity(
          setup.weth.address,
          setup.dai.address,
          ether(70),
          ether(70 * 2500),
          0,
          0,
          owner.address,
          MAX_UINT_256
        );

        await sushiswapSetup.router.addLiquidity(
          setup.weth.address,
          setup.dai.address,
          ether(30),
          ether(30 * 2500),
          0,
          0,
          owner.address,
          MAX_UINT_256
        );
      });

      it("should return a quote that is the same as the actual trade inputs", async () => {

        const quote = await subject();

        const initTraderWeth = await setup.weth.balanceOf(trader.address);
        await splitter.connect(trader.wallet).swapTokensForExactTokens(
          subjectAmountOut,
          MAX_UINT_256,
          subjectPath,
          trader.address,
          MAX_UINT_256
        );
        const finalTraderWeth = await setup.weth.balanceOf(trader.address);

        expect(quote).to.eq(initTraderWeth.sub(finalTraderWeth));
      });
    });

    context("when there is only a Uniswap pool", async  () => {

      beforeEach(async () => {
        await uniswapSetup.router.addLiquidity(
          setup.weth.address,
          setup.dai.address,
          ether(100),
          ether(100 * 2500),
          0,
          0,
          owner.address,
          MAX_UINT_256
        );
      });

      it("should return a quote that is the same as the actual trade inputs", async () => {

        const quote = await subject();

        const initTraderWeth = await setup.weth.balanceOf(trader.address);
        await splitter.connect(trader.wallet).swapTokensForExactTokens(
          subjectAmountOut,
          MAX_UINT_256,
          subjectPath,
          trader.address,
          MAX_UINT_256
        );
        const finalTraderWeth = await setup.weth.balanceOf(trader.address);

        expect(quote).to.eq(initTraderWeth.sub(finalTraderWeth));
      });
    });

    context("when there is only a Sushiswap pool", async  () => {

      beforeEach(async () => {
        await sushiswapSetup.router.addLiquidity(
          setup.weth.address,
          setup.dai.address,
          ether(100),
          ether(100 * 2500),
          0,
          0,
          owner.address,
          MAX_UINT_256
        );
      });

      it("should return a quote that is the same as the actual trade inputs", async () => {

        const quote = await subject();

        const initTraderWeth = await setup.weth.balanceOf(trader.address);
        await splitter.connect(trader.wallet).swapTokensForExactTokens(
          subjectAmountOut,
          MAX_UINT_256,
          subjectPath,
          trader.address,
          MAX_UINT_256
        );
        const finalTraderWeth = await setup.weth.balanceOf(trader.address);

        expect(quote).to.eq(initTraderWeth.sub(finalTraderWeth));
      });
    });

    context("when the path is too long", async () => {

      beforeEach(() => {
        subjectPath = [ setup.weth.address, setup.wbtc.address, setup.dai.address, setup.usdc.address ];
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("TradeSplitter: incorrect path length");
      });
    });
  });
});