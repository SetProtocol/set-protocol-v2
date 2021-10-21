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
import { copySync } from "fs-extra";
import { ERC20 } from "@typechain/ERC20";

const expect = getWaffleExpect();
const provider = ethers.provider;

describe("CurveMetaPoolAmmAdapter [@forked-mainnet]", () => {
  let owner: Account;
  let threeCrvWhale: SignerWithAddress;
  let mimWhale: SignerWithAddress;
  let deployer: DeployHelper;
  let setup: SystemFixture;
  let curveAmmSetup: CurveAmmFixture;
  let ammModule: AmmModule;

  // Interfaces to check return calldata
  // Using typechain interfaces didnt work since all these functions are overloaded which lead to some errors
  const addLiquidityInterface = new ethers.utils.Interface([
    {
      name: "add_liquidity",
      outputs: [{ type: "uint256", name: "" }],
      inputs: [
        { type: "uint256[2]", name: "_deposit_amounts" },
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
      outputs: [{ type: "uint256[2]", name: "" }],
      inputs: [
        { type: "uint256", name: "_burn_amount" },
        { type: "uint256[2]", name: "_min_amounts" },
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
        { type: "uint256", name: "_burn_amount" },
        { type: "int128", name: "i" },
        { type: "uint256", name: "_min_amounts" },
        { type: "address", name: "_receiver" },
      ],
      stateMutability: "nonpayable",
      type: "function",
    },
  ]);

  // Transfer some ERC20 token to `owner` (simply so one does not need to connect with the whale accounts everywhere)
  async function sendTokenToOwner(whale: SignerWithAddress, token: ERC20): Promise<void> {
    await network.provider.send("hardhat_setBalance", [
      whale.address,
      "0x152d02c7e14af6800000", // 100k ETH
    ]);
    await token.connect(whale).transfer(owner.address, parseEther("1000"));
  }

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
      params: [dependencies.THREE_CRV_WHALE],
    });

    await network.provider.request({
      method: "hardhat_impersonateAccount",
      params: [dependencies.MIM_WHALE],
    });

    threeCrvWhale = await ethers.getSigner(dependencies.THREE_CRV_WHALE);
    mimWhale = await ethers.getSigner(dependencies.MIM_WHALE);
  });

  addSnapshotBeforeRestoreAfterEach();

  describe("constructor", async () => {
    it("should have correct metapoolFactory address", async () => {
      expect(await curveAmmSetup.curveMetapoolAmmAdapter.metapoolFactory()).to.eq(
        curveAmmSetup.metapoolFactory.address,
      );
    });
  });

  describe("isValidPool", async () => {
    let subjectAmmPool: Address;
    let subjectComponents: Address[];

    beforeEach(async () => {
      subjectAmmPool = curveAmmSetup.mim3CRVFactoryMetapool.address;
      subjectComponents = [curveAmmSetup.mim.address, curveAmmSetup.threeCrv.address];
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
        subjectAmmPool = setup.dai.address;
      });

      it("should be an invalid pool", async () => {
        const status = await subject();
        expect(status).to.be.false;
      });
    });

    describe("when the components don't match", async () => {
      beforeEach(async () => {
        subjectComponents = [setup.dai.address, curveAmmSetup.mim.address];
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
      subjectAmmPool = curveAmmSetup.mim3CRVFactoryMetapool.address;
      subjectComponent = curveAmmSetup.mim.address;
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
        [ether(1), ether(0)],
        ether(1),
        curveAmmSetup.setToken.address,
      ]);

      expect(JSON.stringify(calldata)).to.eq(
        JSON.stringify([curveAmmSetup.mim3CRVFactoryMetapool.address, ZERO, expectedCallData]),
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
      subjectAmmPool = curveAmmSetup.mim3CRVFactoryMetapool.address;
      subjectComponent = curveAmmSetup.threeCrv.address;
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
          subjectLiquidity,
          subjectComponentIndex,
          subjectMinTokenOut,
          curveAmmSetup.setToken.address,
        ],
      );

      expect(JSON.stringify(calldata)).to.eq(
        JSON.stringify([curveAmmSetup.mim3CRVFactoryMetapool.address, ZERO, expectedCallData]),
      );
    });
  });

  describe("getProvideLiquidityCalldata", async () => {
    let subjectAmmPool: Address;
    let subjectComponents: Address[];
    let subjectMaxTokensIn: [BigNumberish, BigNumberish];
    let subjectMinLiquidity: BigNumber;

    beforeEach(async () => {
      subjectAmmPool = curveAmmSetup.mim3CRVFactoryMetapool.address;
      subjectComponents = curveAmmSetup.underlying;
      subjectMaxTokensIn = [ether(1), ether(1)];
      subjectMinLiquidity = ether(1);
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
        subjectMaxTokensIn,
        ether(1),
        curveAmmSetup.setToken.address,
      ]);

      expect(JSON.stringify(calldata)).to.eq(
        JSON.stringify([curveAmmSetup.mim3CRVFactoryMetapool.address, ZERO, expectedCallData]),
      );
    });
  });

  describe("getRemoveLiquidityCalldata", async () => {
    let subjectAmmPool: Address;
    let subjectComponents: Address[];
    let subjectMinTokensOut: BigNumber[];
    let subjectLiquidity: BigNumber;

    beforeEach(async () => {
      subjectAmmPool = curveAmmSetup.mim3CRVFactoryMetapool.address;
      subjectComponents = curveAmmSetup.underlying;
      subjectMinTokensOut = [ether(1), ether(1)];
      subjectLiquidity = ether(2);
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
        subjectLiquidity,
        subjectMinTokensOut,
        curveAmmSetup.setToken.address,
      ]);

      expect(JSON.stringify(calldata)).to.eq(
        JSON.stringify([curveAmmSetup.mim3CRVFactoryMetapool.address, ZERO, expectedCallData]),
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
          [curveAmmSetup.threeCrv.address, curveAmmSetup.mim.address],
          [ether(1), ether(1)],
          [setup.issuanceModule.address, ammModule.address],
        );

        await setup.issuanceModule.initialize(setToken.address, ADDRESS_ZERO);
        await ammModule.initialize(setToken.address);

        await sendTokenToOwner(threeCrvWhale, curveAmmSetup.threeCrv);
        await sendTokenToOwner(mimWhale, curveAmmSetup.mim);

        await curveAmmSetup.threeCrv
          .connect(owner.wallet)
          .approve(curveAmmSetup.mim3CRVFactoryMetapool.address, parseEther("1000"));
        await curveAmmSetup.mim
          .connect(owner.wallet)
          .approve(curveAmmSetup.mim3CRVFactoryMetapool.address, parseEther("1000"));

        // Mint some instances of the SetToken
        await setup.approveAndIssueSetToken(setToken, ether(1));
        await setup.integrationRegistry.addIntegration(
          ammModule.address,
          "CURVEMETAPOOLAMMADAPTER",
          curveAmmSetup.curveMetapoolAmmAdapter.address,
        );
      });

      describe("#addLiquidity", async () => {
        let subjectComponentsToInput: Address[];
        let subjectMaxComponentQuantities: BigNumber[];
        let subjectMinPoolTokensToMint: BigNumber;

        beforeEach(async () => {
          subjectSetToken = setToken.address;
          subjectIntegrationName = "CURVEMETAPOOLAMMADAPTER";
          subjectAmmPool = curveAmmSetup.mim3CRVFactoryMetapool.address;
          subjectComponentsToInput = [curveAmmSetup.mim.address, curveAmmSetup.threeCrv.address];
          subjectMaxComponentQuantities = [ether(1), ether(1)]; // tokens in
          subjectCaller = owner;
          subjectMinPoolTokensToMint = parseEther("2.016551460306754138"); // min LP-Token to mint
        });

        async function subject(): Promise<any> {
          return await ammModule.addLiquidity(
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
          const liquidityTokenBalance = await curveAmmSetup.mim3CRVFactoryMetapool.balanceOf(subjectSetToken);
          expect(liquidityTokenBalance).to.eq(subjectMinPoolTokensToMint);
        });

        it("should update the positions properly", async () => {
          await subject();
          const positions = await setToken.getPositions();
          expect(positions.length).to.eq(1);
          expect(positions[0].component.toLowerCase()).to.eq(subjectAmmPool.toLowerCase());
          expect(positions[0].unit).to.eq(subjectMinPoolTokensToMint);
        });

        describe("when the pool address is invalid", async () => {
          beforeEach(async () => {
            subjectAmmPool = curveAmmSetup.otherPoolToken.address;
          });

          it("should revert", async () => {
            await expect(subject()).to.be.revertedWith("Pool token must be enabled on the Adapter");
          });
        });

        describe("when the _components length is invalid", async () => {
          beforeEach(async () => {
            subjectComponentsToInput = [curveAmmSetup.threeCrv.address];
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
            subjectComponentsToInput = [setup.dai.address, curveAmmSetup.mim.address];
          });

          it("should revert", async () => {
            await expect(subject()).to.be.revertedWith("Pool token must be enabled on the Adapter");
          });
        });

        describe("when tokens in is 0", async () => {
          beforeEach(async () => {
            subjectMaxComponentQuantities = [ether(0), ether(0)];
          });

          it("should revert", async () => {
            await expect(subject()).to.be.revertedWith("tokens in must be nonzero");
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
      beforeEach(async () => {
        // Deploy a standard SetToken with the AMM Module
        setToken = await setup.createSetToken(
          [curveAmmSetup.threeCrv.address, curveAmmSetup.mim.address],
          [ether(1), ether(1)],
          [setup.issuanceModule.address, ammModule.address],
        );

        await setup.issuanceModule.initialize(setToken.address, ADDRESS_ZERO);
        await ammModule.initialize(setToken.address);

        await sendTokenToOwner(threeCrvWhale, curveAmmSetup.threeCrv);
        await sendTokenToOwner(mimWhale, curveAmmSetup.mim);

        await curveAmmSetup.threeCrv
          .connect(owner.wallet)
          .approve(curveAmmSetup.mim3CRVFactoryMetapool.address, parseEther("1000"));
        await curveAmmSetup.mim
          .connect(owner.wallet)
          .approve(curveAmmSetup.mim3CRVFactoryMetapool.address, parseEther("1000"));

        // Add some liquidity to haave enough pool Token to issue the first setToken
        await curveAmmSetup.mim3CRVFactoryMetapool
          .connect(owner.wallet)
          ["add_liquidity(uint256[2],uint256,address)"]([0, parseEther("10")], 0, owner.address);

        // Mint some instances of the SetToken
        await setup.approveAndIssueSetToken(setToken, ether(1));
        await setup.integrationRegistry.addIntegration(
          ammModule.address,
          "CURVEMETAPOOLAMMADAPTER",
          curveAmmSetup.curveMetapoolAmmAdapter.address,
        );
      });

      describe.skip("#addLiquiditySingleAsset", async () => {
        let subjectAmmPool: Address;
        let subjectComponent: Address;
        let subjectMaxTokenIn: BigNumber;
        let subjectMinLiquidity: BigNumber;
        let expectedOutputAmount: BigNumber;

        beforeEach(async () => {
          subjectSetToken = setToken.address;
          subjectIntegrationName = "CURVEMETAPOOLAMMADAPTER";
          subjectAmmPool = curveAmmSetup.mim3CRVFactoryMetapool.address;
          subjectMinLiquidity = parseEther("1.021669737060627784"); // min lp-token out
          subjectComponent = curveAmmSetup.threeCrv.address;
          subjectMaxTokenIn = ether(1); // tokens in
          subjectCaller = owner;
          expectedOutputAmount = parseEther("1.021669737060627784");
        });

        async function subject(): Promise<any> {
          return await ammModule.addLiquiditySingleAsset(
            subjectSetToken,
            subjectIntegrationName,
            subjectAmmPool,
            subjectMinLiquidity,
            subjectComponent,
            subjectMaxTokenIn,
          );
        }

        it("should mint the liquidity token to the caller", async () => {
          await subject();
          const liquidityTokenBalance = await curveAmmSetup.mim3CRVFactoryMetapool.balanceOf(subjectSetToken);
          expect(liquidityTokenBalance).to.eq(expectedOutputAmount);
        });

        it("should update the positions properly", async () => {
          await subject();
          const positions = await setToken.getPositions();
          expect(positions.length).to.eq(2);
          expect(positions[0].component.toLowerCase()).to.eq(
            curveAmmSetup.mim.address.toLowerCase(),
          );
          expect(positions[0].unit).to.eq(ether(1));
          expect(positions[1].component.toLowerCase()).to.eq(subjectAmmPool.toLowerCase());
          expect(positions[1].unit).to.eq(expectedOutputAmount);
        });

        describe("when the pool address is invalid", async () => {
          beforeEach(async () => {
            subjectAmmPool = curveAmmSetup.otherPoolToken.address;
          });

          it("should revert", async () => {
            await expect(subject()).to.be.revertedWith("Pool token must be enabled on the Adapter");
          });
        });

        describe("when the _pool doesn't match the _components", async () => {
          beforeEach(async () => {
            subjectComponent = setup.dai.address;
          });

          it("should revert", async () => {
            await expect(subject()).to.be.revertedWith("Pool token must be enabled on the Adapter");
          });
        });

        describe("when tokens in is 0", async () => {
          beforeEach(async () => {
            subjectMaxTokenIn = ZERO;
          });

          it("should revert", async () => {
            await expect(subject()).to.be.revertedWith("Token quantity must be nonzero");
          });
        });

        describe("when the _minLiquidity is 0", async () => {
          beforeEach(async () => {
            subjectMinLiquidity = ZERO;
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
          [curveAmmSetup.poolToken.address],
          [ether(3)],
          [setup.issuanceModule.address, ammModule.address],
        );

        await setup.issuanceModule.initialize(setToken.address, ADDRESS_ZERO);
        await ammModule.initialize(setToken.address);

        await sendTokenToOwner(threeCrvWhale, curveAmmSetup.threeCrv);
        await sendTokenToOwner(mimWhale, curveAmmSetup.mim);

        await curveAmmSetup.threeCrv
          .connect(owner.wallet)
          .approve(curveAmmSetup.mim3CRVFactoryMetapool.address, parseEther("1000"));
        await curveAmmSetup.mim
          .connect(owner.wallet)
          .approve(curveAmmSetup.mim3CRVFactoryMetapool.address, parseEther("1000"));

        // Add some liquidity to have enough pool Token to issue the first setToken
        await curveAmmSetup.mim3CRVFactoryMetapool
          .connect(owner.wallet)
          ["add_liquidity(uint256[2],uint256,address)"]([0, parseEther("10")], 0, owner.address);

        // Mint some instances of the SetToken
        await setup.approveAndIssueSetToken(setToken, ether(1));
        await setup.integrationRegistry.addIntegration(
          ammModule.address,
          "CURVEMETAPOOLAMMADAPTER",
          curveAmmSetup.curveMetapoolAmmAdapter.address,
        );
      });

      describe("#removeLiquidity", async () => {
        let subjectComponentsToOutput: Address[];
        let subjectMinComponentQuantities: BigNumber[];
        let subjectPoolTokens: BigNumber;

        beforeEach(async () => {
          subjectSetToken = setToken.address;
          subjectIntegrationName = "CURVEMETAPOOLAMMADAPTER";
          subjectAmmPool = curveAmmSetup.mim3CRVFactoryMetapool.address;
          subjectPoolTokens = ether(3);
          subjectComponentsToOutput = [curveAmmSetup.mim.address, curveAmmSetup.threeCrv.address];
          subjectMinComponentQuantities = [ether(1), ether(1)];
          subjectCaller = owner;
        });

        async function subject(): Promise<any> {
          return await ammModule
            .connect(subjectCaller.wallet)
            .removeLiquidity(
              subjectSetToken,
              subjectIntegrationName,
              subjectAmmPool,
              subjectPoolTokens,
              subjectComponentsToOutput,
              subjectMinComponentQuantities,
            );
        }

        it("should reduce the liquidity token of the caller", async () => {
          const previousLiquidityTokenBalance = await curveAmmSetup.poolToken.balanceOf(
            subjectSetToken,
          );

          await subject();
          const liquidityTokenBalance = await curveAmmSetup.mim3CRVFactoryMetapool.balanceOf(subjectSetToken);
          const expectedLiquidityBalance = previousLiquidityTokenBalance.sub(subjectPoolTokens);
          expect(liquidityTokenBalance).to.eq(expectedLiquidityBalance);
        });

        it("should update the positions properly", async () => {
          await subject();
          const positions = await setToken.getPositions();

          expect(positions.length).to.eq(2);

          expect(positions[0].component).to.eq(curveAmmSetup.mim.address);
          expect(positions[0].unit).to.eq(ether("1.578853416994208456"));
          expect(positions[1].component).to.eq(curveAmmSetup.threeCrv.address);
          expect(positions[1].unit).to.eq(ether("1.398913505853137426"));
        });

        describe("when the pool address is invalid", async () => {
          beforeEach(async () => {
            const otherUniswapSetup = getUniswapFixture(owner.address);
            await otherUniswapSetup.initialize(
              owner,
              setup.weth.address,
              setup.wbtc.address,
              setup.dai.address,
            );
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

    context("when there is a deployed SetToken with enabled AmmModule", async () => {
      beforeEach(async () => {
        // Deploy a standard SetToken with the AMM Module
        setToken = await setup.createSetToken(
          [curveAmmSetup.poolToken.address],
          [ether(2)],
          [setup.issuanceModule.address, ammModule.address],
        );

        await setup.issuanceModule.initialize(setToken.address, ADDRESS_ZERO);
        await ammModule.initialize(setToken.address);

        await sendTokenToOwner(threeCrvWhale, curveAmmSetup.threeCrv);
        await sendTokenToOwner(mimWhale, curveAmmSetup.mim);

        await curveAmmSetup.threeCrv
          .connect(owner.wallet)
          .approve(curveAmmSetup.mim3CRVFactoryMetapool.address, parseEther("1000"));
        await curveAmmSetup.mim
          .connect(owner.wallet)
          .approve(curveAmmSetup.mim3CRVFactoryMetapool.address, parseEther("1000"));
          await curveAmmSetup.poolToken
          .connect(owner.wallet)
          .approve(curveAmmSetup.mim3CRVFactoryMetapool.address, parseEther("1000"));

        // Add some liquidity to haave enough pool Token to issue the first setToken
        await curveAmmSetup.mim3CRVFactoryMetapool
          .connect(owner.wallet)
          ["add_liquidity(uint256[2],uint256,address)"]([0, parseEther("10")], 0, owner.address);

        // Mint some instances of the SetToken
        await setup.approveAndIssueSetToken(setToken, ether(1));
        await setup.integrationRegistry.addIntegration(
          ammModule.address,
          "CURVEMETAPOOLAMMADAPTER",
          curveAmmSetup.curveMetapoolAmmAdapter.address,
        );
      });

      describe.skip("#removeLiquiditySingleASset", async () => {
        let subjectAmmPool: Address;
        let subjectComponent: Address;
        let subjectMaxTokenIn: BigNumber;
        let subjectMinLiquidity: BigNumber;
        let expectedOutputAmount: BigNumber;

        beforeEach(async () => {
          subjectSetToken = setToken.address;
          subjectIntegrationName = "CURVEMETAPOOLAMMADAPTER";
          subjectAmmPool = curveAmmSetup.mim3CRVFactoryMetapool.address;
          subjectMaxTokenIn = ether(1);
          subjectComponent = curveAmmSetup.threeCrv.address;
          subjectCaller = owner;
          subjectMinLiquidity = ether(1);
          expectedOutputAmount = parseEther("1.021669737060627784");
        });

        async function subject(): Promise<any> {
          return await ammModule.removeLiquiditySingleAsset(
            subjectSetToken,
            subjectIntegrationName,
            subjectAmmPool,
            subjectMinLiquidity,
            subjectComponent,
            subjectMaxTokenIn,
            {gasLimit: 9000000}
          );
        }

        it("should mint the liquidity token to the caller", async () => {
          await subject();
          const liquidityTokenBalance = await curveAmmSetup.mim3CRVFactoryMetapool.balanceOf(subjectSetToken);
          expect(liquidityTokenBalance).to.eq(expectedOutputAmount);
        });

        it("should update the positions properly", async () => {
          await subject();
          const positions = await setToken.getPositions();
          expect(positions.length).to.eq(2);
          expect(positions[0].component.toLowerCase()).to.eq(
            curveAmmSetup.mim.address.toLowerCase(),
          );
          expect(positions[0].unit).to.eq(ether(1));
          expect(positions[1].component.toLowerCase()).to.eq(subjectAmmPool.toLowerCase());
          expect(positions[1].unit).to.eq(expectedOutputAmount);
        });

        describe("when the pool address is invalid", async () => {
          beforeEach(async () => {
            subjectAmmPool = curveAmmSetup.otherPoolToken.address;
          });

          it("should revert", async () => {
            await expect(subject()).to.be.revertedWith("Pool token must be enabled on the Adapter");
          });
        });

        describe("when the _pool doesn't match the _components", async () => {
          beforeEach(async () => {
            subjectComponent = setup.dai.address;
          });

          it("should revert", async () => {
            await expect(subject()).to.be.revertedWith("Pool token must be enabled on the Adapter");
          });
        });

        describe("when tokens in is 0", async () => {
          beforeEach(async () => {
            subjectMaxTokenIn = ZERO;
          });

          it("should revert", async () => {
            await expect(subject()).to.be.revertedWith("Token quantity must be nonzero");
          });
        });

        describe("when the _minLiquidity is 0", async () => {
          beforeEach(async () => {
            subjectMinLiquidity = ZERO;
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
          console.log(
            await curveAmmSetup.curveMetapoolAmmAdapter.isValidPool(subjectAmmPool, [
              curveAmmSetup.threeCrv.address,
            ]),
          );
          await expect(subject()).to.be.revertedWith("Pool token must be enabled on the Adapter");
        });
      });
    }
  });
});
