import "module-alias/register";
import { Account } from "@utils/test/types";
import { Address } from "@utils/types";
import { AmmModule, ArrakisUniswapV3AmmAdapter } from "@utils/contracts";
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
  let ammModule: AmmModule;
  let arrakisUniswapV3AmmAdapter: ArrakisUniswapV3AmmAdapter;
  let arrakisUniswapV3AmmAdapterName: string;

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
    // await setup.weth.connect(owner.wallet)
    //   .approve(uniswapV3Setup.router.address, MAX_UINT_256);
    // await setup.dai.connect(owner.wallet)
    //   .approve(uniswapV3Setup.router.address, MAX_UINT_256);
    // await uniswapV3Setup.router.connect(owner.wallet).addLiquidity(
    //   setup.weth.address,
    //   setup.dai.address,
    //   ether(200),
    //   ether(600000),
    //   ether(0),
    //   ether(0),
    //   owner.address,
    //   MAX_UINT_256
    // );

    arrakisV1Setup = getArrakisV1Fixture(owner.address);
    await arrakisV1Setup.initialize(owner, uniswapV3Setup, setup.weth, 2500, setup.wbtc, 35000, setup.dai);

    ammModule = await deployer.modules.deployAmmModule(setup.controller.address);
    await setup.controller.addModule(ammModule.address);

    arrakisUniswapV3AmmAdapter = await deployer.adapters.deployArrakisUniswapV3AmmAdapter(
      arrakisV1Setup.router.address,
      uniswapV3Setup.factory.address
    );
    arrakisUniswapV3AmmAdapterName = "ARRAKISUNISWAPV3AMM";

    await setup.integrationRegistry.addIntegration(
      ammModule.address,
      arrakisUniswapV3AmmAdapterName,
      arrakisUniswapV3AmmAdapter.address
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

});
