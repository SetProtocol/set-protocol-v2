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
import { UniSushiSplitter } from "@typechain/UniSushiSplitter";
import { UniswapV2Router02 } from "@typechain/UniswapV2Router02";
import { Address } from "@utils/types";
import { ether } from "@utils/common";
import { BigNumber, ContractTransaction } from "ethers";
import { MAX_UINT_256 } from "@utils/constants";

const expect = getWaffleExpect();

describe("UniSushiSplitter", async () => {

  let owner: Account;
  let trader: Account;
  let deployer: DeployHelper;

  let splitter: UniSushiSplitter;

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

    splitter = await deployer.adapters.deployUniSushiSplitter(uniswapSetup.router.address, sushiswapSetup.router.address);
  });

  addSnapshotBeforeRestoreAfterEach();

  describe("#constructor", async () => {

    let subjectUniswapRouter: UniswapV2Router02;
    let subjectSushiswapRouter: UniswapV2Router02;

    beforeEach(() => {
      subjectUniswapRouter = uniswapSetup.router;
      subjectSushiswapRouter = sushiswapSetup.router;
    });

    async function subject(): Promise<UniSushiSplitter> {
      return deployer.adapters.deployUniSushiSplitter(subjectUniswapRouter.address, subjectSushiswapRouter.address);
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

  });
});