import "module-alias/register";

import { BigNumber } from "@ethersproject/bignumber";

import { Address } from "@utils/types";
import { Account } from "@utils/test/types";
import {
  MAX_UINT_256,
  ADDRESS_ZERO,
  ZERO,
} from "@utils/constants";
import { SetToken, AmmModule, UniswapV2AmmAdapter } from "@utils/contracts";
import DeployHelper from "@utils/deploys";
import {
  ether
} from "@utils/index";
import {
  addSnapshotBeforeRestoreAfterEach,
  getAccounts,
  getSystemFixture,
  getUniswapFixture,
  getUniswapV3Fixture,
  getWaffleExpect
} from "@utils/test/index";

import { SystemFixture, UniswapFixture } from "@utils/fixtures";

const expect = getWaffleExpect();

describe("UniswapV2AmmAdapter", () => {
  let owner: Account;
  let deployer: DeployHelper;
  let setup: SystemFixture;
  let uniswapSetup: UniswapFixture;
  let ammModule: AmmModule;

  let uniswapV2AmmAdapter: UniswapV2AmmAdapter;
  let uniswapV2AmmAdapterName: string;

  before(async () => {
    [
      owner,
    ] = await getAccounts();

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
    await setup.weth.connect(owner.wallet)
      .approve(uniswapSetup.router.address, MAX_UINT_256);
    await setup.dai.connect(owner.wallet)
      .approve(uniswapSetup.router.address, MAX_UINT_256);
    await uniswapSetup.router.connect(owner.wallet).addLiquidity(
      setup.weth.address,
      setup.dai.address,
      ether(200),
      ether(600000),
      ether(0),
      ether(0),
      owner.address,
      MAX_UINT_256
    );

    ammModule = await deployer.modules.deployAmmModule(setup.controller.address);
    await setup.controller.addModule(ammModule.address);

    uniswapV2AmmAdapter = await deployer.adapters.deployUniswapV2AmmAdapter(uniswapSetup.router.address);
    uniswapV2AmmAdapterName = "UNISWAPV2AMM";

    await setup.integrationRegistry.addIntegration(
      ammModule.address,
      uniswapV2AmmAdapterName,
      uniswapV2AmmAdapter.address
    );
  });

  addSnapshotBeforeRestoreAfterEach();

  describe("constructor", async () => {
    async function subject(): Promise<any> {
      return await uniswapV2AmmAdapter.router();
    }

    it("should have the correct router address", async () => {
      const actualRouterAddress = await subject();
      expect(actualRouterAddress).to.eq(uniswapSetup.router.address);
    });
  });

  describe("getSpenderAddress", async () => {
    let spenderAddress: Address;

    before(async () => {
      spenderAddress = uniswapSetup.wethDaiPool.address;
    });

    async function subject(): Promise<any> {
      return await uniswapV2AmmAdapter.getSpenderAddress(spenderAddress);
    }

    it("should return the correct spender address", async () => {
      const spender = await subject();
      expect(spender).to.eq(uniswapV2AmmAdapter.address);
    });

    describe("when the pool address is invalid", async () => {
      before(async () => {
          const uniswapV3Setup = getUniswapV3Fixture(owner.address);
          await uniswapV3Setup.initialize(owner, setup.weth, 3000.0, setup.wbtc, 40000.0, setup.dai);
          spenderAddress = uniswapV3Setup.swapRouter.address;
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("_pool factory doesn't match the router factory");
      });
    });
  });

  describe("isValidPool", async () => {
    let poolAddress: Address;

    before(async () => {
        poolAddress = uniswapSetup.wethDaiPool.address;
    });

    async function subject(): Promise<any> {
      return await uniswapV2AmmAdapter.isValidPool(poolAddress);
    }

    it("should be a valid pool", async () => {
      const status = await subject();
      expect(status).to.be.true;
    });

    describe("when the pool address is invalid", async () => {
        before(async () => {
            poolAddress = uniswapSetup.router.address;
        });

        it("should be an invalid pool", async () => {
          const status = await subject();
          expect(status).to.be.false;
        });
    });

  });

  describe("getProvideLiquiditySingleAssetCalldata", async () => {
    let subjectAmmPool: Address;
    let subjectComponent: Address;
    let subjectMaxTokenIn: BigNumber;
    let subjectMinLiquidity: BigNumber;

    before(async () => {
      subjectAmmPool = uniswapSetup.wethDaiPool.address;
      subjectComponent = setup.weth.address;
      subjectMaxTokenIn = ether(1);
      subjectMinLiquidity = ether(1);
    });

    async function subject(): Promise<any> {
      return await uniswapV2AmmAdapter.getProvideLiquiditySingleAssetCalldata(
        subjectAmmPool,
        subjectComponent,
        subjectMaxTokenIn,
        subjectMinLiquidity);
    }

    it("should return the correct provide liquidity single asset calldata", async () => {
      const calldata = await subject();

      const expectedCallData = uniswapV2AmmAdapter.interface.encodeFunctionData("addLiquiditySingleAsset", [
        subjectAmmPool,
        subjectComponent,
        subjectMaxTokenIn,
        subjectMinLiquidity,
      ]);
      expect(JSON.stringify(calldata)).to.eq(JSON.stringify([uniswapV2AmmAdapter.address, ZERO, expectedCallData]));
    });
  });

  describe("getRemoveLiquiditySingleAssetCalldata", async () => {
    let subjectAmmPool: Address;
    let subjectComponent: Address;
    let subjectMinTokenOut: BigNumber;
    let subjectLiquidity: BigNumber;

    before(async () => {
      subjectAmmPool = uniswapSetup.wethDaiPool.address;
      subjectComponent = setup.weth.address;
      subjectMinTokenOut = ether(1);
      subjectLiquidity = ether(1);
    });

    async function subject(): Promise<any> {
      return await uniswapV2AmmAdapter.getRemoveLiquiditySingleAssetCalldata(
        uniswapSetup.wethDaiPool.address,
        setup.weth.address,
        subjectMinTokenOut,
        subjectLiquidity);
    }

    it("should return the correct remove liquidity single asset calldata", async () => {
      const calldata = await subject();

      const expectedCallData = uniswapV2AmmAdapter.interface.encodeFunctionData("removeLiquiditySingleAsset", [
        subjectAmmPool,
        subjectComponent,
        subjectMinTokenOut,
        subjectLiquidity,
      ]);
      expect(JSON.stringify(calldata)).to.eq(JSON.stringify([uniswapV2AmmAdapter.address, ZERO, expectedCallData]));
    });
  });

  describe("getProvideLiquidityCalldata", async () => {
    let subjectAmmPool: Address;
    let subjectComponents: Address[];
    let subjectMaxTokensIn: BigNumber[];
    let subjectMinLiquidity: BigNumber;

    before(async () => {
      subjectAmmPool = uniswapSetup.wethDaiPool.address;
      subjectComponents = [setup.weth.address, setup.dai.address];
      subjectMaxTokensIn = [ether(1), ether(3000)];
      subjectMinLiquidity = ether(1);
    });

    async function subject(): Promise<any> {
        return await uniswapV2AmmAdapter.getProvideLiquidityCalldata(
          subjectAmmPool,
          subjectComponents,
          subjectMaxTokensIn,
          subjectMinLiquidity);
    }

    it("should return the correct provide liquidity calldata", async () => {
        const calldata = await subject();

        const expectedCallData = uniswapV2AmmAdapter.interface.encodeFunctionData("addLiquidity", [
          subjectAmmPool,
          subjectComponents,
          subjectMaxTokensIn,
          subjectMinLiquidity,
        ]);
        expect(JSON.stringify(calldata)).to.eq(JSON.stringify([uniswapV2AmmAdapter.address, ZERO, expectedCallData]));
      });
  });

  describe("addLiquidity", async () => {
    let subjectAmmPool: Address;
    let subjectComponents: Address[];
    let subjectMaxTokensIn: BigNumber[];
    let subjectMinLiquidity: BigNumber;

    beforeEach(async () => {
      subjectAmmPool = uniswapSetup.wethDaiPool.address;
      subjectComponents = [setup.weth.address, setup.dai.address];
      subjectMaxTokensIn = [ether(1), ether(3000)];
      const totalSupply = await uniswapSetup.wethDaiPool.totalSupply();
      const [reserve0, reserve1, ] = await uniswapSetup.wethDaiPool.getReserves();
      const token0 = await uniswapSetup.wethDaiPool.token0();
      if ( token0 == setup.weth.address ) {
        const liquidity0 = subjectMaxTokensIn[0].mul(totalSupply).div(reserve0);
        const liquidity1 = subjectMaxTokensIn[1].mul(totalSupply).div(reserve1);
        subjectMinLiquidity = liquidity0.lt(liquidity1) ? liquidity0 : liquidity1;
      }
      else {
        const liquidity0 = subjectMaxTokensIn[1].mul(totalSupply).div(reserve0);
        const liquidity1 = subjectMaxTokensIn[0].mul(totalSupply).div(reserve1);
        subjectMinLiquidity = liquidity0.lt(liquidity1) ? liquidity0 : liquidity1;
      }
      await setup.weth.connect(owner.wallet)
        .approve(uniswapV2AmmAdapter.address, MAX_UINT_256);
      await setup.dai.connect(owner.wallet)
        .approve(uniswapV2AmmAdapter.address, MAX_UINT_256);
    });

    async function subject(): Promise<any> {
      return await uniswapV2AmmAdapter.addLiquidity(
        subjectAmmPool,
        subjectComponents,
        subjectMaxTokensIn,
        subjectMinLiquidity);
    }

    it("should add the correct liquidity", async () => {
        const totalSupply = await uniswapSetup.wethDaiPool.totalSupply();
        const [reserve0, reserve1, ] = await uniswapSetup.wethDaiPool.getReserves();
        await subject();
        const updatedTotalSupply = await uniswapSetup.wethDaiPool.totalSupply();
        const [updatedReserve0, updatedReserve1, ] = await uniswapSetup.wethDaiPool.getReserves();
        expect(updatedTotalSupply).to.eq(totalSupply.add(subjectMinLiquidity));
        const token0 = await uniswapSetup.wethDaiPool.token0();
        if ( token0 == setup.weth.address ) {
          expect(updatedReserve0).to.eq(reserve0.add(subjectMaxTokensIn[0]));
          expect(updatedReserve1).to.eq(reserve1.add(subjectMaxTokensIn[1]));
        }
        else {
          expect(updatedReserve0).to.eq(reserve0.add(subjectMaxTokensIn[1]));
          expect(updatedReserve1).to.eq(reserve1.add(subjectMaxTokensIn[0]));
        }
        const wethBalance = await setup.weth.balanceOf(uniswapV2AmmAdapter.address);
        const daiBalance = await setup.dai.balanceOf(uniswapV2AmmAdapter.address);
        const lpBalance = await uniswapSetup.wethDaiPool.balanceOf(uniswapV2AmmAdapter.address);
        expect(wethBalance).to.eq(ZERO);
        expect(daiBalance).to.eq(ZERO);
        expect(lpBalance).to.eq(ZERO);
    });

    describe("when the pool address is invalid", async () => {
      beforeEach(async () => {
        const uniswapV3Setup = getUniswapV3Fixture(owner.address);
        await uniswapV3Setup.initialize(owner, setup.weth, 3000.0, setup.wbtc, 40000.0, setup.dai);
        subjectAmmPool = uniswapV3Setup.swapRouter.address;
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("_pool factory doesn't match the router factory");
      });
    });

    describe("when the _components length is invalid", async () => {
      beforeEach(async () => {
        subjectComponents = [setup.weth.address];
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("_components length is invalid");
      });
    });

    describe("when the _maxTokensIn length is invalid", async () => {
      beforeEach(async () => {
        subjectMaxTokensIn = [ether(1)];
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("_maxTokensIn length is invalid");
      });
    });

    describe("when the _pool doesn't match the _components", async () => {
      beforeEach(async () => {
        subjectComponents = [setup.weth.address, setup.wbtc.address];
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("_pool doesn't match the components");
      });
    });

    describe("when the _maxTokensIn[0] is 0", async () => {
      beforeEach(async () => {
        subjectMaxTokensIn = [ether(0), ether(3000)];
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("supplied token0 must be greater than 0");
      });
    });

    describe("when the _maxTokensIn[1] is 0", async () => {
      beforeEach(async () => {
        subjectMaxTokensIn = [ether(1), ether(0)];
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("supplied token1 must be greater than 0");
      });
    });

    describe("when the _pool totalSupply is 0", async () => {
      beforeEach(async () => {
        subjectAmmPool = uniswapSetup.wethWbtcPool.address;
        subjectComponents = [setup.weth.address, setup.wbtc.address];
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("_pool totalSupply must be > 0");
      });
    });

    describe("when the _minLiquidity is 0", async () => {
      beforeEach(async () => {
        subjectMinLiquidity = ZERO;
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("_minLiquidity must be greater than 0");
      });
    });

    describe("when the _minLiquidity is too high", async () => {
      beforeEach(async () => {
        subjectMinLiquidity = subjectMinLiquidity.mul(2);
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("_minLiquidity is too high for amount maximums");
      });
    });
  });

  describe("addLiquiditySingleAsset", async () => {
    let subjectAmmPool: Address;
    let subjectComponent: Address;
    let subjectMaxTokenIn: BigNumber;
    let subjectMinLiquidity: BigNumber;
    let tokensAdded: BigNumber;

    beforeEach(async () => {
      subjectAmmPool = uniswapSetup.wethDaiPool.address;
      subjectComponent = setup.weth.address;
      subjectMaxTokenIn = ether(1);
      const amountToSwap = subjectMaxTokenIn.div(2);
      const [reserve0, reserve1, ] = await uniswapSetup.wethDaiPool.getReserves();
      const totalSupply = await uniswapSetup.wethDaiPool.totalSupply();
      const token0 = await uniswapSetup.wethDaiPool.token0();
      if ( token0 == setup.weth.address ) {
        const amountOut = await uniswapSetup.router.getAmountOut(amountToSwap, reserve0, reserve1);
        const quote = await uniswapSetup.router.quote(amountOut, reserve1.sub(amountOut), reserve0.add(amountToSwap));
        tokensAdded = amountToSwap.add(quote);
        const liquidity0 = quote.mul(totalSupply).div(reserve0.add(amountToSwap));
        const liquidity1 = amountOut.mul(totalSupply).div(reserve1.sub(amountOut));
        subjectMinLiquidity = liquidity0.lt(liquidity1) ? liquidity0 : liquidity1;
      }
      else {
        const amountOut = await uniswapSetup.router.getAmountOut(amountToSwap, reserve1, reserve0);
        const quote = await uniswapSetup.router.quote(amountOut, reserve0.sub(amountOut), reserve1.add(amountToSwap));
        tokensAdded = amountToSwap.add(quote);
        const liquidity0 = amountOut.mul(totalSupply).div(reserve0.sub(amountOut));
        const liquidity1 = quote.mul(totalSupply).div(reserve1.add(amountToSwap));
        subjectMinLiquidity = liquidity0.lt(liquidity1) ? liquidity0 : liquidity1;
      }
      await setup.weth.connect(owner.wallet)
        .approve(uniswapV2AmmAdapter.address, MAX_UINT_256);
    });

    async function subject(): Promise<any> {
      return await uniswapV2AmmAdapter.addLiquiditySingleAsset(
        subjectAmmPool,
        subjectComponent,
        subjectMaxTokenIn,
        subjectMinLiquidity);
    }

    it("should add the correct liquidity with weth", async () => {
        const totalSupply = await uniswapSetup.wethDaiPool.totalSupply();
        const [reserve0, reserve1, ] = await uniswapSetup.wethDaiPool.getReserves();
        await subject();
        const updatedTotalSupply = await uniswapSetup.wethDaiPool.totalSupply();
        const [updatedReserve0, updatedReserve1, ] = await uniswapSetup.wethDaiPool.getReserves();
        expect(updatedTotalSupply).to.eq(totalSupply.add(subjectMinLiquidity));
        const token0 = await uniswapSetup.wethDaiPool.token0();
        if ( token0 == setup.weth.address ) {
          expect(updatedReserve0).to.eq(reserve0.add(tokensAdded));
          expect(updatedReserve1).to.eq(reserve1);
        }
        else {
          expect(updatedReserve0).to.eq(reserve0);
          expect(updatedReserve1).to.eq(reserve1.add(tokensAdded));
        }
        const wethBalance = await setup.weth.balanceOf(uniswapV2AmmAdapter.address);
        const daiBalance = await setup.dai.balanceOf(uniswapV2AmmAdapter.address);
        const lpBalance = await uniswapSetup.wethDaiPool.balanceOf(uniswapV2AmmAdapter.address);
        expect(wethBalance).to.eq(ZERO);
        expect(daiBalance).to.eq(ZERO);
        expect(lpBalance).to.eq(ZERO);
    });

    describe("when providing dai", async () => {
      beforeEach(async () => {
        subjectComponent = setup.dai.address;
        const amountToSwap = subjectMaxTokenIn.div(2);
        const [reserve0, reserve1, ] = await uniswapSetup.wethDaiPool.getReserves();
        const totalSupply = await uniswapSetup.wethDaiPool.totalSupply();
        const token0 = await uniswapSetup.wethDaiPool.token0();
        if ( token0 == setup.dai.address ) {
          const amountOut = await uniswapSetup.router.getAmountOut(amountToSwap, reserve0, reserve1);
          const quote = await uniswapSetup.router.quote(amountOut, reserve1.sub(amountOut), reserve0.add(amountToSwap));
          tokensAdded = amountToSwap.add(quote);
          const liquidity0 = quote.mul(totalSupply).div(reserve0.add(amountToSwap));
          const liquidity1 = amountOut.mul(totalSupply).div(reserve1.sub(amountOut));
          subjectMinLiquidity = liquidity0.lt(liquidity1) ? liquidity0 : liquidity1;
        }
        else {
          const amountOut = await uniswapSetup.router.getAmountOut(amountToSwap, reserve1, reserve0);
          const quote = await uniswapSetup.router.quote(amountOut, reserve0.sub(amountOut), reserve1.add(amountToSwap));
          tokensAdded = amountToSwap.add(quote);
          const liquidity0 = amountOut.mul(totalSupply).div(reserve0.sub(amountOut));
          const liquidity1 = quote.mul(totalSupply).div(reserve1.add(amountToSwap));
          subjectMinLiquidity = liquidity0.lt(liquidity1) ? liquidity0 : liquidity1;
        }
        await setup.dai.connect(owner.wallet)
          .approve(uniswapV2AmmAdapter.address, MAX_UINT_256);
      });

      it("should add the correct liquidity", async () => {
        const totalSupply = await uniswapSetup.wethDaiPool.totalSupply();
        const [reserve0, reserve1, ] = await uniswapSetup.wethDaiPool.getReserves();
        await subject();
        const updatedTotalSupply = await uniswapSetup.wethDaiPool.totalSupply();
        const [updatedReserve0, updatedReserve1, ] = await uniswapSetup.wethDaiPool.getReserves();
        expect(updatedTotalSupply).to.eq(totalSupply.add(subjectMinLiquidity));
        const token0 = await uniswapSetup.wethDaiPool.token0();
        if ( token0 == setup.dai.address ) {
          expect(updatedReserve0).to.eq(reserve0.add(tokensAdded));
          expect(updatedReserve1).to.eq(reserve1);
        }
        else {
          expect(updatedReserve0).to.eq(reserve0);
          expect(updatedReserve1).to.eq(reserve1.add(tokensAdded));
        }
        const wethBalance = await setup.weth.balanceOf(uniswapV2AmmAdapter.address);
        const daiBalance = await setup.dai.balanceOf(uniswapV2AmmAdapter.address);
        const lpBalance = await uniswapSetup.wethDaiPool.balanceOf(uniswapV2AmmAdapter.address);
        expect(wethBalance).to.eq(ZERO);
        expect(daiBalance).to.eq(ZERO);
        expect(lpBalance).to.eq(ZERO);
      });
    });

    describe("when the pool address is invalid", async () => {
      beforeEach(async () => {
        const uniswapV3Setup = getUniswapV3Fixture(owner.address);
        await uniswapV3Setup.initialize(owner, setup.weth, 3000.0, setup.wbtc, 40000.0, setup.dai);
        subjectAmmPool = uniswapV3Setup.swapRouter.address;
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("_pool factory doesn't match the router factory");
      });
    });

    describe("when the _pool doesn't match the _component", async () => {
      beforeEach(async () => {
        subjectComponent = setup.wbtc.address;
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("_pool doesn't contain the _component");
      });
    });

    describe("when the _maxTokenIn is 0", async () => {
      beforeEach(async () => {
        subjectMaxTokenIn = ether(0);
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("supplied _maxTokenIn must be greater than 0");
      });
    });

    describe("when the _pool totalSupply is 0", async () => {
      beforeEach(async () => {
        subjectAmmPool = uniswapSetup.wethWbtcPool.address;
        subjectComponent = setup.weth.address;
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("_pool totalSupply must be > 0");
      });
    });

    describe("when the _minLiquidity is 0", async () => {
      beforeEach(async () => {
        subjectMinLiquidity = ZERO;
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("_minLiquidity must be greater than 0");
      });
    });

    describe("when the _minLiquidity is too high", async () => {
      beforeEach(async () => {
        subjectMinLiquidity = subjectMinLiquidity.mul(2);
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("_minLiquidity is too high for amount maximum");
      });
    });
  });

  describe("getRemoveLiquidityCalldata", async () => {
    let subjectAmmPool: Address;
    let subjectComponents: Address[];
    let subjectMinTokensOut: BigNumber[];
    let subjectLiquidity: BigNumber;

    before(async () => {
      subjectAmmPool = uniswapSetup.wethDaiPool.address;
      subjectComponents = [setup.weth.address, setup.dai.address];
      subjectMinTokensOut = [ether(1), ether(3000)];
      subjectLiquidity = ether(1);
    });

    async function subject(): Promise<any> {
        return await uniswapV2AmmAdapter.getRemoveLiquidityCalldata(
            subjectAmmPool,
            subjectComponents,
            subjectMinTokensOut,
            subjectLiquidity);
    }

    it("should return the correct remove liquidity calldata", async () => {
        const calldata = await subject();

        const expectedCallData = uniswapV2AmmAdapter.interface.encodeFunctionData("removeLiquidity", [
          subjectAmmPool,
          subjectComponents,
          subjectMinTokensOut,
          subjectLiquidity,
        ]);
        expect(JSON.stringify(calldata)).to.eq(JSON.stringify([uniswapV2AmmAdapter.address, ZERO, expectedCallData]));
      });
  });

  describe("removeLiquidity", async () => {
    let subjectAmmPool: Address;
    let subjectComponents: Address[];
    let subjectMinTokensOut: BigNumber[];
    let subjectLiquidity: BigNumber;

    beforeEach(async () => {
      subjectAmmPool = uniswapSetup.wethDaiPool.address;
      subjectComponents = [setup.weth.address, setup.dai.address];
      subjectLiquidity = await uniswapSetup.wethDaiPool.balanceOf(owner.address);
      const token0 = await uniswapSetup.wethDaiPool.token0();
      const totalSupply = await uniswapSetup.wethDaiPool.totalSupply();
      const [reserve0, reserve1, ] = await uniswapSetup.wethDaiPool.getReserves();
      if ( token0 == setup.weth.address ) {
        subjectMinTokensOut = [reserve0.mul(subjectLiquidity).div(totalSupply),
          reserve1.mul(subjectLiquidity).div(totalSupply)];
      }
      else {
        subjectMinTokensOut = [reserve1.mul(subjectLiquidity).div(totalSupply),
          reserve0.mul(subjectLiquidity).div(totalSupply)];
      }
      await uniswapSetup.wethDaiPool.connect(owner.wallet)
        .approve(uniswapV2AmmAdapter.address, MAX_UINT_256);
    });

    async function subject(): Promise<any> {
      return await uniswapV2AmmAdapter.removeLiquidity(
        subjectAmmPool,
        subjectComponents,
        subjectMinTokensOut,
        subjectLiquidity);
    }

    it("should remove the correct liquidity", async () => {
        const token0 = await uniswapSetup.wethDaiPool.token0();
        const [reserve0, reserve1, ] = await uniswapSetup.wethDaiPool.getReserves();
        await subject();
        expect(await uniswapSetup.wethDaiPool.balanceOf(owner.address)).to.be.eq(ZERO);
        const [updatedReserve0, updatedReserve1, ] = await uniswapSetup.wethDaiPool.getReserves();
        if ( token0 == setup.weth.address ) {
          expect(updatedReserve0).to.be.eq(reserve0.sub(subjectMinTokensOut[0]));
          expect(updatedReserve1).to.be.eq(reserve1.sub(subjectMinTokensOut[1]));
        }
        else {
          expect(updatedReserve0).to.be.eq(reserve0.sub(subjectMinTokensOut[1]));
          expect(updatedReserve1).to.be.eq(reserve1.sub(subjectMinTokensOut[0]));
        }
        const wethBalance = await setup.weth.balanceOf(uniswapV2AmmAdapter.address);
        const daiBalance = await setup.dai.balanceOf(uniswapV2AmmAdapter.address);
        const lpBalance = await uniswapSetup.wethDaiPool.balanceOf(uniswapV2AmmAdapter.address);
        expect(wethBalance).to.eq(ZERO);
        expect(daiBalance).to.eq(ZERO);
        expect(lpBalance).to.eq(ZERO);
    });

    describe("when the pool address is invalid", async () => {
      beforeEach(async () => {
        const uniswapV3Setup = getUniswapV3Fixture(owner.address);
        await uniswapV3Setup.initialize(owner, setup.weth, 3000.0, setup.wbtc, 40000.0, setup.dai);
        subjectAmmPool = uniswapV3Setup.swapRouter.address;
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("_pool factory doesn't match the router factory");
      });
    });

    describe("when the _components length is invalid", async () => {
      beforeEach(async () => {
        subjectComponents = [setup.weth.address];
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("_components length is invalid");
      });
    });

    describe("when the _minTokensOut length is invalid", async () => {
      beforeEach(async () => {
        subjectMinTokensOut = [ether(1)];
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("_minTokensOut length is invalid");
      });
    });

    describe("when the _pool doesn't match the _components", async () => {
      beforeEach(async () => {
        subjectComponents = [setup.weth.address, setup.wbtc.address];
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("_pool doesn't match the components");
      });
    });

    describe("when the _minTokensOut[0] is 0", async () => {
      beforeEach(async () => {
        subjectMinTokensOut = [ether(0), ether(3000)];
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("requested token0 must be greater than 0");
      });
    });

    describe("when the _minTokensOut[1] is 0", async () => {
      beforeEach(async () => {
        subjectMinTokensOut = [ether(1), ether(0)];
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("requested token1 must be greater than 0");
      });
    });

    describe("when the _liquidity is 0", async () => {
      beforeEach(async () => {
        subjectLiquidity = ZERO;
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("_liquidity must be greater than 0");
      });
    });

    describe("when the _liquidity is more than available", async () => {
      beforeEach(async () => {
        subjectLiquidity = (await uniswapSetup.wethDaiPool.balanceOf(owner.address)).add(ether(1));
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("_liquidity must be <= to current balance");
      });
    });

    describe("when the _minTokensOut is too high", async () => {
      beforeEach(async () => {
        subjectMinTokensOut = [subjectMinTokensOut[0].mul(2), subjectMinTokensOut[1]];
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("amounts must be <= ownedTokens");
      });
    });
  });

  describe("removeLiquiditySingleAsset", async () => {
    let subjectAmmPool: Address;
    let subjectComponent: Address;
    let subjectMinTokenOut: BigNumber;
    let subjectLiquidity: BigNumber;

    beforeEach(async () => {
      subjectAmmPool = uniswapSetup.wethDaiPool.address;
      subjectComponent = setup.weth.address;
      subjectLiquidity = await uniswapSetup.wethDaiPool.balanceOf(owner.address);
      const token0 = await uniswapSetup.wethDaiPool.token0();
      const totalSupply = await uniswapSetup.wethDaiPool.totalSupply();
      const [reserve0, reserve1, ] = await uniswapSetup.wethDaiPool.getReserves();
      const token0Amount = subjectLiquidity.mul(reserve0).div(totalSupply);
      const token1Amount = subjectLiquidity.mul(reserve1).div(totalSupply);
      if ( token0 == setup.weth.address ) {
        const receivedAmount = await uniswapSetup.router.getAmountOut(token1Amount,
          reserve1.sub(token1Amount), reserve0.sub(token0Amount));
        subjectMinTokenOut = token0Amount.add(receivedAmount);
      }
      else {
        const receivedAmount = await uniswapSetup.router.getAmountOut(token0Amount,
          reserve0.sub(token0Amount), reserve1.sub(token1Amount));
        subjectMinTokenOut = token1Amount.add(receivedAmount);
      }
      await uniswapSetup.wethDaiPool.connect(owner.wallet)
        .approve(uniswapV2AmmAdapter.address, MAX_UINT_256);
    });

    async function subject(): Promise<any> {
      return await uniswapV2AmmAdapter.removeLiquiditySingleAsset(
        subjectAmmPool,
        subjectComponent,
        subjectMinTokenOut,
        subjectLiquidity);
    }

    it("should remove the correct liquidity with weth", async () => {
        const token0 = await uniswapSetup.wethDaiPool.token0();
        const [reserve0, reserve1, ] = await uniswapSetup.wethDaiPool.getReserves();
        await subject();
        expect(await uniswapSetup.wethDaiPool.balanceOf(owner.address)).to.be.eq(ZERO);
        const [updatedReserve0, updatedReserve1, ] = await uniswapSetup.wethDaiPool.getReserves();
        if ( token0 == setup.weth.address ) {
          expect(updatedReserve0).to.be.eq(reserve0.sub(subjectMinTokenOut));
          expect(updatedReserve1).to.be.eq(reserve1);
        }
        else {
          expect(updatedReserve0).to.be.eq(reserve0);
          expect(updatedReserve1).to.be.eq(reserve1.sub(subjectMinTokenOut));
        }
        const wethBalance = await setup.weth.balanceOf(uniswapV2AmmAdapter.address);
        const daiBalance = await setup.dai.balanceOf(uniswapV2AmmAdapter.address);
        const lpBalance = await uniswapSetup.wethDaiPool.balanceOf(uniswapV2AmmAdapter.address);
        const ownerLiquidity = await uniswapSetup.wethDaiPool.balanceOf(owner.address);
        expect(wethBalance).to.eq(ZERO);
        expect(daiBalance).to.eq(ZERO);
        expect(lpBalance).to.eq(ZERO);
        expect(ownerLiquidity).to.eq(ZERO);
    });

    describe("when removing dai", async () => {
      beforeEach(async () => {
        subjectComponent = setup.dai.address;
        const token0 = await uniswapSetup.wethDaiPool.token0();
        const totalSupply = await uniswapSetup.wethDaiPool.totalSupply();
        const [reserve0, reserve1, ] = await uniswapSetup.wethDaiPool.getReserves();
        const token0Amount = subjectLiquidity.mul(reserve0).div(totalSupply);
        const token1Amount = subjectLiquidity.mul(reserve1).div(totalSupply);
        if ( token0 == setup.dai.address ) {
          const receivedAmount = await uniswapSetup.router.getAmountOut(token1Amount,
            reserve1.sub(token1Amount), reserve0.sub(token0Amount));
          subjectMinTokenOut = token0Amount.add(receivedAmount);
        }
        else {
          const receivedAmount = await uniswapSetup.router.getAmountOut(token0Amount,
            reserve0.sub(token0Amount), reserve1.sub(token1Amount));
          subjectMinTokenOut = token1Amount.add(receivedAmount);
        }
      });

      it("should remove the correct liquidity", async () => {
        const token0 = await uniswapSetup.wethDaiPool.token0();
        const [reserve0, reserve1, ] = await uniswapSetup.wethDaiPool.getReserves();
        await subject();
        expect(await uniswapSetup.wethDaiPool.balanceOf(owner.address)).to.be.eq(ZERO);
        const [updatedReserve0, updatedReserve1, ] = await uniswapSetup.wethDaiPool.getReserves();
        if ( token0 == setup.dai.address ) {
          expect(updatedReserve0).to.be.eq(reserve0.sub(subjectMinTokenOut));
          expect(updatedReserve1).to.be.eq(reserve1);
        }
        else {
          expect(updatedReserve0).to.be.eq(reserve0);
          expect(updatedReserve1).to.be.eq(reserve1.sub(subjectMinTokenOut));
        }
        const wethBalance = await setup.weth.balanceOf(uniswapV2AmmAdapter.address);
        const daiBalance = await setup.dai.balanceOf(uniswapV2AmmAdapter.address);
        const lpBalance = await uniswapSetup.wethDaiPool.balanceOf(uniswapV2AmmAdapter.address);
        const ownerLiquidity = await uniswapSetup.wethDaiPool.balanceOf(owner.address);
        expect(wethBalance).to.eq(ZERO);
        expect(daiBalance).to.eq(ZERO);
        expect(lpBalance).to.eq(ZERO);
        expect(ownerLiquidity).to.eq(ZERO);
      });
    });

    describe("when the pool address is invalid", async () => {
      beforeEach(async () => {
        const uniswapV3Setup = getUniswapV3Fixture(owner.address);
        await uniswapV3Setup.initialize(owner, setup.weth, 3000.0, setup.wbtc, 40000.0, setup.dai);
        subjectAmmPool = uniswapV3Setup.swapRouter.address;
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("_pool factory doesn't match the router factory");
      });
    });

    describe("when the _pool doesn't contain the _component", async () => {
      beforeEach(async () => {
        subjectComponent = setup.wbtc.address;
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("_pool doesn't contain the _component");
      });
    });

    describe("when the _minTokenOut is 0", async () => {
      beforeEach(async () => {
        subjectMinTokenOut = ether(0);
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("requested token must be greater than 0");
      });
    });

    describe("when the _liquidity is 0", async () => {
      beforeEach(async () => {
        subjectLiquidity = ZERO;
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("_liquidity must be greater than 0");
      });
    });

    describe("when the _liquidity is more than available", async () => {
      beforeEach(async () => {
        subjectLiquidity = (await uniswapSetup.wethDaiPool.balanceOf(owner.address)).add(ether(1));
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("_liquidity must be <= to current balance");
      });
    });

    describe("when the _minTokenOut is too high", async () => {
      beforeEach(async () => {
        subjectMinTokenOut = subjectMinTokenOut.mul(2);
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("_minTokenOut is too high for amount received");
      });
    });
  });

  context("Add and Remove Liquidity Tests", async () => {
    let subjectCaller: Account;
    let subjectSetToken: Address;
    let subjectIntegrationName: string;
    let subjectAmmPool: Address;

    let setToken: SetToken;

    context("when there is a deployed SetToken with enabled AmmModule", async () => {
      beforeEach(async () => {
        // Deploy a standard SetToken with the AMM Module
        setToken = await setup.createSetToken(
          [setup.weth.address, setup.dai.address],
          [ether(1), ether(3000)],
          [setup.issuanceModule.address, ammModule.address]
        );

        await setup.issuanceModule.initialize(setToken.address, ADDRESS_ZERO);
        await ammModule.initialize(setToken.address);

        // Mint some instances of the SetToken
        await setup.approveAndIssueSetToken(setToken, ether(1));
      });

      describe("#addLiquidity", async () => {
        let subjectComponentsToInput: Address[];
        let subjectMaxComponentQuantities: BigNumber[];
        let subjectMinPoolTokensToMint: BigNumber;

        beforeEach(async () => {
          subjectSetToken = setToken.address;
          subjectIntegrationName = uniswapV2AmmAdapterName;
          subjectAmmPool = uniswapSetup.wethDaiPool.address;
          subjectComponentsToInput = [setup.weth.address, setup.dai.address];
          subjectMaxComponentQuantities = [ether(1), ether(3000)];
          subjectCaller = owner;
          const totalSupply = await uniswapSetup.wethDaiPool.totalSupply();
          const [reserve0, reserve1, ] = await uniswapSetup.wethDaiPool.getReserves();
          const token0 = await uniswapSetup.wethDaiPool.token0();
          if ( token0 == setup.weth.address ) {
            const liquidity0 = ether(1).mul(totalSupply).div(reserve0);
            const liquidity1 = ether(3000).mul(totalSupply).div(reserve1);
            subjectMinPoolTokensToMint = liquidity0.lt(liquidity1) ? liquidity0 : liquidity1;
          }
          else {
            const liquidity0 = ether(3000).mul(totalSupply).div(reserve0);
            const liquidity1 = ether(1).mul(totalSupply).div(reserve1);
            subjectMinPoolTokensToMint = liquidity0.lt(liquidity1) ? liquidity0 : liquidity1;
          }
        });

        async function subject(): Promise<any> {
          return await ammModule.connect(subjectCaller.wallet).addLiquidity(
            subjectSetToken,
            subjectIntegrationName,
            subjectAmmPool,
            subjectMinPoolTokensToMint,
            subjectComponentsToInput,
            subjectMaxComponentQuantities,
          );
        }

        it("should mint the liquidity token to the caller", async () => {
          await subject();
          const liquidityTokenBalance = await uniswapSetup.wethDaiPool.balanceOf(subjectSetToken);
          expect(liquidityTokenBalance).to.eq(subjectMinPoolTokensToMint);
        });

        it("should update the positions properly", async () => {
          await subject();
          const positions = await setToken.getPositions();
          expect(positions.length).to.eq(1);
          expect(positions[0].component).to.eq(subjectAmmPool);
          expect(positions[0].unit).to.eq(subjectMinPoolTokensToMint);
        });

        describe("when insufficient liquidity tokens are received", async () => {
          beforeEach(async () => {
            subjectMinPoolTokensToMint = subjectMinPoolTokensToMint.mul(2);
          });

          it("should revert", async () => {
            await expect(subject()).to.be.revertedWith("_minLiquidity is too high for amount maximums");
          });
        });

        describe("when extra dai tokens are supplied", async () => {
          let wethRemaining: BigNumber;
          let daiRemaining: BigNumber;
          beforeEach(async () => {
            wethRemaining = ether(0.5);
            subjectMaxComponentQuantities = [ether(0.5), ether(1600)];
            const totalSupply = await uniswapSetup.wethDaiPool.totalSupply();
            const [reserve0, reserve1, ] = await uniswapSetup.wethDaiPool.getReserves();
            const token0 = await uniswapSetup.wethDaiPool.token0();
            if ( token0 == setup.weth.address ) {
              const liquidity0 = ether(0.5).mul(totalSupply).div(reserve0);
              const liquidity1 = ether(1600).mul(totalSupply).div(reserve1);
              subjectMinPoolTokensToMint = liquidity0.lt(liquidity1) ? liquidity0 : liquidity1;
              daiRemaining = ether(3000).sub(ether(0.5).mul(reserve1).div(reserve0));
            }
            else {
              const liquidity0 = ether(1600).mul(totalSupply).div(reserve0);
              const liquidity1 = ether(0.5).mul(totalSupply).div(reserve1);
              subjectMinPoolTokensToMint = liquidity0.lt(liquidity1) ? liquidity0 : liquidity1;
              daiRemaining = ether(3000).sub(ether(0.5).mul(reserve0).div(reserve1));
            }

          });

          it("should mint the correct amount of liquidity tokens to the caller", async () => {
            await subject();
            const liquidityTokenBalance = await uniswapSetup.wethDaiPool.balanceOf(subjectSetToken);
            expect(liquidityTokenBalance).to.eq(subjectMinPoolTokensToMint);
          });

          it("should have the expected weth, dai, and lp tokens", async () => {
            await subject();
            const positions = await setToken.getPositions();
            expect(positions.length).to.eq(3);
            expect(positions[0].component).to.eq(setup.weth.address);
            expect(positions[0].unit).to.eq(wethRemaining);
            expect(positions[1].component).to.eq(setup.dai.address);
            expect(positions[1].unit).to.eq(daiRemaining);
            expect(positions[2].component).to.eq(subjectAmmPool);
            expect(positions[2].unit).to.eq(subjectMinPoolTokensToMint);
          });
        });

        describe("when extra weth tokens are supplied", async () => {
          let wethRemaining: BigNumber;
          let daiRemaining: BigNumber;
          beforeEach(async () => {
            daiRemaining = ether(1500);
            subjectMaxComponentQuantities = [ether(0.6), ether(1500)];
            const totalSupply = await uniswapSetup.wethDaiPool.totalSupply();
            const [reserve0, reserve1, ] = await uniswapSetup.wethDaiPool.getReserves();
            const token0 = await uniswapSetup.wethDaiPool.token0();
            if ( token0 == setup.weth.address ) {
              const liquidity0 = ether(0.6).mul(totalSupply).div(reserve0);
              const liquidity1 = ether(1500).mul(totalSupply).div(reserve1);
              subjectMinPoolTokensToMint = liquidity0.lt(liquidity1) ? liquidity0 : liquidity1;
              wethRemaining = ether(1).sub(ether(1500).mul(reserve0).div(reserve1));
            }
            else {
              const liquidity0 = ether(1500).mul(totalSupply).div(reserve0);
              const liquidity1 = ether(0.6).mul(totalSupply).div(reserve1);
              subjectMinPoolTokensToMint = liquidity0.lt(liquidity1) ? liquidity0 : liquidity1;
              wethRemaining = ether(1).sub(ether(1500).mul(reserve1).div(reserve0));
            }

          });

          it("should mint the correct amount of liquidity tokens to the caller", async () => {
            await subject();
            const liquidityTokenBalance = await uniswapSetup.wethDaiPool.balanceOf(subjectSetToken);
            expect(liquidityTokenBalance).to.eq(subjectMinPoolTokensToMint);
          });

          it("should have the expected weth, dai, and lp tokens", async () => {
            await subject();
            const positions = await setToken.getPositions();
            expect(positions.length).to.eq(3);
            expect(positions[0].component).to.eq(setup.weth.address);
            expect(positions[0].unit).to.eq(wethRemaining);
            expect(positions[1].component).to.eq(setup.dai.address);
            expect(positions[1].unit).to.eq(daiRemaining);
            expect(positions[2].component).to.eq(subjectAmmPool);
            expect(positions[2].unit).to.eq(subjectMinPoolTokensToMint);
          });
        });

        shouldRevertIfPoolIsNotSupported(subject);
      });

    });

    context("when there is a deployed SetToken with enabled AmmModule", async () => {
      beforeEach(async () => {
        // Deploy a standard SetToken with the AMM Module
        setToken = await setup.createSetToken(
          [setup.weth.address],
          [ether(1)],
          [setup.issuanceModule.address, ammModule.address]
        );

        await setup.issuanceModule.initialize(setToken.address, ADDRESS_ZERO);
        await ammModule.initialize(setToken.address);

        // Mint some instances of the SetToken
        await setup.approveAndIssueSetToken(setToken, ether(1));
      });

      describe("#addLiquiditySingleAsset", async () => {
        let subjectComponentToInput: Address;
        let subjectMaxComponentQuantity: BigNumber;
        let subjectMinPoolTokensToMint: BigNumber;
        let tokensAdded: BigNumber;

        beforeEach(async () => {
          subjectSetToken = setToken.address;
          subjectIntegrationName = uniswapV2AmmAdapterName;
          subjectAmmPool = uniswapSetup.wethDaiPool.address;
          subjectComponentToInput = setup.weth.address;
          subjectMaxComponentQuantity = ether(1);
          subjectCaller = owner;
          const amountToSwap = subjectMaxComponentQuantity.div(2);
          const [reserve0, reserve1, ] = await uniswapSetup.wethDaiPool.getReserves();
          const totalSupply = await uniswapSetup.wethDaiPool.totalSupply();
          const token0 = await uniswapSetup.wethDaiPool.token0();
          if ( token0 == setup.weth.address ) {
            const amountOut = await uniswapSetup.router.getAmountOut(amountToSwap, reserve0, reserve1);
            const quote = await uniswapSetup.router.quote(amountOut, reserve1.sub(amountOut), reserve0.add(amountToSwap));
            tokensAdded = amountToSwap.add(quote);
            const liquidity0 = quote.mul(totalSupply).div(reserve0.add(amountToSwap));
            const liquidity1 = amountOut.mul(totalSupply).div(reserve1.sub(amountOut));
            subjectMinPoolTokensToMint = liquidity0.lt(liquidity1) ? liquidity0 : liquidity1;
          }
          else {
            const amountOut = await uniswapSetup.router.getAmountOut(amountToSwap, reserve1, reserve0);
            const quote = await uniswapSetup.router.quote(amountOut, reserve0.sub(amountOut), reserve1.add(amountToSwap));
            tokensAdded = amountToSwap.add(quote);
            const liquidity0 = amountOut.mul(totalSupply).div(reserve0.sub(amountOut));
            const liquidity1 = quote.mul(totalSupply).div(reserve1.add(amountToSwap));
            subjectMinPoolTokensToMint = liquidity0.lt(liquidity1) ? liquidity0 : liquidity1;
          }
        });

        async function subject(): Promise<any> {
          return await ammModule.connect(subjectCaller.wallet).addLiquiditySingleAsset(
            subjectSetToken,
            subjectIntegrationName,
            subjectAmmPool,
            subjectMinPoolTokensToMint,
            subjectComponentToInput,
            subjectMaxComponentQuantity,
          );
        }

        it("should mint the liquidity token to the caller", async () => {
          await subject();
          const liquidityTokenBalance = await uniswapSetup.wethDaiPool.balanceOf(subjectSetToken);
          expect(liquidityTokenBalance).to.eq(subjectMinPoolTokensToMint);
        });

        it("should update the positions properly", async () => {
          await subject();
          const positions = await setToken.getPositions();
          expect(positions.length).to.eq(2);
          expect(positions[0].component).to.eq(setup.weth.address);
          expect(positions[0].unit).to.eq(subjectMaxComponentQuantity.sub(tokensAdded));
          expect(positions[1].component).to.eq(subjectAmmPool);
          expect(positions[1].unit).to.eq(subjectMinPoolTokensToMint);
        });

      });

    });

    context("when there is a deployed SetToken with enabled AmmModule", async () => {
      before(async () => {
        // Deploy a standard SetToken with the AMM Module
        setToken = await setup.createSetToken(
          [uniswapSetup.wethDaiPool.address],
          [ether(1)],
          [setup.issuanceModule.address, ammModule.address]
        );

        await setup.issuanceModule.initialize(setToken.address, ADDRESS_ZERO);
        await ammModule.initialize(setToken.address);

        // Mint some instances of the SetToken
        await setup.approveAndIssueSetToken(setToken, ether(1));
      });

      describe("#removeLiquidity", async () => {
        let subjectComponentsToOutput: Address[];
        let subjectMinComponentQuantities: BigNumber[];
        let subjectPoolTokens: BigNumber;

        beforeEach(async () => {
          subjectSetToken = setToken.address;
          subjectIntegrationName = uniswapV2AmmAdapterName;
          subjectAmmPool = uniswapSetup.wethDaiPool.address;
          subjectComponentsToOutput = [setup.weth.address, setup.dai.address];
          const totalSupply = await uniswapSetup.wethDaiPool.totalSupply();
          const [reserve0, reserve1, ] = await uniswapSetup.wethDaiPool.getReserves();
          subjectPoolTokens = ether(1);
          const token0 = await uniswapSetup.wethDaiPool.token0();
          if ( token0 == setup.weth.address ) {
            const weth = subjectPoolTokens.mul(reserve0).div(totalSupply);
            const dai = subjectPoolTokens.mul(reserve1).div(totalSupply);
            subjectMinComponentQuantities = [weth, dai];
          }
          else {
            const dai = subjectPoolTokens.mul(reserve0).div(totalSupply);
            const weth = subjectPoolTokens.mul(reserve1).div(totalSupply);
            subjectMinComponentQuantities = [weth, dai];
          }
          subjectCaller = owner;
        });

        async function subject(): Promise<any> {
          return await ammModule.connect(subjectCaller.wallet).removeLiquidity(
            subjectSetToken,
            subjectIntegrationName,
            subjectAmmPool,
            subjectPoolTokens,
            subjectComponentsToOutput,
            subjectMinComponentQuantities,
          );
        }

        it("should reduce the liquidity token of the caller", async () => {
          const previousLiquidityTokenBalance = await uniswapSetup.wethDaiPool.balanceOf(subjectSetToken);

          await subject();
          const liquidityTokenBalance = await uniswapSetup.wethDaiPool.balanceOf(subjectSetToken);
          const expectedLiquidityBalance = previousLiquidityTokenBalance.sub(subjectPoolTokens);
          expect(liquidityTokenBalance).to.eq(expectedLiquidityBalance);
        });

        it("should update the positions properly", async () => {
          await subject();
          const positions = await setToken.getPositions();

          expect(positions.length).to.eq(2);

          expect(positions[0].component).to.eq(setup.weth.address);
          expect(positions[0].unit).to.eq(subjectMinComponentQuantities[0]);
          expect(positions[1].component).to.eq(setup.dai.address);
          expect(positions[1].unit).to.eq(subjectMinComponentQuantities[1]);
        });

        describe("when more underlying tokens are requested than owned", async () => {
          beforeEach(async () => {
            subjectMinComponentQuantities = [subjectMinComponentQuantities[0].mul(2),
              subjectMinComponentQuantities[1]];
          });

          it("should revert", async () => {
            await expect(subject()).to.be.revertedWith("amounts must be <= ownedTokens");
          });
        });

        shouldRevertIfPoolIsNotSupported(subject);
      });

    });

    context("when there is a deployed SetToken with enabled AmmModule", async () => {
      before(async () => {
        // Deploy a standard SetToken with the AMM Module
        setToken = await setup.createSetToken(
          [uniswapSetup.wethDaiPool.address],
          [ether(1)],
          [setup.issuanceModule.address, ammModule.address]
        );

        await setup.issuanceModule.initialize(setToken.address, ADDRESS_ZERO);
        await ammModule.initialize(setToken.address);

        // Mint some instances of the SetToken
        await setup.approveAndIssueSetToken(setToken, ether(1));
      });

      describe("#removeLiquiditySingleAsset", async () => {
        let subjectComponentToOutput: Address;
        let subjectMinComponentQuantity: BigNumber;
        let subjectPoolTokens: BigNumber;

        beforeEach(async () => {
          subjectSetToken = setToken.address;
          subjectIntegrationName = uniswapV2AmmAdapterName;
          subjectAmmPool = uniswapSetup.wethDaiPool.address;
          subjectComponentToOutput = setup.weth.address;
          subjectPoolTokens = ether(1);
          const token0 = await uniswapSetup.wethDaiPool.token0();
          const totalSupply = await uniswapSetup.wethDaiPool.totalSupply();
          const [reserve0, reserve1, ] = await uniswapSetup.wethDaiPool.getReserves();
          const token0Amount = subjectPoolTokens.mul(reserve0).div(totalSupply);
          const token1Amount = subjectPoolTokens.mul(reserve1).div(totalSupply);
          if ( token0 == setup.weth.address ) {
            const receivedAmount = await uniswapSetup.router.getAmountOut(token1Amount,
              reserve1.sub(token1Amount), reserve0.sub(token0Amount));
            subjectMinComponentQuantity = token0Amount.add(receivedAmount);
          }
          else {
            const receivedAmount = await uniswapSetup.router.getAmountOut(token0Amount,
              reserve0.sub(token0Amount), reserve1.sub(token1Amount));
            subjectMinComponentQuantity = token1Amount.add(receivedAmount);
          }
          subjectCaller = owner;
        });

        async function subject(): Promise<any> {
          return await ammModule.connect(subjectCaller.wallet).removeLiquiditySingleAsset(
            subjectSetToken,
            subjectIntegrationName,
            subjectAmmPool,
            subjectPoolTokens,
            subjectComponentToOutput,
            subjectMinComponentQuantity,
          );
        }

        it("should reduce the liquidity token of the caller", async () => {
          const previousLiquidityTokenBalance = await uniswapSetup.wethDaiPool.balanceOf(subjectSetToken);
          await subject();
          const liquidityTokenBalance = await uniswapSetup.wethDaiPool.balanceOf(subjectSetToken);
          const expectedLiquidityBalance = previousLiquidityTokenBalance.sub(subjectPoolTokens);
          expect(liquidityTokenBalance).to.eq(expectedLiquidityBalance);
        });

        it("should update the positions properly", async () => {
          await subject();
          const positions = await setToken.getPositions();
          expect(positions.length).to.eq(1);
          expect(positions[0].component).to.eq(setup.weth.address);
          expect(positions[0].unit).to.eq(subjectMinComponentQuantity);
        });

      });

    });

    function shouldRevertIfPoolIsNotSupported(subject: any) {
      describe("when the pool is not supported on the adapter", async () => {
        beforeEach(async () => {
          subjectAmmPool = setup.wbtc.address;
        });


        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("Pool token must be enabled on the Adapter");
        });
      });
    }
  });

});
