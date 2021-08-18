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
    async function subject(): Promise<any> {
      return await uniswapV2AmmAdapter.getSpenderAddress(uniswapSetup.wethDaiPool.address);
    }

    it("should return the correct spender address", async () => {
      const spender = await subject();

      expect(spender).to.eq(uniswapV2AmmAdapter.address);
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

  describe("getRemoveLiquidityCalldata", async () => {
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
        return await uniswapV2AmmAdapter.getRemoveLiquidityCalldata(
            subjectAmmPool,
            subjectComponents,
            subjectMaxTokensIn,
            subjectMinLiquidity);
    }

    it("should return the correct remove liquidity calldata", async () => {
        const calldata = await subject();

        const expectedCallData = uniswapV2AmmAdapter.interface.encodeFunctionData("removeLiquidity", [
          subjectAmmPool,
          subjectComponents,
          subjectMaxTokensIn,
          subjectMinLiquidity,
        ]);
        expect(JSON.stringify(calldata)).to.eq(JSON.stringify([uniswapV2AmmAdapter.address, ZERO, expectedCallData]));
      });
  });

  context("Add and Remove Liquidity Tests", async () => {
    let subjectCaller: Account;
    let subjectSetToken: Address;
    let subjectIntegrationName: string;
    let subjectAmmPool: Address;

    let setToken: SetToken;

    context("when there is a deployed SetToken with enabled AmmModule", async () => {
      before(async () => {
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
            subjectMinPoolTokensToMint = liquidity0 < liquidity1 ? liquidity0 : liquidity1;
          }
          else {
            const liquidity0 = ether(3000).mul(totalSupply).div(reserve0);
            const liquidity1 = ether(1).mul(totalSupply).div(reserve1);
            subjectMinPoolTokensToMint = liquidity0 < liquidity1 ? liquidity0 : liquidity1;
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
            await expect(subject()).to.be.revertedWith("_minLiquidity is too high for amount minimums");
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
