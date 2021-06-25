import "module-alias/register";

import {
  addSnapshotBeforeRestoreAfterEach,
  getAccounts,
  getRandomAccount,
  getSystemFixture,
  getUniswapFixture,
  getWaffleExpect,
} from "@utils/test/index";

import DeployHelper from "@utils/deploys";
import { SystemFixture, UniswapFixture } from "@utils/fixtures";
import { Account } from "@utils/test/types";
import { AMMSplitter, UniswapV2Factory } from "@utils/contracts";
import { UniswapV2Router02 } from "@utils/contracts";
import { Address } from "@utils/types";
import { bitcoin, ether, preciseMul } from "@utils/common";
import { BigNumber, ContractTransaction } from "ethers";
import { MAX_UINT_256 } from "@utils/constants";

const expect = getWaffleExpect();

describe("AMMSplitter", async () => {

  let owner: Account;
  let trader: Account;
  let deployer: DeployHelper;

  let splitter: AMMSplitter;

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

    splitter = await deployer.product.deployAMMSplitter(
      uniswapSetup.router.address,
      sushiswapSetup.router.address,
      uniswapSetup.factory.address,
      sushiswapSetup.factory.address
    );
  });

  addSnapshotBeforeRestoreAfterEach();

  describe("#constructor", async () => {

    let subjectUniswapRouter: UniswapV2Router02;
    let subjectSushiswapRouter: UniswapV2Router02;
    let subjectUniswapFactory: UniswapV2Factory;
    let subjectSushiswapFactory: UniswapV2Factory;

    beforeEach(() => {
      subjectUniswapRouter = uniswapSetup.router;
      subjectSushiswapRouter = sushiswapSetup.router;
      subjectUniswapFactory = uniswapSetup.factory;
      subjectSushiswapFactory = sushiswapSetup.factory;
    });

    async function subject(): Promise<AMMSplitter> {
      return deployer.product.deployAMMSplitter(
        subjectUniswapRouter.address,
        subjectSushiswapRouter.address,
        subjectUniswapFactory.address,
        subjectSushiswapFactory.address
      );
    }

    it("should set the state variables correctly", async () => {
      const splitter = await subject();

      expect(await splitter.uniRouter()).to.eq(subjectUniswapRouter.address);
      expect(await splitter.sushiRouter()).to.eq(subjectSushiswapRouter.address);
      expect(await splitter.uniFactory()).to.eq(subjectUniswapFactory.address);
      expect(await splitter.sushiFactory()).to.eq(subjectSushiswapFactory.address);
    });
  });

  describe("#swapExactTokensForTokens", async () => {

    let subjectAmountIn: BigNumber;
    let subjectMinAmountOut: BigNumber;
    let subjectPath: Address[];
    let subjectCaller: Account;
    let subjectTo: Account;

    beforeEach(async () => {
      subjectAmountIn = ether(10);
      subjectMinAmountOut = ether(0);
      subjectPath = [ setup.weth.address, setup.dai.address ];
      subjectCaller = trader;
      subjectTo = await getRandomAccount();

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
        subjectTo.address,
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

      it("should return the correct output amount", async () => {

        const expectedUniOutput = (await uniswapSetup.router.getAmountsOut(subjectAmountIn.div(2), subjectPath))[1];
        const expectedSushiOutput = (await sushiswapSetup.router.getAmountsOut(subjectAmountIn.div(2), subjectPath))[1];
        const expectedTotalOutput = expectedUniOutput.add(expectedSushiOutput);

        const initTraderDai = await setup.dai.balanceOf(subjectTo.address);

        await subject();

        const finalTraderDai = await setup.dai.balanceOf(subjectTo.address);

        expect(finalTraderDai.sub(initTraderDai)).to.eq(expectedTotalOutput);
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

      it("should return the correct output amount", async () => {

        const expectedUniOutput = (await uniswapSetup.router.getAmountsOut(subjectAmountIn.mul(70).div(100), subjectPath))[1];
        const expectedSushiOutput = (await sushiswapSetup.router.getAmountsOut(subjectAmountIn.mul(30).div(100), subjectPath))[1];
        const expectedTotalOutput = expectedUniOutput.add(expectedSushiOutput);

        const initTraderDai = await setup.dai.balanceOf(subjectTo.address);

        await subject();

        const finalTraderDai = await setup.dai.balanceOf(subjectTo.address);

        expect(finalTraderDai.sub(initTraderDai)).to.eq(expectedTotalOutput);
      });

      it("should emit a TradeExactInputExecuted event", async () => {
        const uniTradeSize = subjectAmountIn.mul(70).div(100);
        const sushiTradeSize = subjectAmountIn.mul(30).div(100);

        const expectedUniOutput = (await uniswapSetup.router.getAmountsOut(uniTradeSize, subjectPath))[1];
        const expectedSushiOutput = (await sushiswapSetup.router.getAmountsOut(sushiTradeSize, subjectPath))[1];
        const expectedTotalOutput = expectedUniOutput.add(expectedSushiOutput);

        await expect(subject()).to.emit(splitter, "TradeExactInputExecuted").withArgs(
          subjectPath[0],
          subjectPath[1],
          subjectTo.address,
          subjectAmountIn,
          expectedTotalOutput,
          uniTradeSize,
          sushiTradeSize
        );
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

      it("should return the correct output amount", async () => {

        const expectedTotalOutput = (await uniswapSetup.router.getAmountsOut(subjectAmountIn, subjectPath))[1];

        const initTraderDai = await setup.dai.balanceOf(subjectTo.address);

        await subject();

        const finalTraderDai = await setup.dai.balanceOf(subjectTo.address);

        expect(finalTraderDai.sub(initTraderDai)).to.eq(expectedTotalOutput);
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

      it("should return the correct output amount", async () => {

        const expectedTotalOutput = (await sushiswapSetup.router.getAmountsOut(subjectAmountIn, subjectPath))[1];

        const initTraderDai = await setup.dai.balanceOf(subjectTo.address);

        await subject();

        const finalTraderDai = await setup.dai.balanceOf(subjectTo.address);

        expect(finalTraderDai.sub(initTraderDai)).to.eq(expectedTotalOutput);
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

        it("should return the correct output amount", async () => {

          const expectedUniOutput = (await uniswapSetup.router.getAmountsOut(subjectAmountIn.div(2), subjectPath))[2];
          const expectedSushiOutput = (await sushiswapSetup.router.getAmountsOut(subjectAmountIn.div(2), subjectPath))[2];
          const expectedTotalOutput = expectedUniOutput.add(expectedSushiOutput);

          const initTraderWbtc = await setup.wbtc.balanceOf(subjectTo.address);

          await subject();

          const finalTraderWbtc = await setup.wbtc.balanceOf(subjectTo.address);

          expect(finalTraderWbtc.sub(initTraderWbtc)).to.eq(expectedTotalOutput);
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

          // need to do a fuzzy check here since the SC math only approximates the split
          expect(finalUniWeth.sub(initUniWeth)).to.gt(subjectAmountIn.mul(69).div(100));
          expect(finalUniWeth.sub(initUniWeth)).to.lt(subjectAmountIn.mul(71).div(100));
          expect(finalSushiWeth.sub(initSushiWeth)).to.gt(subjectAmountIn.mul(29).div(100));
          expect(finalSushiWeth.sub(initSushiWeth)).to.lt(subjectAmountIn.mul(31).div(100));
        });

        it("should return the correct output amount", async () => {

          const expectedUniOutput = (await uniswapSetup.router.getAmountsOut(subjectAmountIn.mul(70).div(100), subjectPath))[2];
          const expectedSushiOutput = (await sushiswapSetup.router.getAmountsOut(subjectAmountIn.mul(30).div(100), subjectPath))[2];
          const expectedTotalOutput = expectedUniOutput.add(expectedSushiOutput);

          const initTraderWbtc = await setup.wbtc.balanceOf(subjectTo.address);

          await subject();

          const finalTraderWbtc = await setup.wbtc.balanceOf(subjectTo.address);

          expect(finalTraderWbtc.sub(initTraderWbtc)).to.lt(preciseMul(expectedTotalOutput, ether(1.001)));
          expect(finalTraderWbtc.sub(initTraderWbtc)).to.gt(preciseMul(expectedTotalOutput, ether(0.999)));
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

        it("should return the correct output amount", async () => {

          const expectedTotalOutput = (await uniswapSetup.router.getAmountsOut(subjectAmountIn, subjectPath))[2];

          const initTraderWbtc = await setup.wbtc.balanceOf(subjectTo.address);

          await subject();

          const finalTraderWbtc = await setup.wbtc.balanceOf(subjectTo.address);

          expect(finalTraderWbtc.sub(initTraderWbtc)).to.eq(expectedTotalOutput);
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

        it("should return the correct output amount", async () => {

          const expectedTotalOutput = (await sushiswapSetup.router.getAmountsOut(subjectAmountIn, subjectPath))[2];

          const initTraderWbtc = await setup.wbtc.balanceOf(subjectTo.address);

          await subject();

          const finalTraderWbtc = await setup.wbtc.balanceOf(subjectTo.address);

          expect(finalTraderWbtc.sub(initTraderWbtc)).to.eq(expectedTotalOutput);
        });
      });

      context("when the first pool has more liquidity on Uniswap, and the second has more liquidity on Sushiswap", async () => {

        let uniLiqPoolADai: number;
        let uniLiqPoolBDai: number;
        let sushiLiqPoolADai: number;
        let sushiLiqPoolBDai: number;

        beforeEach(async () => {

          uniLiqPoolADai = 70 * 2500;
          await uniswapSetup.router.addLiquidity(
            setup.weth.address,
            setup.dai.address,
            ether(70),
            ether(uniLiqPoolADai),
            0,
            0,
            owner.address,
            MAX_UINT_256
          );

          sushiLiqPoolADai = 30 * 2500;
          await sushiswapSetup.router.addLiquidity(
            setup.weth.address,
            setup.dai.address,
            ether(30),
            ether(sushiLiqPoolADai),
            0,
            0,
            owner.address,
            MAX_UINT_256
          );

          uniLiqPoolBDai = 4 * 40000;
          await uniswapSetup.router.addLiquidity(
            setup.wbtc.address,
            setup.dai.address,
            bitcoin(4),
            ether(uniLiqPoolBDai),
            0,
            0,
            owner.address,
            MAX_UINT_256
          );

          sushiLiqPoolBDai = 6 * 40000;
          await sushiswapSetup.router.addLiquidity(
            setup.wbtc.address,
            setup.dai.address,
            bitcoin(6),
            ether(sushiLiqPoolBDai),
            0,
            0,
            owner.address,
            MAX_UINT_256
          );
        });

        it("should route the correct amounts to Uniswap and Sushiswap", async () => {

          const uniPool = await uniswapSetup.factory.getPair(setup.weth.address, setup.dai.address);
          const sushiPool = await sushiswapSetup.factory.getPair(setup.weth.address, setup.dai.address);

          const initUniWeth = await setup.weth.balanceOf(uniPool);
          const initSushiWeth = await setup.weth.balanceOf(sushiPool);

          await subject();

          const finalUniWeth = await setup.weth.balanceOf(uniPool);
          const finalSushiWeth = await setup.weth.balanceOf(sushiPool);

          const a = ((sushiLiqPoolADai + sushiLiqPoolBDai) * uniLiqPoolADai * uniLiqPoolBDai);
          const b = ((uniLiqPoolADai + uniLiqPoolBDai) * sushiLiqPoolADai * sushiLiqPoolBDai);
          const uniRatio = a / b;
          const uniSize = uniRatio / (uniRatio + 1);
          const expectedUniTradeInput = preciseMul(subjectAmountIn, ether(uniSize));
          const expectedSushiTradeInput = subjectAmountIn.sub(expectedUniTradeInput);

          // need to do a fuzzy check since actual amount deposited into pools is slightly less than requested
          expect(finalUniWeth.sub(initUniWeth)).to.lt(preciseMul(expectedUniTradeInput, ether(1.001)));
          expect(finalUniWeth.sub(initUniWeth)).to.gt(preciseMul(expectedUniTradeInput, ether(0.999)));
          expect(finalSushiWeth.sub(initSushiWeth)).to.lt(preciseMul(expectedSushiTradeInput, ether(1.001)));
          expect(finalSushiWeth.sub(initSushiWeth)).to.gt(preciseMul(expectedSushiTradeInput, ether(0.999)));
        });

        it("should return the correct output amount", async () => {

          const a = ((sushiLiqPoolADai + sushiLiqPoolBDai) * uniLiqPoolADai * uniLiqPoolBDai);
          const b = ((uniLiqPoolADai + uniLiqPoolBDai) * sushiLiqPoolADai * sushiLiqPoolBDai);
          const uniRatio = a / b;
          const uniSize = uniRatio / (uniRatio + 1);
          const expectedUniTradeInput = preciseMul(subjectAmountIn, ether(uniSize));
          const expectedSushiTradeInput = subjectAmountIn.sub(expectedUniTradeInput);

          const expectedUniOutput = (await uniswapSetup.router.getAmountsOut(expectedUniTradeInput, subjectPath))[2];
          const expectedSushiOutput = (await sushiswapSetup.router.getAmountsOut(expectedSushiTradeInput, subjectPath))[2];
          const expectedTotalOutput = expectedUniOutput.add(expectedSushiOutput);

          const initTraderWbtc = await setup.wbtc.balanceOf(subjectTo.address);

          await subject();

          const finalTraderWbtc = await setup.wbtc.balanceOf(subjectTo.address);

          // need to do a fuzzy check since actual amount deposited into pools is slightly less than requested
          expect(finalTraderWbtc.sub(initTraderWbtc)).to.lt(preciseMul(expectedTotalOutput, ether(1.001)));
          expect(finalTraderWbtc.sub(initTraderWbtc)).to.gt(preciseMul(expectedTotalOutput, ether(0.999)));
        });
      });

      context("when a token with less than 18 decimals is the intermediary trade token", async () => {

        beforeEach(() => {
          subjectPath = [ setup.weth.address, setup.wbtc.address, setup.dai.address ];
          subjectAmountIn = ether(2);
          subjectMinAmountOut = ether(0);
        });

        context("when the Uniswap and Sushiswap pools are equal in size", async () => {

          beforeEach(async () => {
            await uniswapSetup.router.addLiquidity(
              setup.weth.address,
              setup.wbtc.address,
              ether(100),
              bitcoin(10),
              0,
              0,
              owner.address,
              MAX_UINT_256
            );

            await sushiswapSetup.router.addLiquidity(
              setup.weth.address,
              setup.wbtc.address,
              ether(100),
              bitcoin(10),
              0,
              0,
              owner.address,
              MAX_UINT_256
            );

            await uniswapSetup.router.addLiquidity(
              setup.wbtc.address,
              setup.dai.address,
              bitcoin(10),
              ether(1000),
              0,
              0,
              owner.address,
              MAX_UINT_256
            );

            await sushiswapSetup.router.addLiquidity(
              setup.wbtc.address,
              setup.dai.address,
              bitcoin(10),
              ether(1000),
              0,
              0,
              owner.address,
              MAX_UINT_256
            );
          });

          it("should split the trade equally between Uniswap and Sushiswap", async () => {
            const uniPool = await uniswapSetup.factory.getPair(setup.weth.address, setup.wbtc.address);
            const sushiPool = await sushiswapSetup.factory.getPair(setup.weth.address, setup.wbtc.address);

            const initUniWeth = await setup.weth.balanceOf(uniPool);
            const initSushiWeth = await setup.weth.balanceOf(sushiPool);

            await subject();

            const finalUniWeth = await setup.weth.balanceOf(uniPool);
            const finalSushiWeth = await setup.weth.balanceOf(sushiPool);

            expect(finalUniWeth.sub(initUniWeth)).to.eq(subjectAmountIn.div(2));
            expect(finalSushiWeth.sub(initSushiWeth)).to.eq(subjectAmountIn.div(2));
          });

          it("should return the correct output amount", async () => {

            const expectedUniOutput = (await uniswapSetup.router.getAmountsOut(subjectAmountIn.div(2), subjectPath))[2];
            const expectedSushiOutput = (await sushiswapSetup.router.getAmountsOut(subjectAmountIn.div(2), subjectPath))[2];
            const expectedTotalOutput = expectedUniOutput.add(expectedSushiOutput);

            const initTraderWbtc = await setup.dai.balanceOf(subjectTo.address);

            await subject();

            const finalTraderWbtc = await setup.dai.balanceOf(subjectTo.address);

            expect(finalTraderWbtc.sub(initTraderWbtc)).to.eq(expectedTotalOutput);
          });
        });
      });
    });

    context("when the path is too long", async () => {

      beforeEach(() => {
        subjectPath = [ setup.weth.address, setup.wbtc.address, setup.dai.address, setup.usdc.address ];
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("AMMSplitter: incorrect path length");
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
        await expect(subject()).to.be.revertedWith("AMMSplitter: INSUFFICIENT_OUTPUT_AMOUNT");
      });
    });
  });

  describe("#swapTokensForExactTokens", async () => {

    let subjectAmountInMax: BigNumber;
    let subjectAmountOut: BigNumber;
    let subjectPath: Address[];
    let subjectCaller: Account;
    let subjectTo: Account;

    beforeEach(async () => {
      subjectAmountOut = ether(10);
      subjectAmountInMax = ether(10000000);
      subjectPath = [ setup.weth.address, setup.dai.address ];
      subjectCaller = trader;
      subjectTo = await getRandomAccount();

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
        subjectTo.address,
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

      it("should spend the correct input amount", async () => {

        const expectedUniInput = (await uniswapSetup.router.getAmountsIn(subjectAmountOut.div(2), subjectPath))[0];
        const expectedSushiInput = (await sushiswapSetup.router.getAmountsIn(subjectAmountOut.div(2), subjectPath))[0];
        const expectedTotalInput = expectedUniInput.add(expectedSushiInput);

        const initCallerWeth = await setup.weth.balanceOf(subjectCaller.address);

        await subject();

        const finalCallerWeth = await setup.weth.balanceOf(subjectCaller.address);

        expect(initCallerWeth.sub(finalCallerWeth)).to.eq(expectedTotalInput);
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

      it("should spend the correct input amount", async () => {

        const expectedUniInput = (await uniswapSetup.router.getAmountsIn(subjectAmountOut.mul(70).div(100), subjectPath))[0];
        const expectedSushiInput = (await sushiswapSetup.router.getAmountsIn(subjectAmountOut.mul(30).div(100), subjectPath))[0];
        const expectedTotalInput = expectedUniInput.add(expectedSushiInput);

        const initCallerWeth = await setup.weth.balanceOf(subjectCaller.address);

        await subject();

        const finalCallerWeth = await setup.weth.balanceOf(subjectCaller.address);

        expect(initCallerWeth.sub(finalCallerWeth)).to.eq(expectedTotalInput);
      });

      it("should emit a TradeExactOutputExecuted event", async () => {
        const uniTradeSize = subjectAmountOut.mul(70).div(100);
        const sushiTradeSize = subjectAmountOut.mul(30).div(100);

        const expectedUniInput = (await uniswapSetup.router.getAmountsIn(uniTradeSize, subjectPath))[0];
        const expectedSushiInput = (await sushiswapSetup.router.getAmountsIn(sushiTradeSize, subjectPath))[0];
        const expectedTotalInput = expectedUniInput.add(expectedSushiInput);

        await expect(subject()).to.emit(splitter, "TradeExactOutputExecuted").withArgs(
          subjectPath[0],
          subjectPath[1],
          subjectTo.address,
          expectedTotalInput,
          subjectAmountOut,
          uniTradeSize,
          sushiTradeSize
        );
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

      it("should spend the correct input amount", async () => {

        const expectedTotalInput = (await uniswapSetup.router.getAmountsIn(subjectAmountOut, subjectPath))[0];

        const initCallerWeth = await setup.weth.balanceOf(subjectCaller.address);

        await subject();

        const finalCallerWeth = await setup.weth.balanceOf(subjectCaller.address);

        expect(initCallerWeth.sub(finalCallerWeth)).to.eq(expectedTotalInput);
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

      it("should spend the correct input amount", async () => {

        const expectedTotalInput = (await sushiswapSetup.router.getAmountsIn(subjectAmountOut, subjectPath))[0];

        const initCallerWeth = await setup.weth.balanceOf(subjectCaller.address);

        await subject();

        const finalCallerWeth = await setup.weth.balanceOf(subjectCaller.address);

        expect(initCallerWeth.sub(finalCallerWeth)).to.eq(expectedTotalInput);
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

        it("should spend the correct input amount", async () => {

          const expectedUniInput = (await uniswapSetup.router.getAmountsIn(subjectAmountOut.div(2), subjectPath))[0];
          const expectedSushiInput = (await sushiswapSetup.router.getAmountsIn(subjectAmountOut.div(2), subjectPath))[0];
          const expectedTotalInput = expectedUniInput.add(expectedSushiInput);

          const initCallerWeth = await setup.weth.balanceOf(subjectCaller.address);

          await subject();

          const finalCallerWeth = await setup.weth.balanceOf(subjectCaller.address);

          expect(initCallerWeth.sub(finalCallerWeth)).to.lt(preciseMul(expectedTotalInput, ether(1.001)));
          expect(initCallerWeth.sub(finalCallerWeth)).to.gt(preciseMul(expectedTotalInput, ether(0.999)));
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

          // need to do a fuzzy check here since the SC math only approximates the split
          expect(initUniWbtc.sub(finalUniWbtc)).to.gt(subjectAmountOut.mul(69).div(100));
          expect(initUniWbtc.sub(finalUniWbtc)).to.lt(subjectAmountOut.mul(71).div(100));
          expect(initSushiWbtc.sub(finalSushiWbtc)).to.gt(subjectAmountOut.mul(29).div(100));
          expect(initSushiWbtc.sub(finalSushiWbtc)).to.lt(subjectAmountOut.mul(31).div(100));
        });

        it("should spend the correct input amount", async () => {

          const expectedUniInput = (await uniswapSetup.router.getAmountsIn(subjectAmountOut.mul(70).div(100), subjectPath))[0];
          const expectedSushiInput = (await sushiswapSetup.router.getAmountsIn(subjectAmountOut.mul(30).div(100), subjectPath))[0];
          const expectedTotalInput = expectedUniInput.add(expectedSushiInput);

          const initCallerWeth = await setup.weth.balanceOf(subjectCaller.address);

          await subject();

          const finalCallerWeth = await setup.weth.balanceOf(subjectCaller.address);

          expect(initCallerWeth.sub(finalCallerWeth)).to.lt(preciseMul(expectedTotalInput, ether(1.001)));
          expect(initCallerWeth.sub(finalCallerWeth)).to.gt(preciseMul(expectedTotalInput, ether(0.999)));
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

        it("should spend the correct input amount", async () => {

          const expectedTotalInput = (await uniswapSetup.router.getAmountsIn(subjectAmountOut, subjectPath))[0];

          const initCallerWeth = await setup.weth.balanceOf(subjectCaller.address);

          await subject();

          const finalCallerWeth = await setup.weth.balanceOf(subjectCaller.address);

          expect(initCallerWeth.sub(finalCallerWeth)).to.eq(expectedTotalInput);
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

        it("should spend the correct input amount", async () => {

          const expectedTotalInput = (await sushiswapSetup.router.getAmountsIn(subjectAmountOut, subjectPath))[0];

          const initCallerWeth = await setup.weth.balanceOf(subjectCaller.address);

          await subject();

          const finalCallerWeth = await setup.weth.balanceOf(subjectCaller.address);

          expect(initCallerWeth.sub(finalCallerWeth)).to.eq(expectedTotalInput);
        });
      });

      context("when the first pool has more liquidity on Uniswap, and the second has more liquidity on Sushiswap", async () => {

        let uniLiqPoolADai: number;
        let uniLiqPoolBDai: number;
        let sushiLiqPoolADai: number;
        let sushiLiqPoolBDai: number;

        beforeEach(async () => {

          uniLiqPoolADai = 4 * 40000;
          await uniswapSetup.router.addLiquidity(
            setup.wbtc.address,
            setup.dai.address,
            bitcoin(4),
            ether(uniLiqPoolADai),
            0,
            0,
            owner.address,
            MAX_UINT_256
          );

          sushiLiqPoolADai = 6 * 40000;
          await sushiswapSetup.router.addLiquidity(
            setup.wbtc.address,
            setup.dai.address,
            bitcoin(6),
            ether(sushiLiqPoolADai),
            0,
            0,
            owner.address,
            MAX_UINT_256
          );

          uniLiqPoolBDai = 70 * 2500;
          await uniswapSetup.router.addLiquidity(
            setup.weth.address,
            setup.dai.address,
            ether(70),
            ether(uniLiqPoolBDai),
            0,
            0,
            owner.address,
            MAX_UINT_256
          );

          sushiLiqPoolBDai = 30 * 2500;
          await sushiswapSetup.router.addLiquidity(
            setup.weth.address,
            setup.dai.address,
            ether(30),
            ether(sushiLiqPoolBDai),
            0,
            0,
            owner.address,
            MAX_UINT_256
          );
        });

        it("should route the correct amounts to Uniswap and Sushiswap", async () => {

          const uniPool = await uniswapSetup.factory.getPair(setup.dai.address, setup.wbtc.address);
          const sushiPool = await sushiswapSetup.factory.getPair(setup.dai.address, setup.wbtc.address);

          const initUniWbtc = await setup.wbtc.balanceOf(uniPool);
          const initSushiWbtc = await setup.wbtc.balanceOf(sushiPool);

          await subject();

          const finalUniWbtc = await setup.wbtc.balanceOf(uniPool);
          const finalSushiWbtc = await setup.wbtc.balanceOf(sushiPool);

          const a = ((sushiLiqPoolADai + sushiLiqPoolBDai) * uniLiqPoolADai * uniLiqPoolBDai);
          const b = ((uniLiqPoolADai + uniLiqPoolBDai) * sushiLiqPoolADai * sushiLiqPoolBDai);
          const uniRatio = a / b;
          const uniSize = uniRatio / (uniRatio + 1);
          const expectedUniTradeOutput = preciseMul(subjectAmountOut, ether(uniSize));
          const expectedSushiTradeOutput = subjectAmountOut.sub(expectedUniTradeOutput);

          // need to do a fuzzy check since actual amount deposited into pools is slightly less than requested
          expect(initUniWbtc.sub(finalUniWbtc)).to.lt(preciseMul(expectedUniTradeOutput, ether(1.001)));
          expect(initUniWbtc.sub(finalUniWbtc)).to.gt(preciseMul(expectedUniTradeOutput, ether(0.999)));
          expect(initSushiWbtc.sub(finalSushiWbtc)).to.lt(preciseMul(expectedSushiTradeOutput, ether(1.001)));
          expect(initSushiWbtc.sub(finalSushiWbtc)).to.gt(preciseMul(expectedSushiTradeOutput, ether(0.999)));
        });

        it("should return the correct output amount", async () => {
          const a = ((sushiLiqPoolADai + sushiLiqPoolBDai) * uniLiqPoolADai * uniLiqPoolBDai);
          const b = ((uniLiqPoolADai + uniLiqPoolBDai) * sushiLiqPoolADai * sushiLiqPoolBDai);
          const uniRatio = a / b;
          const uniSize = uniRatio / (uniRatio + 1);
          const expectedUniTradeOutput = preciseMul(subjectAmountOut, ether(uniSize));
          const expectedSushiTradeOutput = subjectAmountOut.sub(expectedUniTradeOutput);

          const expectedUniInput = (await uniswapSetup.router.getAmountsIn(expectedUniTradeOutput, subjectPath))[0];
          const expectedSushiInput = (await sushiswapSetup.router.getAmountsIn(expectedSushiTradeOutput, subjectPath))[0];
          const expectedTotalInput = expectedUniInput.add(expectedSushiInput);

          const initCallerWeth = await setup.weth.balanceOf(subjectCaller.address);

          await subject();

          const finalCallerWeth = await setup.weth.balanceOf(subjectCaller.address);

          // need to do a fuzzy check since actual amount deposited into pools is slightly less than requested
          expect(initCallerWeth.sub(finalCallerWeth)).to.lt(preciseMul(expectedTotalInput, ether(1.001)));
          expect(initCallerWeth.sub(finalCallerWeth)).to.gt(preciseMul(expectedTotalInput, ether(0.999)));
        });
      });

      context("when a token with less than 18 decimals is the intermediary trade token", async () => {

        beforeEach(() => {
          subjectPath = [ setup.weth.address, setup.wbtc.address, setup.dai.address ];
          subjectAmountOut = ether(100);
        });

        context("when the Uniswap and Sushiswap pools are equal in size", async () => {

          beforeEach(async () => {
            await uniswapSetup.router.addLiquidity(
              setup.weth.address,
              setup.wbtc.address,
              ether(100),
              bitcoin(10),
              0,
              0,
              owner.address,
              MAX_UINT_256
            );

            await sushiswapSetup.router.addLiquidity(
              setup.weth.address,
              setup.wbtc.address,
              ether(100),
              bitcoin(10),
              0,
              0,
              owner.address,
              MAX_UINT_256
            );

            await uniswapSetup.router.addLiquidity(
              setup.wbtc.address,
              setup.dai.address,
              bitcoin(10),
              ether(1000),
              0,
              0,
              owner.address,
              MAX_UINT_256
            );

            await sushiswapSetup.router.addLiquidity(
              setup.wbtc.address,
              setup.dai.address,
              bitcoin(10),
              ether(1000),
              0,
              0,
              owner.address,
              MAX_UINT_256
            );
          });

          it("should split the trade equally between Uniswap and Sushiswap", async () => {
            const uniPool = await uniswapSetup.factory.getPair(setup.dai.address, setup.wbtc.address);
            const sushiPool = await sushiswapSetup.factory.getPair(setup.dai.address, setup.wbtc.address);

            const initUniDai = await setup.dai.balanceOf(uniPool);
            const initSushiDai = await setup.dai.balanceOf(sushiPool);

            await subject();

            const finalUniDai = await setup.dai.balanceOf(uniPool);
            const finalSushiDai = await setup.dai.balanceOf(sushiPool);

            expect(initUniDai.sub(finalUniDai)).to.eq(subjectAmountOut.div(2));
            expect(initSushiDai.sub(finalSushiDai)).to.eq(subjectAmountOut.div(2));
          });

          it("should spend the correct input amount", async () => {

            const expectedUniInput = (await uniswapSetup.router.getAmountsIn(subjectAmountOut.div(2), subjectPath))[0];
            const expectedSushiInput = (await sushiswapSetup.router.getAmountsIn(subjectAmountOut.div(2), subjectPath))[0];
            const expectedTotalInput = expectedUniInput.add(expectedSushiInput);

            const initTraderWeth = await setup.weth.balanceOf(subjectCaller.address);

            await subject();

            const finalTraderWeth = await setup.weth.balanceOf(subjectCaller.address);

            expect(initTraderWeth.sub(finalTraderWeth)).to.eq(expectedTotalInput);
          });
        });
      });
    });

    context("when the path is too long", async () => {

      beforeEach(() => {
        subjectPath = [ setup.weth.address, setup.wbtc.address, setup.dai.address, setup.usdc.address ];
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("AMMSplitter: incorrect path length");
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
        await expect(subject()).to.be.revertedWith("AMMSplitter: INSUFFICIENT_INPUT_AMOUNT");
      });
    });
  });

  describe("#getAmountsOut", async () => {

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

    async function subject(): Promise<BigNumber[]> {
      return await splitter.getAmountsOut(
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

        expect(quote[subjectPath.length - 1]).to.eq(finalTraderDai.sub(initTraderDai));
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

        expect(quote[subjectPath.length - 1]).to.eq(finalTraderDai.sub(initTraderDai));
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

        expect(quote[subjectPath.length - 1]).to.eq(finalTraderDai.sub(initTraderDai));
      });
    });

    context("when the path is too long", async () => {

      beforeEach(() => {
        subjectPath = [ setup.weth.address, setup.wbtc.address, setup.dai.address, setup.usdc.address ];
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("AMMSplitter: incorrect path length");
      });
    });
  });

  describe("#getAmountsIn", async () => {

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

    async function subject(): Promise<BigNumber[]> {
      return await splitter.getAmountsIn(
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

        const initCallerWeth = await setup.weth.balanceOf(trader.address);
        await splitter.connect(trader.wallet).swapTokensForExactTokens(
          subjectAmountOut,
          MAX_UINT_256,
          subjectPath,
          trader.address,
          MAX_UINT_256
        );
        const finalCallerWeth = await setup.weth.balanceOf(trader.address);

        expect(quote[0]).to.eq(initCallerWeth.sub(finalCallerWeth));
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

        const initCallerWeth = await setup.weth.balanceOf(trader.address);
        await splitter.connect(trader.wallet).swapTokensForExactTokens(
          subjectAmountOut,
          MAX_UINT_256,
          subjectPath,
          trader.address,
          MAX_UINT_256
        );
        const finalCallerWeth = await setup.weth.balanceOf(trader.address);

        expect(quote[0]).to.eq(initCallerWeth.sub(finalCallerWeth));
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

        const initCallerWeth = await setup.weth.balanceOf(trader.address);
        await splitter.connect(trader.wallet).swapTokensForExactTokens(
          subjectAmountOut,
          MAX_UINT_256,
          subjectPath,
          trader.address,
          MAX_UINT_256
        );
        const finalCallerWeth = await setup.weth.balanceOf(trader.address);

        expect(quote[0]).to.eq(initCallerWeth.sub(finalCallerWeth));
      });
    });

    context("when the path is too long", async () => {

      beforeEach(() => {
        subjectPath = [ setup.weth.address, setup.wbtc.address, setup.dai.address, setup.usdc.address ];
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("AMMSplitter: incorrect path length");
      });
    });
  });
});