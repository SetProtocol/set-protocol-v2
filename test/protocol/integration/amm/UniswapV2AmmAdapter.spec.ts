import "module-alias/register";

import { BigNumber } from "ethers";

import { Address } from "@utils/types";
import { Account } from "@utils/test/types";
import {
  MAX_UINT_256,
  ADDRESS_ZERO,
  ZERO,
} from "@utils/constants";
import { SetToken, AmmModule, UniswapV2AmmAdapter, UniswapV2Pair } from "@utils/contracts";
import DeployHelper from "@utils/deploys";
import {
  ether
} from "@utils/index";
import {
  addSnapshotBeforeRestoreAfterEach,
  getAccounts,
  getSystemFixture,
  getUniswapFixture,
  getWaffleExpect,
  getLastBlockTimestamp
} from "@utils/test/index";

import { SystemFixture, UniswapFixture } from "@utils/fixtures";

const expect = getWaffleExpect();

async function getReserves(pair: UniswapV2Pair, token: string): Promise<[BigNumber, BigNumber]> {
  const token0 = await pair.token0();
  const [reserve0, reserve1 ] = await pair.getReserves();
  return token0 == token ? [reserve0, reserve1] : [reserve1, reserve0];
}

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
    let poolAddress: Address;

    before(async () => {
      poolAddress = uniswapSetup.wethDaiPool.address;
    });

    async function subject(): Promise<any> {
      return await uniswapV2AmmAdapter.getSpenderAddress(poolAddress);
    }

    it("should return the correct spender address", async () => {
      const spender = await subject();
      expect(spender).to.eq(uniswapSetup.router.address);
    });

  });

  describe("isValidPool", async () => {
    let subjectAmmPool: Address;
    let subjectComponents: Address[];

    beforeEach(async () => {
      subjectAmmPool = uniswapSetup.wethDaiPool.address;
      subjectComponents = [setup.weth.address, setup.dai.address];
    });

    async function subject(): Promise<any> {
      return await uniswapV2AmmAdapter.isValidPool(subjectAmmPool, subjectComponents);
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

    describe("when the router doesn't match", async () => {
      beforeEach(async () => {
        const otherUniswapSetup = getUniswapFixture(owner.address);
        await otherUniswapSetup.initialize(owner, setup.weth.address, setup.wbtc.address, setup.dai.address);
        subjectAmmPool = otherUniswapSetup.wethDaiPool.address;
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
        uniswapSetup.router.address,
        subjectAmmPool,
        subjectComponent,
        subjectMaxTokenIn,
        subjectMinLiquidity);
    }

    it("should revert", async () => {
      await expect(subject()).to.be.revertedWith("Uniswap V2 single asset addition is not supported");
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
        owner.address,
        subjectAmmPool,
        subjectComponent,
        subjectMinTokenOut,
        subjectLiquidity);
    }

    it("should revert", async () => {
      await expect(subject()).to.be.revertedWith("Uniswap V2 single asset removal is not supported");
    });
  });

  describe("getProvideLiquidityCalldata", async () => {
    let subjectAmmPool: Address;
    let subjectComponents: Address[];
    let subjectMaxTokensIn: BigNumber[];
    let subjectMinLiquidity: BigNumber;

    beforeEach(async () => {
      subjectAmmPool = uniswapSetup.wethDaiPool.address;
      subjectComponents = [setup.weth.address, setup.dai.address];
      subjectMaxTokensIn = [ether(1), ether(3000)];
      const totalSupply = await uniswapSetup.wethDaiPool.totalSupply();
      const [reserveA, reserveB] = await getReserves(uniswapSetup.wethDaiPool, setup.weth.address);
      const liquidityA = subjectMaxTokensIn[0].mul(totalSupply).div(reserveA);
      const liquidityB = subjectMaxTokensIn[1].mul(totalSupply).div(reserveB);
      subjectMinLiquidity = liquidityA.lt(liquidityB) ? liquidityA : liquidityB;
    });

    async function subject(): Promise<any> {
      return await uniswapV2AmmAdapter.getProvideLiquidityCalldata(
        owner.address,
        subjectAmmPool,
        subjectComponents,
        subjectMaxTokensIn,
        subjectMinLiquidity);
    }

    it("should return the correct provide liquidity calldata", async () => {
      const calldata = await subject();
      const blockTimestamp = await getLastBlockTimestamp();

      // Determine how much of each token the _minLiquidity would return
      const totalSupply = await uniswapSetup.wethDaiPool.totalSupply();
      const [reserveA, reserveB] = await getReserves(uniswapSetup.wethDaiPool, setup.weth.address);
      const amountAMin = reserveA.mul(subjectMinLiquidity).div(totalSupply);
      const amountBMin = reserveB.mul(subjectMinLiquidity).div(totalSupply);

      const expectedCallData = uniswapSetup.router.interface.encodeFunctionData("addLiquidity", [
        setup.weth.address,
        setup.dai.address,
        subjectMaxTokensIn[0],
        subjectMaxTokensIn[1],
        amountAMin,
        amountBMin,
        owner.address,
        blockTimestamp,
      ]);
      expect(JSON.stringify(calldata)).to.eq(JSON.stringify([uniswapSetup.router.address, ZERO, expectedCallData]));
    });

    describe("when the _pool totalSupply is 0", async () => {
      beforeEach(async () => {
        subjectAmmPool = uniswapSetup.wethWbtcPool.address;
        subjectComponents = [setup.weth.address, setup.wbtc.address];
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("SafeMath: division by zero");
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
      subjectAmmPool = uniswapSetup.wethDaiPool.address;
      subjectComponents = [setup.weth.address, setup.dai.address];
      subjectLiquidity = ether(1);

      // Determine how much of each token the subjectLiquidity should return
      const totalSupply = await uniswapSetup.wethDaiPool.totalSupply();
      const [reserveA, reserveB] = await getReserves(uniswapSetup.wethDaiPool, setup.weth.address);
      const amountAMin = reserveA.mul(subjectLiquidity).div(totalSupply);
      const amountBMin = reserveB.mul(subjectLiquidity).div(totalSupply);

      subjectMinTokensOut = [amountAMin, amountBMin];
    });

    async function subject(): Promise<any> {
      return await uniswapV2AmmAdapter.getRemoveLiquidityCalldata(
        owner.address,
        subjectAmmPool,
        subjectComponents,
        subjectMinTokensOut,
        subjectLiquidity);
    }

    it("should return the correct remove liquidity calldata", async () => {
      const calldata = await subject();
      const blockTimestamp = await getLastBlockTimestamp();

      const expectedCallData = uniswapSetup.router.interface.encodeFunctionData("removeLiquidity", [
        setup.weth.address,
        setup.dai.address,
        subjectLiquidity,
        subjectMinTokensOut[0],
        subjectMinTokensOut[1],
        owner.address,
        blockTimestamp,
      ]);
      expect(JSON.stringify(calldata)).to.eq(JSON.stringify([uniswapSetup.router.address, ZERO, expectedCallData]));
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
        const balance = await uniswapSetup.wethDaiPool.balanceOf(owner.address);
        const totalSupply = await uniswapSetup.wethDaiPool.totalSupply();
        const [reserveA ] = await getReserves(uniswapSetup.wethDaiPool, setup.weth.address);
        const tooMuchEth = balance.mul(reserveA).div(totalSupply).add(ether(1));
        subjectMinTokensOut = [tooMuchEth, subjectMinTokensOut[1]];
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("amounts must be <= ownedTokens");
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
          const [reserveA, reserveB] = await getReserves(uniswapSetup.wethDaiPool, subjectComponentsToInput[0]);
          const liquidityA = subjectMaxComponentQuantities[0].mul(totalSupply).div(reserveA);
          const liquidityB = subjectMaxComponentQuantities[1].mul(totalSupply).div(reserveB);
          subjectMinPoolTokensToMint = liquidityA.lt(liquidityB) ? liquidityA : liquidityB;
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
            await expect(subject()).to.be.revertedWith("_minLiquidity is too high for input token limit");
          });
        });

        describe("when extra dai tokens are supplied", async () => {
          let wethRemaining: BigNumber;
          let daiRemaining: BigNumber;
          beforeEach(async () => {
            wethRemaining = ether(0.5);
            subjectMaxComponentQuantities = [ether(0.5), ether(1600)];
            const totalSupply = await uniswapSetup.wethDaiPool.totalSupply();
            const [reserveA, reserveB] = await getReserves(uniswapSetup.wethDaiPool, subjectComponentsToInput[0]);
            const liquidityA = ether(0.5).mul(totalSupply).div(reserveA);
            const liquidityB = ether(1600).mul(totalSupply).div(reserveB);
            subjectMinPoolTokensToMint = liquidityA.lt(liquidityB) ? liquidityA : liquidityB;
            daiRemaining = ether(3000).sub(ether(0.5).mul(reserveB).div(reserveA));
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
            const [reserveA, reserveB] = await getReserves(uniswapSetup.wethDaiPool, subjectComponentsToInput[0]);
            const liquidityA = ether(0.6).mul(totalSupply).div(reserveA);
            const liquidityB = ether(1500).mul(totalSupply).div(reserveB);
            subjectMinPoolTokensToMint = liquidityA.lt(liquidityB) ? liquidityA : liquidityB;
            wethRemaining = ether(1).sub(ether(1500).mul(reserveA).div(reserveB));
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

        describe("when the pool address is invalid", async () => {
          beforeEach(async () => {
            const otherUniswapSetup = getUniswapFixture(owner.address);
            await otherUniswapSetup.initialize(owner, setup.weth.address, setup.wbtc.address, setup.dai.address);
            subjectAmmPool = otherUniswapSetup.wethDaiPool.address;
          });

          it("should revert", async () => {
            await expect(subject()).to.be.revertedWith("Pool token must be enabled on the Adapter");
          });
        });

        describe("when the _components length is invalid", async () => {
          beforeEach(async () => {
            subjectComponentsToInput = [setup.weth.address];
          });

          it("should revert", async () => {
            await expect(subject()).to.be.revertedWith("Components and units must be equal length");
          });
        });

        describe("when the _maxTokensIn length is invalid", async () => {
          beforeEach(async () => {
            subjectMaxComponentQuantities = [ether(1)];
          });

          it("should revert", async () => {
            await expect(subject()).to.be.revertedWith("Components and units must be equal length");
          });
        });

        describe("when the _pool doesn't match the _components", async () => {
          beforeEach(async () => {
            subjectComponentsToInput = [setup.weth.address, setup.wbtc.address];
          });

          it("should revert", async () => {
            await expect(subject()).to.be.revertedWith("Pool token must be enabled on the Adapter");
          });
        });

        describe("when the _maxTokensIn[0] is 0", async () => {
          beforeEach(async () => {
            subjectMaxComponentQuantities = [ether(0), ether(3000)];
          });

          it("should revert", async () => {
            await expect(subject()).to.be.revertedWith("Component quantity must be nonzero");
          });
        });

        describe("when the _maxTokensIn[1] is 0", async () => {
          beforeEach(async () => {
            subjectMaxComponentQuantities = [ether(1), ether(0)];
          });

          it("should revert", async () => {
            await expect(subject()).to.be.revertedWith("Component quantity must be nonzero");
          });
        });

        describe("when the _minLiquidity is 0", async () => {
          beforeEach(async () => {
            subjectMinPoolTokensToMint = ZERO;
          });

          it("should revert", async () => {
            await expect(subject()).to.be.revertedWith("Token quantity must be nonzero");
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
          const [reserveA, reserveB] = await getReserves(uniswapSetup.wethDaiPool, subjectComponentsToOutput[0]);
          subjectPoolTokens = ether(1);
          const weth = subjectPoolTokens.mul(reserveA).div(totalSupply);
          const dai = subjectPoolTokens.mul(reserveB).div(totalSupply);
          subjectMinComponentQuantities = [weth, dai];
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

        describe("when the pool address is invalid", async () => {
          beforeEach(async () => {
            const otherUniswapSetup = getUniswapFixture(owner.address);
            await otherUniswapSetup.initialize(owner, setup.weth.address, setup.wbtc.address, setup.dai.address);
            subjectAmmPool = otherUniswapSetup.wethDaiPool.address;
          });

          it("should revert", async () => {
            await expect(subject()).to.be.revertedWith("Pool token must be enabled on the Adapter");
          });
        });

        describe("when the _components length is invalid", async () => {
          beforeEach(async () => {
            subjectComponentsToOutput = [setup.weth.address];
          });

          it("should revert", async () => {
            await expect(subject()).to.be.revertedWith("Components and units must be equal length");
          });
        });

        describe("when the _minTokensOut length is invalid", async () => {
          beforeEach(async () => {
            subjectMinComponentQuantities = [ether(1)];
          });

          it("should revert", async () => {
            await expect(subject()).to.be.revertedWith("Components and units must be equal length");
          });
        });

        describe("when the _pool doesn't match the _components", async () => {
          beforeEach(async () => {
            subjectComponentsToOutput = [setup.weth.address, setup.wbtc.address];
          });

          it("should revert", async () => {
            await expect(subject()).to.be.revertedWith("Pool token must be enabled on the Adapter");
          });
        });

        describe("when the _minTokensOut[0] is 0", async () => {
          beforeEach(async () => {
            subjectMinComponentQuantities = [ether(0), ether(3000)];
          });

          it("should revert", async () => {
            await expect(subject()).to.be.revertedWith("Component quantity must be nonzero");
          });
        });

        describe("when the _minTokensOut[1] is 0", async () => {
          beforeEach(async () => {
            subjectMinComponentQuantities = [ether(1), ether(0)];
          });

          it("should revert", async () => {
            await expect(subject()).to.be.revertedWith("Component quantity must be nonzero");
          });
        });

        describe("when the _liquidity is 0", async () => {
          beforeEach(async () => {
            subjectPoolTokens = ZERO;
          });

          it("should revert", async () => {
            await expect(subject()).to.be.revertedWith("Token quantity must be nonzero");
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
