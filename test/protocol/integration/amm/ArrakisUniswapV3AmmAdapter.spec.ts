import "module-alias/register";
import { BigNumber } from "ethers";
import { ether } from "@utils/index";
import { Account } from "@utils/test/types";
import { Address } from "@utils/types";
import {
  ZERO,
} from "@utils/constants";
import { ArrakisUniswapV3AmmAdapter } from "@utils/contracts";
import DeployHelper from "@utils/deploys";
import {
  addSnapshotBeforeRestoreAfterEach,
  getAccounts,
  getSystemFixture,
  getUniswapV3Fixture,
  getArrakisV1Fixture,
  getWaffleExpect
} from "@utils/test/index";

import { SystemFixture, UniswapV3Fixture, ArrakisV1Fixture } from "@utils/fixtures";

const expect = getWaffleExpect();

describe("ArrakisUniswapV3AmmAdapter", () => {
  let owner: Account;
  let deployer: DeployHelper;
  let setup: SystemFixture;
  let uniswapV3Setup: UniswapV3Fixture;
  let arrakisV1Setup: ArrakisV1Fixture;
  let arrakisUniswapV3AmmAdapter: ArrakisUniswapV3AmmAdapter;

  before(async () => {
    [
      owner,
    ] = await getAccounts();

    deployer = new DeployHelper(owner.wallet);
    setup = getSystemFixture(owner.address);
    await setup.initialize();

    uniswapV3Setup = getUniswapV3Fixture(owner.address);
    await uniswapV3Setup.initialize(
      owner,
      setup.weth,
      2500,
      setup.wbtc,
      35000,
      setup.dai
    );

    arrakisV1Setup = getArrakisV1Fixture(owner.address);
    await arrakisV1Setup.initialize(owner, uniswapV3Setup, setup.weth, 2500, setup.wbtc, 35000, setup.dai);

    arrakisUniswapV3AmmAdapter = await deployer.adapters.deployArrakisUniswapV3AmmAdapter(
      arrakisV1Setup.router.address,
      uniswapV3Setup.factory.address
    );
  });

  addSnapshotBeforeRestoreAfterEach();

  describe("constructor", async () => {
    async function subject(): Promise<ArrakisUniswapV3AmmAdapter> {
      return await deployer.adapters.deployArrakisUniswapV3AmmAdapter(
        arrakisV1Setup.router.address,
        uniswapV3Setup.factory.address
      );
    }

    it("should have the correct router address", async () => {
      const deployedArrakisUniswapV3AmmAdapter = await subject();

      const actualRouterAddress = await deployedArrakisUniswapV3AmmAdapter.router();
      expect(actualRouterAddress).to.eq(arrakisV1Setup.router.address);
    });

    it("should have the correct uniswapV3 factory address", async () => {
      const deployedArrakisUniswapV3AmmAdapter = await subject();

      const actualUniV3FactoryAddress = await deployedArrakisUniswapV3AmmAdapter.uniV3Factory();
      expect(actualUniV3FactoryAddress).to.eq(uniswapV3Setup.factory.address);
    });
  });

  describe("getSpenderAddress", async () => {
    let poolAddress: Address;

    before(async () => {
      poolAddress = arrakisV1Setup.wethDaiPool.address;
    });

    async function subject(): Promise<any> {
      return await arrakisUniswapV3AmmAdapter.getSpenderAddress(poolAddress);
    }

    it("should return the correct spender address", async () => {
      const spender = await subject();
      expect(spender).to.eq(arrakisV1Setup.router.address);
    });
  });

  describe("isValidPool", async () => {
    let subjectAmmPool: Address;
    let subjectComponents: Address[];

    beforeEach(async () => {
      subjectAmmPool = arrakisV1Setup.wethDaiPool.address;
      subjectComponents = [setup.weth.address, setup.dai.address];
    });

    async function subject(): Promise<any> {
      return await arrakisUniswapV3AmmAdapter.isValidPool(subjectAmmPool, subjectComponents);
    }

    it("should be a valid pool", async () => {
      const status = await subject();
      expect(status).to.be.true;
    });

    describe("when the pool address is invalid", async () => {
      beforeEach(async () => {
        subjectAmmPool = setup.weth.address;
      });

      it("should be an invalid pool", async () => {
        const status = await subject();
        expect(status).to.be.false;
      });
    });

    describe("when the components don't match", async () => {
      beforeEach(async () => {
        subjectComponents = [setup.weth.address, setup.wbtc.address];
      });

      it("should be an invalid pool", async () => {
        const status = await subject();
        expect(status).to.be.false;
      });
    });

    describe("when the number of components is incorrect", async () => {
      beforeEach(async () => {
        subjectComponents = [setup.weth.address];
      });

      it("should be an invalid pool", async () => {
        const status = await subject();
        expect(status).to.be.false;
      });
    });

    describe("when the pool address is not an ERC20", async () => {
      beforeEach(async () => {
        subjectAmmPool = uniswapV3Setup.wethDaiPool.address;
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
      subjectAmmPool = arrakisV1Setup.wethDaiPool.address;
      subjectComponent = setup.weth.address;
      subjectMaxTokenIn = ether(1);
      subjectMinLiquidity = ether(1);
    });

    async function subject(): Promise<any> {
      return await arrakisUniswapV3AmmAdapter.getProvideLiquiditySingleAssetCalldata(
        owner.address,
        subjectAmmPool,
        subjectComponent,
        subjectMaxTokenIn,
        subjectMinLiquidity);
    }

    it("should revert", async () => {
      await expect(subject()).to.be.revertedWith("Arrakis single asset addition is not supported");
    });
  });

  describe("getRemoveLiquiditySingleAssetCalldata", async () => {
    let subjectAmmPool: Address;
    let subjectComponent: Address;
    let subjectMinTokenOut: BigNumber;
    let subjectLiquidity: BigNumber;

    before(async () => {
      subjectAmmPool = uniswapV3Setup.wethDaiPool.address;
      subjectComponent = setup.weth.address;
      subjectMinTokenOut = ether(1);
      subjectLiquidity = ether(1);
    });

    async function subject(): Promise<any> {
      return await arrakisUniswapV3AmmAdapter.getRemoveLiquiditySingleAssetCalldata(
        owner.address,
        subjectAmmPool,
        subjectComponent,
        subjectMinTokenOut,
        subjectLiquidity);
    }

    it("should revert", async () => {
      await expect(subject()).to.be.revertedWith("Arrakis single asset removal is not supported");
    });
  });

  describe("getProvideLiquidityCalldata", async () => {
    let subjectAmmPool: Address;
    let subjectComponents: Address[];
    let subjectMaxTokensIn: BigNumber[];
    let subjectMinLiquidity: BigNumber;

    beforeEach(async () => {
      subjectAmmPool = arrakisV1Setup.wethDaiPool.address;
      subjectComponents = [setup.weth.address, setup.dai.address];
      subjectMaxTokensIn = [ether(1), ether(3000)];
      const orderedMaxTokensIn = arrakisV1Setup.getOrderedAmount(
        setup.weth.address,
        setup.dai.address,
        subjectMaxTokensIn[0],
        subjectMaxTokensIn[1]
      );
      const mintAmount = await arrakisV1Setup.wethDaiPool.getMintAmounts(orderedMaxTokensIn[0], orderedMaxTokensIn[1]);
      subjectMinLiquidity = mintAmount[2];
    });

    async function subject(): Promise<any> {
      return await arrakisUniswapV3AmmAdapter.getProvideLiquidityCalldata(
        owner.address,
        subjectAmmPool,
        subjectComponents,
        subjectMaxTokensIn,
        subjectMinLiquidity);
    }

    it("should return the correct provide liquidity calldata", async () => {
      const calldata = await subject();

      // Determine how much of each token the _minLiquidity would return
      const orderedMaxTokensIn = arrakisV1Setup.getOrderedAmount(
        setup.weth.address,
        setup.dai.address,
        subjectMaxTokensIn[0],
        subjectMaxTokensIn[1]
      );
      const mintAmount = await arrakisV1Setup.wethDaiPool.getMintAmounts(orderedMaxTokensIn[0], orderedMaxTokensIn[1]);
      const amountAMin = mintAmount[0];
      const amountBMin = mintAmount[1];

      const expectedCallData = arrakisV1Setup.router.interface.encodeFunctionData("addLiquidity", [
        subjectAmmPool,
        orderedMaxTokensIn[0],
        orderedMaxTokensIn[1],
        amountAMin,
        amountBMin,
        owner.address
      ]);
      expect(JSON.stringify(calldata)).to.eq(JSON.stringify([arrakisV1Setup.router.address, ZERO, expectedCallData]));
    });

    describe("when the either of the _maxTokensIn is zero", async () => {
      beforeEach(async () => {
        subjectMaxTokensIn = [ZERO, ether(3000)];
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Component quantity must be nonzero");
      });
    });

    describe("when the _minLiquidity is too high", async () => {
      beforeEach(async () => {
        subjectMinLiquidity = subjectMinLiquidity.mul(2);
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("_minLiquidity is too high for input token limit");
      });
    });
  });

  describe("getRemoveLiquidityCalldata", async () => {
    let subjectAmmPool: Address;
    let subjectComponents: Address[];
    let subjectMinTokensOut: BigNumber[];
    let subjectLiquidity: BigNumber;

    beforeEach(async () => {
      subjectAmmPool = arrakisV1Setup.wethDaiPool.address;
      subjectComponents = [setup.weth.address, setup.dai.address];
      subjectLiquidity = await arrakisV1Setup.wethDaiPool.balanceOf(owner.address);
      subjectMinTokensOut = [ether(1), ether(3000)];
    });

    async function subject(): Promise<any> {
      return await arrakisUniswapV3AmmAdapter.getRemoveLiquidityCalldata(
        owner.address,
        subjectAmmPool,
        subjectComponents,
        subjectMinTokensOut,
        subjectLiquidity);
    }

    it("should return the correct remove liquidity calldata", async () => {
      const calldata = await subject();
      const orderedMinTokensOut = arrakisV1Setup.getOrderedAmount(
        setup.weth.address,
        setup.dai.address,
        subjectMinTokensOut[0],
        subjectMinTokensOut[1]
      );
      const expectedCallData = arrakisV1Setup.router.interface.encodeFunctionData("removeLiquidity", [
        subjectAmmPool,
        subjectLiquidity,
        orderedMinTokensOut[0],
        orderedMinTokensOut[1],
        owner.address
      ]);
      expect(JSON.stringify(calldata)).to.eq(JSON.stringify([arrakisV1Setup.router.address, ZERO, expectedCallData]));
    });

    describe("when the _liquidity is more than available", async () => {
      beforeEach(async () => {
        subjectLiquidity = (await arrakisV1Setup.wethDaiPool.balanceOf(owner.address)).add(ether(1));
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("_liquidity must be <= to current balance");
      });
    });
  });

});
