import "module-alias/register";

import { BigNumber, BigNumberish } from "ethers";

import { Address } from "@utils/types";
import { Account } from "@utils/test/types";
import { MAX_UINT_256, ADDRESS_ZERO, ZERO } from "@utils/constants";
import { SetToken, AmmModule, UniswapV2AmmAdapter, UniswapV2Pair } from "@utils/contracts";
import DeployHelper from "@utils/deploys";
import { ether } from "@utils/index";
import {
  addSnapshotBeforeRestoreAfterEach,
  getAccounts,
  getSystemFixture,
  getUniswapFixture,
  getWaffleExpect,
  getLastBlockTimestamp,
  getCurveAmmFixture,
} from "@utils/test/index";

import { CurveAmmFixture, SystemFixture, UniswapFixture } from "@utils/fixtures";
import { ethers, network } from "hardhat";
import { Interface } from "@ethersproject/abi";
import dependencies from "@utils/deploys/dependencies";
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers";
import { parseEther } from "@ethersproject/units";

const expect = getWaffleExpect();
const provider = ethers.provider;

describe("CurveMetaPoolAmmAdapter [@forked-mainnet]", () => {
  let owner: Account;
  let daiWhale: SignerWithAddress;
  let deployer: DeployHelper;
  let setup: SystemFixture;
  let curveAmmSetup: CurveAmmFixture;
  let ammModule: AmmModule;

  const addLiquidityInterface = new ethers.utils.Interface([
    {
      name: "add_liquidity",
      outputs: [{ type: "uint256", name: "" }],
      inputs: [
        { type: "address", name: "_pool" },
        { type: "uint256[4]", name: "_deposit_amounts" },
        { type: "uint256", name: "_min_mint_amount" },
        { type: "address", name: "_receiver" },
      ],
      stateMutability: "nonpayable",
      type: "function",
    },
  ]);

  const removeLiquidityInterface = new ethers.utils.Interface([
    {
      name: "remove_liquidity",
      outputs: [{ type: "uint256[4]", name: "" }],
      inputs: [
        { type: "address", name: "_pool" },
        { type: "uint256", name: "_burn_amount" },
        { type: "uint256[4]", name: "_min_amounts" },
        { type: "address", name: "_receiver" },
      ],
      stateMutability: "nonpayable",
      type: "function",
    },
  ]);

  const removeLiquidityOneCoinInterface = new ethers.utils.Interface([
    {
      name: "remove_liquidity_one_coin",
      outputs: [{ type: "uint256", name: "" }],
      inputs: [
        { type: "address", name: "_pool" },
        { type: "uint256", name: "_burn_amount" },
        { type: "int128", name: "i" },
        { type: "uint256", name: "_min_amounts" },
        { type: "address", name: "_receiver" },
      ],
      stateMutability: "nonpayable",
      type: "function",
    },
  ]);

  before(async () => {
    [owner] = await getAccounts();

    deployer = new DeployHelper(owner.wallet);
    setup = getSystemFixture(owner.address);
    await setup.initialize();

    curveAmmSetup = getCurveAmmFixture(owner.address);
    await curveAmmSetup.deployForkedContracts();

    ammModule = await deployer.modules.deployAmmModule(setup.controller.address);
    await setup.controller.addModule(ammModule.address);

    await network.provider.request({
      method: "hardhat_impersonateAccount",
      params: [dependencies.DAI_WHALE],
    });

    daiWhale = await ethers.getSigner(dependencies.DAI_WHALE);
  });

  addSnapshotBeforeRestoreAfterEach();

  describe("constructor", async () => {
    it("should have correct curveRegistry address", async () => {
      expect(await curveAmmSetup.curveMetapoolAmmAdapter.curveRegistry()).to.eq(
        curveAmmSetup.curveRegistry.address,
      );
    });
    it("should have correct metaP address", async () => {
      expect(await curveAmmSetup.curveMetapoolAmmAdapter.metaPoolZap()).to.eq(
        curveAmmSetup.metapoolZap.address,
      );
    });
  });

  describe("isValidPool", async () => {
    let subjectAmmPool: Address;
    let subjectComponents: Address[];

    beforeEach(async () => {
      subjectAmmPool = curveAmmSetup.metapool.address;
      subjectComponents = [
        curveAmmSetup.gusd.address,
        curveAmmSetup.dai.address,
        curveAmmSetup.usdc.address,
        curveAmmSetup.usdt.address,
      ];
    });

    async function subject(): Promise<any> {
      return await curveAmmSetup.curveMetapoolAmmAdapter.isValidPool(
        subjectAmmPool,
        subjectComponents,
      );
    }

    it("should be a valid pool", async () => {
      const status = await subject();
      expect(status).to.be.true;
    });

    describe("when the pool address is invalid", async () => {
      beforeEach(async () => {
        subjectAmmPool = curveAmmSetup.dai.address;
      });

      it("should be an invalid pool", async () => {
        const status = await subject();
        expect(status).to.be.false;
      });
    });

    describe("when the components don't match", async () => {
      beforeEach(async () => {
        subjectComponents = [
          curveAmmSetup.dai.address,
          curveAmmSetup.usdc.address,
          curveAmmSetup.usdt.address,
          curveAmmSetup.gusd.address,
        ];
      });

      it("should be an invalid pool", async () => {
        const status = await subject();
        expect(status).to.be.false;
      });
    });

    describe("when the number of components is incorrect", async () => {
      beforeEach(async () => {
        subjectComponents = [curveAmmSetup.gusd.address];
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
      subjectAmmPool = curveAmmSetup.metapool.address;
      subjectComponent = curveAmmSetup.dai.address;
      subjectMaxTokenIn = ether(1);
      subjectMinLiquidity = ether(1);
    });

    async function subject(): Promise<any> {
      return await curveAmmSetup.curveMetapoolAmmAdapter.getProvideLiquiditySingleAssetCalldata(
        curveAmmSetup.setToken.address,
        subjectAmmPool,
        subjectComponent,
        subjectMaxTokenIn,
        subjectMinLiquidity,
      );
    }

    it("should return the correct provide liquidity calldata", async () => {
      const calldata = await subject();

      const expectedCallData = addLiquidityInterface.encodeFunctionData("add_liquidity", [
        subjectAmmPool,
        [ether(0), ether(1), ether(0), ether(0)],
        ether(1),
        curveAmmSetup.setToken.address,
      ]);

      expect(JSON.stringify(calldata)).to.eq(
        JSON.stringify([curveAmmSetup.metapoolZap.address, ZERO, expectedCallData]),
      );
    });
  });

  describe("getRemoveLiquiditySingleAssetCalldata", async () => {
    let subjectAmmPool: Address;
    let subjectComponent: Address;
    let subjectComponentIndex: number;
    let subjectMinTokenOut: BigNumber;
    let subjectLiquidity: BigNumber;

    before(async () => {
      subjectAmmPool = curveAmmSetup.metapool.address;
      subjectComponent = curveAmmSetup.dai.address;
      subjectComponentIndex = 1;
      subjectMinTokenOut = ether(1);
      subjectLiquidity = ether(1);
    });

    async function subject(): Promise<any> {
      return await curveAmmSetup.curveMetapoolAmmAdapter.getRemoveLiquiditySingleAssetCalldata(
        curveAmmSetup.setToken.address,
        subjectAmmPool,
        subjectComponent,
        subjectMinTokenOut,
        subjectLiquidity,
      );
    }

    it("should return the correct remove liquidity calldata", async () => {
      const calldata = await subject();
      const expectedCallData = removeLiquidityOneCoinInterface.encodeFunctionData(
        "remove_liquidity_one_coin",
        [
          subjectAmmPool,
          subjectLiquidity,
          subjectComponentIndex,
          subjectMinTokenOut,
          curveAmmSetup.setToken.address,
        ],
      );

      expect(JSON.stringify(calldata)).to.eq(
        JSON.stringify([curveAmmSetup.metapoolZap.address, ZERO, expectedCallData]),
      );
    });
  });

  describe("getProvideLiquidityCalldata", async () => {
    let subjectAmmPool: Address;
    let subjectComponents: Address[];
    let subjectMaxTokensIn: [BigNumberish, BigNumberish, BigNumberish, BigNumberish];
    let subjectMinLiquidity: BigNumber;

    beforeEach(async () => {
      subjectAmmPool = curveAmmSetup.metapool.address;
      subjectComponents = curveAmmSetup.underlying;
      subjectMaxTokensIn = [ether(1), ether(1), ether(1), ether(1)];
      subjectMinLiquidity = ether(4);
    });

    async function subject(): Promise<any> {
      return await curveAmmSetup.curveMetapoolAmmAdapter.getProvideLiquidityCalldata(
        curveAmmSetup.setToken.address,
        subjectAmmPool,
        subjectComponents,
        subjectMaxTokensIn,
        subjectMinLiquidity,
      );
    }

    it("should return the correct provide liquidity calldata", async () => {
      const calldata = await subject();
      const expectedCallData = addLiquidityInterface.encodeFunctionData("add_liquidity", [
        subjectAmmPool,
        subjectMaxTokensIn,
        ether(4),
        curveAmmSetup.setToken.address,
      ]);

      expect(JSON.stringify(calldata)).to.eq(
        JSON.stringify([curveAmmSetup.metapoolZap.address, ZERO, expectedCallData]),
      );
    });
  });

  describe("getRemoveLiquidityCalldata", async () => {
    let subjectAmmPool: Address;
    let subjectComponents: Address[];
    let subjectMinTokensOut: BigNumber[];
    let subjectLiquidity: BigNumber;

    beforeEach(async () => {
      subjectAmmPool = curveAmmSetup.metapool.address;
      subjectComponents = curveAmmSetup.underlying;
      subjectMinTokensOut = [ether(1), ether(1), ether(1), ether(1)];
      subjectLiquidity = ether(4);
    });

    async function subject(): Promise<any> {
      return await curveAmmSetup.curveMetapoolAmmAdapter.getRemoveLiquidityCalldata(
        curveAmmSetup.setToken.address,
        subjectAmmPool,
        subjectComponents,
        subjectMinTokensOut,
        subjectLiquidity,
      );
    }

    it("should return the correct remove liquidity calldata", async () => {
      const calldata = await subject();

      const expectedCallData = removeLiquidityInterface.encodeFunctionData("remove_liquidity", [
        curveAmmSetup.metapool.address,
        subjectLiquidity,
        subjectMinTokensOut,
        curveAmmSetup.setToken.address,
      ]);
      expect(JSON.stringify(calldata)).to.eq(
        JSON.stringify([curveAmmSetup.metapoolZap.address, ZERO, expectedCallData]),
      );
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
          [curveAmmSetup.dai.address, curveAmmSetup.poolToken.address],
          [ether(100), ether(1)],
          [setup.issuanceModule.address, ammModule.address],
        );

        await setup.issuanceModule.initialize(setToken.address, ADDRESS_ZERO);
        await ammModule.initialize(setToken.address);
        await network.provider.send("hardhat_setBalance", [
          daiWhale.address,
          "0x152d02c7e14af6800000", // 100k ETH
        ]);
        console.log(curveAmmSetup.dai.address);
        console.log(curveAmmSetup.metapool.address);
        console.log(curveAmmSetup.metapoolZap.address);
        await curveAmmSetup.dai.connect(daiWhale).transfer(owner.address, parseEther("100000"));
        await curveAmmSetup.dai
          .connect(owner.wallet)
          .approve(curveAmmSetup.metapoolZap.address, parseEther("1000"));
        await curveAmmSetup.metapoolZap
          .connect(owner.wallet)
          ["add_liquidity(address,uint256[4],uint256)"](
            curveAmmSetup.metapool.address,
            [0, parseEther("10"), 0, 0],
            0,
            { gasLimit: 900000 },
          );
        // await curveAmmSetup.metapoolZap
        //   .connect(owner.wallet)
        //   ["add_liquidity(address,uint256[4],uint256,address)"](
        //     curveAmmSetup.metapool.address,
        //     [0, ether(10), 0, 0],
        //     0,
        //     owner.address,
        //   );
        // // Mint some instances of the SetToken
        await setup.approveAndIssueSetToken(setToken, ether(1));
        // await setup.integrationRegistry.addIntegration(ammModule.address,"CURVEMETAPOOLAMMADAPTER",curveAmmSetup.curveMetapoolAmmAdapter.address)
      });

      describe("#addLiquidity", async () => {
        let subjectComponentsToInput: Address[];
        let subjectMaxComponentQuantities: BigNumber[];

        beforeEach(async () => {
          subjectSetToken = setToken.address;
          subjectIntegrationName = "CURVEMETAPOOLAMMADAPTER";
          subjectAmmPool = curveAmmSetup.metapool.address;
          subjectComponentsToInput = curveAmmSetup.underlying;
          subjectMaxComponentQuantities = [ether(0), ether(1), ether(0), ether(0)];
          subjectCaller = owner;
        });

        async function subject(): Promise<any> {
          console.log(await (await curveAmmSetup.dai.balanceOf(daiWhale.address)).toString());
          // return await ammModule
          //   .connect(daiWhale)
          //   .addLiquidity(
          //     subjectSetToken,
          //     subjectIntegrationName,
          //     subjectAmmPool,
          //     subjectMinPoolTokensToMint,
          //     subjectComponentsToInput,
          //     subjectMaxComponentQuantities,
          //   );
        }

        it("should mint the liquidity token to the caller", async () => {
          await subject();
          // const liquidityTokenBalance = await curveAmmSetup.poolToken.balanceOf(subjectSetToken);
          // expect(liquidityTokenBalance).to.eq(subjectMinPoolTokensToMint);
        });
      });

      //     it("should update the positions properly", async () => {
      //       await subject();
      //       const positions = await setToken.getPositions();
      //       expect(positions.length).to.eq(1);
      //       expect(positions[0].component).to.eq(subjectAmmPool);
      //       expect(positions[0].unit).to.eq(subjectMinPoolTokensToMint);
      //     });

      //     describe("when extra dai tokens are supplied", async () => {
      //       let wethRemaining: BigNumber;
      //       let daiRemaining: BigNumber;
      //       beforeEach(async () => {
      //         wethRemaining = ether(0.5);
      //         subjectMaxComponentQuantities = [ether(0.5), ether(1600)];
      //         const totalSupply = await uniswapSetup.wethDaiPool.totalSupply();
      //         const [reserveA, reserveB] = await getReserves(uniswapSetup.wethDaiPool, subjectComponentsToInput[0]);
      //         const liquidityA = ether(0.5).mul(totalSupply).div(reserveA);
      //         const liquidityB = ether(1600).mul(totalSupply).div(reserveB);
      //         subjectMinPoolTokensToMint = liquidityA.lt(liquidityB) ? liquidityA : liquidityB;
      //         daiRemaining = ether(3000).sub(ether(0.5).mul(reserveB).div(reserveA));
      //       });

      //       it("should mint the correct amount of liquidity tokens to the caller", async () => {
      //         await subject();
      //         const liquidityTokenBalance = await uniswapSetup.wethDaiPool.balanceOf(subjectSetToken);
      //         expect(liquidityTokenBalance).to.eq(subjectMinPoolTokensToMint);
      //       });

      //       it("should have the expected weth, dai, and lp tokens", async () => {
      //         await subject();
      //         const positions = await setToken.getPositions();
      //         expect(positions.length).to.eq(3);
      //         expect(positions[0].component).to.eq(setup.weth.address);
      //         expect(positions[0].unit).to.eq(wethRemaining);
      //         expect(positions[1].component).to.eq(setup.dai.address);
      //         expect(positions[1].unit).to.eq(daiRemaining);
      //         expect(positions[2].component).to.eq(subjectAmmPool);
      //         expect(positions[2].unit).to.eq(subjectMinPoolTokensToMint);
      //       });
      //     });

      //     describe("when extra weth tokens are supplied", async () => {
      //       let wethRemaining: BigNumber;
      //       let daiRemaining: BigNumber;
      //       beforeEach(async () => {
      //         daiRemaining = ether(1500);
      //         subjectMaxComponentQuantities = [ether(0.6), ether(1500)];
      //         const totalSupply = await uniswapSetup.wethDaiPool.totalSupply();
      //         const [reserveA, reserveB] = await getReserves(uniswapSetup.wethDaiPool, subjectComponentsToInput[0]);
      //         const liquidityA = ether(0.6).mul(totalSupply).div(reserveA);
      //         const liquidityB = ether(1500).mul(totalSupply).div(reserveB);
      //         subjectMinPoolTokensToMint = liquidityA.lt(liquidityB) ? liquidityA : liquidityB;
      //         wethRemaining = ether(1).sub(ether(1500).mul(reserveA).div(reserveB));
      //       });

      //       it("should mint the correct amount of liquidity tokens to the caller", async () => {
      //         await subject();
      //         const liquidityTokenBalance = await uniswapSetup.wethDaiPool.balanceOf(subjectSetToken);
      //         expect(liquidityTokenBalance).to.eq(subjectMinPoolTokensToMint);
      //       });

      //       it("should have the expected weth, dai, and lp tokens", async () => {
      //         await subject();
      //         const positions = await setToken.getPositions();
      //         expect(positions.length).to.eq(3);
      //         expect(positions[0].component).to.eq(setup.weth.address);
      //         expect(positions[0].unit).to.eq(wethRemaining);
      //         expect(positions[1].component).to.eq(setup.dai.address);
      //         expect(positions[1].unit).to.eq(daiRemaining);
      //         expect(positions[2].component).to.eq(subjectAmmPool);
      //         expect(positions[2].unit).to.eq(subjectMinPoolTokensToMint);
      //       });
      //     });

      //     describe("when the pool address is invalid", async () => {
      //       beforeEach(async () => {
      //         const otherUniswapSetup = getUniswapFixture(owner.address);
      //         await otherUniswapSetup.initialize(owner, setup.weth.address, setup.wbtc.address, setup.dai.address);
      //         subjectAmmPool = otherUniswapSetup.wethDaiPool.address;
      //       });

      //       it("should revert", async () => {
      //         await expect(subject()).to.be.revertedWith("Pool token must be enabled on the Adapter");
      //       });
      //     });

      //     describe("when the _components length is invalid", async () => {
      //       beforeEach(async () => {
      //         subjectComponentsToInput = [setup.weth.address];
      //       });

      //       it("should revert", async () => {
      //         await expect(subject()).to.be.revertedWith("Components and units must be equal length");
      //       });
      //     });

      //     describe("when the _maxTokensIn length is invalid", async () => {
      //       beforeEach(async () => {
      //         subjectMaxComponentQuantities = [ether(1)];
      //       });

      //       it("should revert", async () => {
      //         await expect(subject()).to.be.revertedWith("Components and units must be equal length");
      //       });
      //     });

      //     describe("when the _pool doesn't match the _components", async () => {
      //       beforeEach(async () => {
      //         subjectComponentsToInput = [setup.weth.address, setup.wbtc.address];
      //       });

      //       it("should revert", async () => {
      //         await expect(subject()).to.be.revertedWith("Pool token must be enabled on the Adapter");
      //       });
      //     });

      //     describe("when the _maxTokensIn[0] is 0", async () => {
      //       beforeEach(async () => {
      //         subjectMaxComponentQuantities = [ether(0), ether(3000)];
      //       });

      //       it("should revert", async () => {
      //         await expect(subject()).to.be.revertedWith("Component quantity must be nonzero");
      //       });
      //     });

      //     describe("when the _maxTokensIn[1] is 0", async () => {
      //       beforeEach(async () => {
      //         subjectMaxComponentQuantities = [ether(1), ether(0)];
      //       });

      //       it("should revert", async () => {
      //         await expect(subject()).to.be.revertedWith("Component quantity must be nonzero");
      //       });
      //     });

      //     describe("when the _minLiquidity is 0", async () => {
      //       beforeEach(async () => {
      //         subjectMinPoolTokensToMint = ZERO;
      //       });

      //       it("should revert", async () => {
      //         await expect(subject()).to.be.revertedWith("Token quantity must be nonzero");
      //       });
      //     });

      //     shouldRevertIfPoolIsNotSupported(subject);
      //   });

      // });

      // context("when there is a deployed SetToken with enabled AmmModule", async () => {
      //   before(async () => {
      //     // Deploy a standard SetToken with the AMM Module
      //     setToken = await setup.createSetToken(
      //       [uniswapSetup.wethDaiPool.address],
      //       [ether(1)],
      //       [setup.issuanceModule.address, ammModule.address]
      //     );

      //     await setup.issuanceModule.initialize(setToken.address, ADDRESS_ZERO);
      //     await ammModule.initialize(setToken.address);

      //     // Mint some instances of the SetToken
      //     await setup.approveAndIssueSetToken(setToken, ether(1));
      //   });

      //   describe("#removeLiquidity", async () => {
      //     let subjectComponentsToOutput: Address[];
      //     let subjectMinComponentQuantities: BigNumber[];
      //     let subjectPoolTokens: BigNumber;

      //     beforeEach(async () => {
      //       subjectSetToken = setToken.address;
      //       subjectIntegrationName = uniswapV2AmmAdapterName;
      //       subjectAmmPool = uniswapSetup.wethDaiPool.address;
      //       subjectComponentsToOutput = [setup.weth.address, setup.dai.address];
      //       const totalSupply = await uniswapSetup.wethDaiPool.totalSupply();
      //       const [reserveA, reserveB] = await getReserves(uniswapSetup.wethDaiPool, subjectComponentsToOutput[0]);
      //       subjectPoolTokens = ether(1);
      //       const weth = subjectPoolTokens.mul(reserveA).div(totalSupply);
      //       const dai = subjectPoolTokens.mul(reserveB).div(totalSupply);
      //       subjectMinComponentQuantities = [weth, dai];
      //       subjectCaller = owner;
      //     });

      //     async function subject(): Promise<any> {
      //       return await ammModule.connect(subjectCaller.wallet).removeLiquidity(
      //         subjectSetToken,
      //         subjectIntegrationName,
      //         subjectAmmPool,
      //         subjectPoolTokens,
      //         subjectComponentsToOutput,
      //         subjectMinComponentQuantities,
      //       );
      //     }

      //     it("should reduce the liquidity token of the caller", async () => {
      //       const previousLiquidityTokenBalance = await uniswapSetup.wethDaiPool.balanceOf(subjectSetToken);

      //       await subject();
      //       const liquidityTokenBalance = await uniswapSetup.wethDaiPool.balanceOf(subjectSetToken);
      //       const expectedLiquidityBalance = previousLiquidityTokenBalance.sub(subjectPoolTokens);
      //       expect(liquidityTokenBalance).to.eq(expectedLiquidityBalance);
      //     });

      //     it("should update the positions properly", async () => {
      //       await subject();
      //       const positions = await setToken.getPositions();

      //       expect(positions.length).to.eq(2);

      //       expect(positions[0].component).to.eq(setup.weth.address);
      //       expect(positions[0].unit).to.eq(subjectMinComponentQuantities[0]);
      //       expect(positions[1].component).to.eq(setup.dai.address);
      //       expect(positions[1].unit).to.eq(subjectMinComponentQuantities[1]);
      //     });

      //     describe("when more underlying tokens are requested than owned", async () => {
      //       beforeEach(async () => {
      //         subjectMinComponentQuantities = [subjectMinComponentQuantities[0].mul(2),
      //           subjectMinComponentQuantities[1]];
      //       });

      //       it("should revert", async () => {
      //         await expect(subject()).to.be.revertedWith("amounts must be <= ownedTokens");
      //       });
      //     });

      //     describe("when the pool address is invalid", async () => {
      //       beforeEach(async () => {
      //         const otherUniswapSetup = getUniswapFixture(owner.address);
      //         await otherUniswapSetup.initialize(owner, setup.weth.address, setup.wbtc.address, setup.dai.address);
      //         subjectAmmPool = otherUniswapSetup.wethDaiPool.address;
      //       });

      //       it("should revert", async () => {
      //         await expect(subject()).to.be.revertedWith("Pool token must be enabled on the Adapter");
      //       });
      //     });

      //     describe("when the _components length is invalid", async () => {
      //       beforeEach(async () => {
      //         subjectComponentsToOutput = [setup.weth.address];
      //       });

      //       it("should revert", async () => {
      //         await expect(subject()).to.be.revertedWith("Components and units must be equal length");
      //       });
      //     });

      //     describe("when the _minTokensOut length is invalid", async () => {
      //       beforeEach(async () => {
      //         subjectMinComponentQuantities = [ether(1)];
      //       });

      //       it("should revert", async () => {
      //         await expect(subject()).to.be.revertedWith("Components and units must be equal length");
      //       });
      //     });

      //     describe("when the _pool doesn't match the _components", async () => {
      //       beforeEach(async () => {
      //         subjectComponentsToOutput = [setup.weth.address, setup.wbtc.address];
      //       });

      //       it("should revert", async () => {
      //         await expect(subject()).to.be.revertedWith("Pool token must be enabled on the Adapter");
      //       });
      //     });

      //     describe("when the _minTokensOut[0] is 0", async () => {
      //       beforeEach(async () => {
      //         subjectMinComponentQuantities = [ether(0), ether(3000)];
      //       });

      //       it("should revert", async () => {
      //         await expect(subject()).to.be.revertedWith("Component quantity must be nonzero");
      //       });
      //     });

      //     describe("when the _minTokensOut[1] is 0", async () => {
      //       beforeEach(async () => {
      //         subjectMinComponentQuantities = [ether(1), ether(0)];
      //       });

      //       it("should revert", async () => {
      //         await expect(subject()).to.be.revertedWith("Component quantity must be nonzero");
      //       });
      //     });

      //     describe("when the _liquidity is 0", async () => {
      //       beforeEach(async () => {
      //         subjectPoolTokens = ZERO;
      //       });

      //       it("should revert", async () => {
      //         await expect(subject()).to.be.revertedWith("Token quantity must be nonzero");
      //       });
      //     });

      //     shouldRevertIfPoolIsNotSupported(subject);
      //   });

      // });

      // function shouldRevertIfPoolIsNotSupported(subject: any) {
      //   describe("when the pool is not supported on the adapter", async () => {
      //     beforeEach(async () => {
      //       subjectAmmPool = setup.wbtc.address;
      //     });

      //     it("should revert", async () => {
      //       await expect(subject()).to.be.revertedWith("Pool token must be enabled on the Adapter");
      //     });
      //   });
      // }
    });
  });
});
