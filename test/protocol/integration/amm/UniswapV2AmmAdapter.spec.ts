import "module-alias/register";

import { BigNumber } from "@ethersproject/bignumber";

import { Address } from "@utils/types";
import { Account } from "@utils/test/types";
import {
  MAX_UINT_256,
  ADDRESS_ZERO,
  ZERO,
} from "@utils/constants";
import { SetToken, GeneralIndexModule, AmmModule, UniswapV2AmmAdapter } from "@utils/contracts";
import DeployHelper from "@utils/deploys";
import {
  ether,
} from "@utils/index";
import {
  addSnapshotBeforeRestoreAfterEach,
  cacheBeforeEach,
  getAccounts,
  getSystemFixture,
  getUniswapFixture,
  getWaffleExpect,
  getLastBlockTimestamp
} from "@utils/test/index";

import { SystemFixture, UniswapFixture } from "@utils/fixtures";

const expect = getWaffleExpect();

describe("UniswapV2AmmAdapter", () => {
  let owner: Account;
  let deployer: DeployHelper;
  let setup: SystemFixture;
  let uniswapSetup: UniswapFixture;
  let ammModule: AmmModule;
  let positionModule: Account;

  let uniswapV2AmmAdapter: UniswapV2AmmAdapter;
  let uniswapV2AmmAdapterName: string;

  let set: SetToken;
  let indexModule: GeneralIndexModule;

  let setComponents: Address[];
  let setUnits: BigNumber[];

  before(async () => {
    [
      owner,
      ,
      positionModule,
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

    indexModule = await deployer.modules.deployGeneralIndexModule(
      setup.controller.address,
      setup.weth.address
    );
    await setup.controller.addModule(indexModule.address);
    await setup.controller.addModule(positionModule.address);

    uniswapV2AmmAdapter = await deployer.adapters.deployUniswapV2AmmAdapter(uniswapSetup.router.address);
    uniswapV2AmmAdapterName = "UNISWAPV2AMM";

    ammModule = await deployer.modules.deployAmmModule(setup.controller.address);
    await setup.controller.addModule(ammModule.address);

    await setup.integrationRegistry.addIntegration(
      ammModule.address,
      uniswapV2AmmAdapterName,
      uniswapV2AmmAdapter.address
    );
  });

  cacheBeforeEach(async () => {
    setComponents = [setup.weth.address, setup.dai.address];
    setUnits = [ ether(1), ether(3000) ];

    set = await setup.createSetToken(
      setComponents,
      setUnits,
      [setup.issuanceModule.address, ammModule.address, positionModule.address],
    );

    await setup.issuanceModule.initialize(set.address, ADDRESS_ZERO);
    await set.connect(positionModule.wallet).initializeModule();

    await setup.weth.connect(owner.wallet).approve(uniswapSetup.router.address, MAX_UINT_256);
    await setup.dai.connect(owner.wallet).approve(uniswapSetup.router.address, MAX_UINT_256);

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
  });

  addSnapshotBeforeRestoreAfterEach();

  describe("constructor", async () => {
    let subjectUniswapRouter: Address;

    beforeEach(async () => {
      subjectUniswapRouter = uniswapSetup.router.address;
    });

    async function subject(): Promise<any> {
      return await deployer.adapters.deployUniswapV2AmmAdapter(subjectUniswapRouter);
    }

    it("should have the correct router address", async () => {
      const deployedUniswapV2AmmAdapter = await subject();

      const actualRouterAddress = await deployedUniswapV2AmmAdapter.router();
      expect(actualRouterAddress).to.eq(uniswapSetup.router.address);
    });
  });

  describe("getSpenderAddress", async () => {
    async function subject(): Promise<any> {
      return await uniswapV2AmmAdapter.getSpenderAddress(uniswapSetup.wethDaiPool.address);
    }

    it("should return the correct spender address", async () => {
      const spender = await subject();

      expect(spender).to.eq(uniswapSetup.router.address);
    });
  });

  describe("isValidPool", async () => {
    let poolAddress: Address;

    beforeEach(async () => {
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
        beforeEach(async () => {
            poolAddress = uniswapSetup.router.address;
        });

        it("should be an invalid pool", async () => {
          const status = await subject();
          expect(status).to.be.false;
        });
    });

  });

  describe("getProvideLiquiditySingleAssetCalldata", async () => {
    async function subject(): Promise<any> {
      return await uniswapV2AmmAdapter.getProvideLiquiditySingleAssetCalldata(
        uniswapSetup.wethDaiPool.address,
        setup.weth.address,
        ether(1),
        ether(1));
    }

    it("should not support adding a single asset", async () => {
      await expect(subject()).to.be.revertedWith("Single asset liquidity addition not supported");
    });
  });

  describe("getRemoveLiquiditySingleAssetCalldata", async () => {
    async function subject(): Promise<any> {
      return await uniswapV2AmmAdapter.getRemoveLiquiditySingleAssetCalldata(
        uniswapSetup.wethDaiPool.address,
        setup.weth.address,
        ether(1),
        ether(1));
    }

    it("should not support removing a single asset", async () => {
      await expect(subject()).to.be.revertedWith("Single asset liquidity removal not supported");
    });
  });

  describe("getProvideLiquidityCalldata", async () => {
    let component0: Address;
    let component1: Address;
    let component0Quantity: BigNumber;
    let component1Quantity: BigNumber;
    let minimumComponent0Quantity: BigNumber;
    let minimumComponent1Quantity: BigNumber;
    let liquidity: BigNumber;

    beforeEach(async () => {
      component0 = await uniswapSetup.wethDaiPool.token0();
      component1 = await uniswapSetup.wethDaiPool.token1();
      const [reserve0, reserve1] = await uniswapSetup.wethDaiPool.getReserves();
      if ( setup.dai.address == component0 ) {
        component1Quantity = ether(1); // 1 WETH
        component0Quantity = reserve0.mul(component1Quantity).div(reserve1);
      }
      else {
        component0Quantity = ether(1); // 1 WETH
        component1Quantity = reserve1.mul(component0Quantity).div(reserve0);
      }
      const totalSupply = await uniswapSetup.wethDaiPool.totalSupply();
      const component0Liquidity = component0Quantity.mul(totalSupply).div(reserve0);
      const component1Liquidity = component1Quantity.mul(totalSupply).div(reserve1);
      liquidity = component0Liquidity < component1Liquidity ? component0Liquidity : component1Liquidity;
      minimumComponent0Quantity = liquidity.mul(reserve0).div(totalSupply);
      minimumComponent1Quantity = liquidity.mul(reserve1).div(totalSupply);
    });

    async function subject(): Promise<any> {
        return await uniswapV2AmmAdapter.getProvideLiquidityCalldata(
            uniswapSetup.wethDaiPool.address,
            [component0, component1],
            [component0Quantity, component1Quantity],
            liquidity);
    }

    it("should return the correct provide liquidity calldata", async () => {
        const calldata = await subject();
        const callTimestamp = await getLastBlockTimestamp();

        const expectedCallData = uniswapSetup.router.interface.encodeFunctionData("addLiquidity", [
          component0,
          component1,
          component0Quantity,
          component1Quantity,
          minimumComponent0Quantity,
          minimumComponent1Quantity,
          owner.address,
          callTimestamp,
        ]);
        expect(JSON.stringify(calldata)).to.eq(JSON.stringify([uniswapSetup.router.address, ZERO, expectedCallData]));
      });
  });

  describe("getRemoveLiquidityCalldata", async () => {
    let component0: Address;
    let component1: Address;
    let component0Quantity: BigNumber;
    let component1Quantity: BigNumber;
    let liquidity: BigNumber;

    beforeEach(async () => {
      component0 = await uniswapSetup.wethDaiPool.token0();
      component1 = await uniswapSetup.wethDaiPool.token1();
      liquidity = await uniswapSetup.wethDaiPool.balanceOf(owner.address);
      const [reserve0, reserve1] = await uniswapSetup.wethDaiPool.getReserves();
      const totalSupply = await uniswapSetup.wethDaiPool.totalSupply();
      component0Quantity = reserve0.mul(liquidity).div(totalSupply);
      component1Quantity = reserve1.mul(liquidity).div(totalSupply);
    });

    async function subject(): Promise<any> {
        return await uniswapV2AmmAdapter.getRemoveLiquidityCalldata(
            uniswapSetup.wethDaiPool.address,
            [component0, component1],
            [component0Quantity, component1Quantity],
            liquidity);
    }

    it("should return the correct remove liquidity calldata", async () => {
        const calldata = await subject();
        const callTimestamp = await getLastBlockTimestamp();

        const expectedCallData = uniswapSetup.router.interface.encodeFunctionData("removeLiquidity", [
          component0,
          component1,
          liquidity,
          component0Quantity,
          component1Quantity,
          owner.address,
          callTimestamp,
        ]);
        expect(JSON.stringify(calldata)).to.eq(JSON.stringify([uniswapSetup.router.address, ZERO, expectedCallData]));
      });
  });

});
