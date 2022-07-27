import "module-alias/register";

import { network } from "hardhat";
import { BigNumber } from "ethers";
import { ether } from "@utils/index";
import { Account } from "@utils/test/types";
import { Address } from "@utils/types";
import {
  MAX_UINT_256,
  ADDRESS_ZERO,
  ZERO,
} from "@utils/constants";
import { SetToken, AmmModule, ArrakisUniswapV3AmmAdapter } from "@utils/contracts";
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

describe("ArrakisUniswapV3AmmAdapter Integration [ @forked-mainnet ]", () => {
  let owner: Account;
  let deployer: DeployHelper;
  let setup: SystemFixture;
  let uniswapV3Setup: UniswapV3Fixture;
  let arrakisV1Setup: ArrakisV1Fixture;
  let ammModule: AmmModule;
  let arrakisUniswapV3AmmAdapter: ArrakisUniswapV3AmmAdapter;
  let arrakisUniswapV3AmmAdapterName: string;

  before(async () => {
    await network.provider.request({
      method: "hardhat_reset",
      params: [
        {
          forking: {
            jsonRpcUrl: `https://eth-mainnet.alchemyapi.io/v2/${process.env.ALCHEMY_TOKEN}`,
            blockNumber: 15180700,
          },
        },
      ],
    });

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
          [ether(1), ether(2500)],
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
          subjectIntegrationName = arrakisUniswapV3AmmAdapterName;
          subjectAmmPool = arrakisV1Setup.wethDaiPool.address;
          subjectComponentsToInput = [setup.weth.address, setup.dai.address];
          subjectMaxComponentQuantities = [ether(1), ether(2500)];
          subjectCaller = owner;
          const orderedAmount = arrakisV1Setup.getOrderedAmount(
            setup.weth.address,
            setup.dai.address,
            subjectMaxComponentQuantities[0],
            subjectMaxComponentQuantities[1]
          );
          const mintAmounts = await arrakisV1Setup.wethDaiPool.getMintAmounts(
            orderedAmount[0],
            orderedAmount[1]
          );
          subjectMinPoolTokensToMint = mintAmounts[2];
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
          const liquidityTokenBalance = await arrakisV1Setup.wethDaiPool.balanceOf(subjectSetToken);
          expect(liquidityTokenBalance).to.eq(subjectMinPoolTokensToMint);
        });

        it("should update the positions properly", async () => {
          await subject();
          const positions = await setToken.getPositions();
          expect(positions.length).to.eq(3);
          expect(positions[2].component).to.eq(subjectAmmPool);
          expect(positions[2].unit).to.eq(subjectMinPoolTokensToMint);
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
            subjectMaxComponentQuantities = [ether(0.5), ether(1300)];

            const orderedAmount = arrakisV1Setup.getOrderedAmount(
              setup.weth.address,
              setup.dai.address,
              subjectMaxComponentQuantities[0],
              subjectMaxComponentQuantities[1]
            );
            const mintAmounts = await arrakisV1Setup.wethDaiPool.getMintAmounts(
              orderedAmount[0],
              orderedAmount[1]
            );
            if (orderedAmount[2]) {
              wethRemaining = ether(1).sub(mintAmounts[1]);
              daiRemaining = ether(2500).sub(mintAmounts[0]);
            } else {
              wethRemaining = ether(1).sub(mintAmounts[0]);
              daiRemaining = ether(2500).sub(mintAmounts[1]);
            }
            subjectMinPoolTokensToMint = mintAmounts[2];
          });

          it("should mint the correct amount of liquidity tokens to the caller", async () => {
            await subject();
            const liquidityTokenBalance = await arrakisV1Setup.wethDaiPool.balanceOf(subjectSetToken);
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
            subjectMaxComponentQuantities = [ether(0.6), ether(1250)];

            const orderedAmount = arrakisV1Setup.getOrderedAmount(
              setup.weth.address,
              setup.dai.address,
              subjectMaxComponentQuantities[0],
              subjectMaxComponentQuantities[1]
            );
            const mintAmounts = await arrakisV1Setup.wethDaiPool.getMintAmounts(
              orderedAmount[0],
              orderedAmount[1]
            );
            if (orderedAmount[2]) {
              wethRemaining = ether(1).sub(mintAmounts[1]);
              daiRemaining = ether(2500).sub(mintAmounts[0]);
            } else {
              wethRemaining = ether(1).sub(mintAmounts[0]);
              daiRemaining = ether(2500).sub(mintAmounts[1]);
            }
            subjectMinPoolTokensToMint = mintAmounts[2];
          });

          it("should mint the correct amount of liquidity tokens to the caller", async () => {
            await subject();
            const liquidityTokenBalance = await arrakisV1Setup.wethDaiPool.balanceOf(subjectSetToken);
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

        describe("when the pool token is not enabled on Adapter", async () => {
          beforeEach(async () => {
            subjectAmmPool = arrakisV1Setup.wethWbtcPool.address;
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
            subjectMaxComponentQuantities = [ether(0), ether(2500)];
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

      });

    });

    context("when there is a deployed SetToken with enabled AmmModule", async () => {
      before(async () => {
        // Mint some liquidity token
        await setup.weth.connect(owner.wallet)
          .approve(arrakisV1Setup.router.address, MAX_UINT_256);
        await setup.dai.connect(owner.wallet)
          .approve(arrakisV1Setup.router.address, MAX_UINT_256);
        const amountOrdered = arrakisV1Setup.getOrderedAmount(
          setup.weth.address,
          setup.dai.address,
          ether(200),
          ether(500000)
        );
        await arrakisV1Setup.router.connect(owner.wallet).addLiquidity(
          arrakisV1Setup.wethDaiPool.address,
          amountOrdered[0],
          amountOrdered[1],
          ether(0),
          ether(0),
          owner.address
        );

        // Deploy a standard SetToken with the AMM Module
        setToken = await setup.createSetToken(
          [arrakisV1Setup.wethDaiPool.address],
          [ether(50)],
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
          subjectIntegrationName = arrakisUniswapV3AmmAdapterName;
          subjectAmmPool = arrakisV1Setup.wethDaiPool.address;
          subjectComponentsToOutput = [setup.weth.address, setup.dai.address];
          subjectPoolTokens = ether(50);
          subjectMinComponentQuantities = [ether(0.99), ether(2499)]; // slippage check
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
          const previousLiquidityTokenBalance = await arrakisV1Setup.wethDaiPool.balanceOf(subjectSetToken);

          await subject();
          const liquidityTokenBalance = await arrakisV1Setup.wethDaiPool.balanceOf(subjectSetToken);
          const expectedLiquidityBalance = previousLiquidityTokenBalance.sub(subjectPoolTokens);
          expect(liquidityTokenBalance).to.eq(expectedLiquidityBalance);
        });

        it("should update the positions properly", async () => {
          await subject();
          const positions = await setToken.getPositions();

          expect(positions.length).to.eq(2);
          expect(positions[0].component).to.eq(setup.weth.address);
          expect(positions[0].unit).to.be.gt(subjectMinComponentQuantities[0]);
          expect(positions[1].component).to.eq(setup.dai.address);
          expect(positions[1].unit).to.be.gt(subjectMinComponentQuantities[1]);

        });

        describe("when more underlying tokens are requested than owned", async () => {
          beforeEach(async () => {
            subjectMinComponentQuantities = [subjectMinComponentQuantities[0].mul(2),
              subjectMinComponentQuantities[1]];
          });

          it("should revert", async () => {
            await expect(subject()).to.be.revertedWith("received below minimum");
          });
        });

        describe("when the pool address is invalid", async () => {
          beforeEach(async () => {
            subjectAmmPool = arrakisV1Setup.wethWbtcPool.address;
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
            subjectMinComponentQuantities = [ether(0), ether(2499)];
          });

          it("should revert", async () => {
            await expect(subject()).to.be.revertedWith("Component quantity must be nonzero");
          });
        });

        describe("when the _minTokensOut[1] is 0", async () => {
          beforeEach(async () => {
            subjectMinComponentQuantities = [ether(0.99), ether(0)];
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

      });

    });
  });

});
