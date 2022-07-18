import "module-alias/register";

import { ethers, network } from "hardhat";
import { Address } from "@utils/types";
import { Account } from "@utils/test/types";
import { AmmModule } from "@utils/contracts";
import DeployHelper from "@utils/deploys";
import {
  addSnapshotBeforeRestoreAfterEach,
  getAccounts,
  getSystemFixture,
  getWaffleExpect,
} from "@utils/test/index";
import { ether } from "@utils/index";
import { SystemFixture } from "@utils/fixtures";
import { ADDRESS_ZERO, ZERO } from "@utils/constants";
import { BigNumber } from "ethers";
import { CurveAmmAdapter } from "../../../../typechain/CurveAmmAdapter";
import { ICurveMinter } from "../../../../typechain/ICurveMinter";
import { IERC20 } from "../../../../typechain/IERC20";
import { ICurveMinter__factory } from "../../../../typechain/factories/ICurveMinter__factory";
import { IERC20__factory } from "../../../../typechain/factories/IERC20__factory";

const expect = getWaffleExpect();

const getTokenFromWhale = async (
  token: IERC20,
  whaleAddress: Address,
  recipient: Account,
  amount: BigNumber,
) => {
  expect(amount).to.gt(0);

  await network.provider.request({
    method: "hardhat_impersonateAccount",
    params: [whaleAddress],
  });
  await recipient.wallet.sendTransaction({
    from: recipient.address,
    to: whaleAddress,
    value: ether("0.1"),
  });
  const whale = await ethers.getSigner(whaleAddress);
  await token.connect(whale).transfer(recipient.address, amount);
};

const getReserves = async (poolMinter: ICurveMinter, coinCount: number): Promise<BigNumber[]> => {
  const balances = [];
  for (let i = 0; i < coinCount; i++) {
    balances.push(await poolMinter.balances(i));
  }
  return balances;
};

describe("CurveAmmAdapter [ @forked-mainnet ]", () => {
  let owner: Account;
  let deployer: DeployHelper;
  let setup: SystemFixture;
  let ammModule: AmmModule;

  before(async () => {
    await network.provider.request({
      method: "hardhat_reset",
      params: [
        {
          forking: {
            jsonRpcUrl: `https://eth-mainnet.alchemyapi.io/v2/${process.env.ALCHEMY_TOKEN}`,
            blockNumber: 15118000,
          },
        },
      ],
    });

    [owner] = await getAccounts();

    deployer = new DeployHelper(owner.wallet);
    setup = getSystemFixture(owner.address);
    await setup.initialize();

    ammModule = await deployer.modules.deployAmmModule(setup.controller.address);
    await setup.controller.addModule(ammModule.address);
  });

  after(async () => {
    await network.provider.request({
      method: "hardhat_reset",
      params: [],
    });
  });

  const runTestScenarioForCurveLP = ({
    scenarioName,
    poolTokenAddress,
    poolMinterAddress,
    isCurveV1,
    coinCount,
    coinAddresses,
    poolTokenWhale,
    coinWhales,
  }: {
    scenarioName: string;
    poolTokenAddress: Address;
    poolMinterAddress: Address;
    isCurveV1: boolean;
    coinCount: number;
    coinAddresses: Address[];
    poolTokenWhale: Address;
    coinWhales: Address[];
  }) => {
    describe(scenarioName, () => {
      const coins: IERC20[] = [];
      let poolToken: IERC20;
      let poolMinter: ICurveMinter;
      let curveAmmAdapter: CurveAmmAdapter;
      let curveAmmAdapterName: string;

      before(async () => {
        poolMinter = await ICurveMinter__factory.connect(poolMinterAddress, owner.wallet);

        poolToken = await IERC20__factory.connect(poolTokenAddress, owner.wallet);
        await getTokenFromWhale(
          poolToken,
          poolTokenWhale,
          owner,
          await poolToken.balanceOf(poolTokenWhale),
        );
        for (let i = 0; i < coinCount; i++) {
          coins.push(await IERC20__factory.connect(coinAddresses[i], owner.wallet));

          await getTokenFromWhale(
            coins[i],
            coinWhales[i],
            owner,
            await coins[i].balanceOf(coinWhales[i]),
          );
        }

        curveAmmAdapter = await deployer.adapters.deployCurveAmmAdapter(
          poolTokenAddress,
          poolMinterAddress,
          isCurveV1,
          coinCount,
        );
        curveAmmAdapterName = "CURVEAMM" + scenarioName;

        await setup.integrationRegistry.addIntegration(
          ammModule.address,
          curveAmmAdapterName,
          curveAmmAdapter.address,
        );
      });

      addSnapshotBeforeRestoreAfterEach();

      describe("#constructor", () => {
        it("should have correct pool poolToken address", async () => {
          expect(await curveAmmAdapter.poolToken()).to.eq(poolTokenAddress);
        });

        it("should have correct pool poolMinter address", async () => {
          expect(await curveAmmAdapter.poolMinter()).to.eq(poolMinterAddress);
        });

        it("should have correct flag for Curve v1/v2", async () => {
          expect(await curveAmmAdapter.isCurveV1()).to.eq(isCurveV1);
        });

        it("should have correct coins count", async () => {
          expect(await curveAmmAdapter.coinCount()).to.eq(coinCount);
        });

        it("should have correct coins", async () => {
          for (let i = 0; i < coinCount; i++) {
            expect(await curveAmmAdapter.coins(i)).to.eq(coinAddresses[i]);
          }
        });

        it("should have correct coin indexes", async () => {
          for (let i = 0; i < coinCount; i++) {
            expect(await curveAmmAdapter.coinIndex(coinAddresses[i])).to.eq(i + 1);
          }
        });
      });

      describe("#getSpenderAddress", () => {
        it("should return the correct spender address", async () => {
          expect(await curveAmmAdapter.getSpenderAddress(poolTokenAddress)).to.eq(
            curveAmmAdapter.address,
          );
        });
      });

      describe("#isValidPool", () => {
        it("should return false if invalid pool address", async () => {
          expect(await curveAmmAdapter.isValidPool(ADDRESS_ZERO, [])).to.eq(false);
        });

        it("should return false if components count doesnt match", async () => {
          expect(await curveAmmAdapter.isValidPool(poolTokenAddress, [])).to.eq(false);
          expect(await curveAmmAdapter.isValidPool(poolTokenAddress, [ADDRESS_ZERO])).to.eq(false);
        });

        it("should return false if components address doesn't match", async () => {
          let components = [...coinAddresses];
          components[0] = ADDRESS_ZERO;
          expect(await curveAmmAdapter.isValidPool(poolTokenAddress, components)).to.eq(false);

          components = [...coinAddresses];
          components[1] = ADDRESS_ZERO;
          expect(await curveAmmAdapter.isValidPool(poolTokenAddress, components)).to.eq(false);
        });

        it("should return true if correct pool & components address", async () => {
          // addLiquidity / removeLiquidity
          expect(await curveAmmAdapter.isValidPool(poolTokenAddress, coinAddresses)).to.eq(true);
          // removeLiquiditySingleAsset
          for (let i = 0; i < coinCount; i++) {
            expect(await curveAmmAdapter.isValidPool(poolTokenAddress, [coinAddresses[i]])).to.eq(
              true,
            );
          }
        });
      });

      describe("#getProvideLiquidityCalldata", () => {
        let subjectAmmPool: Address;
        let subjectComponents: Address[];
        let subjectMaxTokensIn: BigNumber[];
        let subjectMinLiquidity: BigNumber;
        let reserves: BigNumber[];
        let totalSupply: BigNumber;

        beforeEach(async () => {
          reserves = await getReserves(poolMinter, coinCount);
          totalSupply = await poolToken.totalSupply();

          subjectAmmPool = poolTokenAddress;
          subjectComponents = coinAddresses;
          subjectMaxTokensIn = reserves.map(balance => balance.div(100));
          subjectMinLiquidity = totalSupply.div(100);
        });

        const subject = async () => {
          return await curveAmmAdapter.getProvideLiquidityCalldata(
            owner.address,
            subjectAmmPool,
            subjectComponents,
            subjectMaxTokensIn,
            subjectMinLiquidity,
          );
        };

        it("should return the correct provide liquidity calldata", async () => {
          const calldata = await subject();

          const expectedCallData = curveAmmAdapter.interface.encodeFunctionData("addLiquidity", [
            poolTokenAddress,
            subjectMaxTokensIn,
            subjectMinLiquidity,
            owner.address,
          ]);

          expect(JSON.stringify(calldata)).to.eq(
            JSON.stringify([curveAmmAdapter.address, ZERO, expectedCallData]),
          );
        });

        it("should revert if invalid pool address", async () => {
          subjectAmmPool = ADDRESS_ZERO;
          await expect(subject()).to.revertedWith("invalid pool address");
        });

        it("should revert if amounts length doesn't match", async () => {
          subjectMaxTokensIn = [];
          await expect(subject()).to.revertedWith("invalid amounts");
        });
      });

      describe("#getProvideLiquiditySingleAssetCalldata", () => {
        let subjectAmmPool: Address;
        let subjectComponent: Address;
        let subjectMaxTokenIn: BigNumber;
        let subjectMinLiquidity: BigNumber;
        let reserves: BigNumber[];
        let totalSupply: BigNumber;

        beforeEach(async () => {
          reserves = await getReserves(poolMinter, coinCount);
          totalSupply = await poolToken.totalSupply();

          subjectAmmPool = poolTokenAddress;
          subjectComponent = coinAddresses[1];
          subjectMaxTokenIn = reserves[1].div(100);
          subjectMinLiquidity = totalSupply.div(100);
        });

        const subject = async () => {
          return await curveAmmAdapter.getProvideLiquiditySingleAssetCalldata(
            owner.address,
            subjectAmmPool,
            subjectComponent,
            subjectMaxTokenIn,
            subjectMinLiquidity,
          );
        };

        it("should return the correct provide liquidity calldata", async () => {
          const calldata = await subject();

          const amountsIn = Array(coinCount).fill(0);
          amountsIn[1] = subjectMaxTokenIn;
          const expectedCallData = curveAmmAdapter.interface.encodeFunctionData("addLiquidity", [
            poolTokenAddress,
            amountsIn,
            subjectMinLiquidity,
            owner.address,
          ]);

          expect(JSON.stringify(calldata)).to.eq(
            JSON.stringify([curveAmmAdapter.address, ZERO, expectedCallData]),
          );
        });

        it("should revert if invalid pool address", async () => {
          subjectAmmPool = ADDRESS_ZERO;
          await expect(subject()).to.revertedWith("invalid pool address");
        });

        it("should revert if invalid component token", async () => {
          subjectComponent = ADDRESS_ZERO;
          await expect(subject()).to.revertedWith("invalid component token");
        });

        it("should revert if invalid component amount", async () => {
          subjectMaxTokenIn = BigNumber.from(0);
          await expect(subject()).to.revertedWith("invalid component amount");
        });
      });

      describe("#getRemoveLiquidityCalldata", () => {
        let subjectAmmPool: Address;
        let subjectComponents: Address[];
        let subjectMinTokensOut: BigNumber[];
        let subjectLiquidity: BigNumber;
        let reserves: BigNumber[];
        let totalSupply: BigNumber;

        beforeEach(async () => {
          reserves = await getReserves(poolMinter, coinCount);
          totalSupply = await poolToken.totalSupply();

          subjectAmmPool = poolTokenAddress;
          subjectComponents = coinAddresses;
          subjectLiquidity = await poolToken.balanceOf(owner.address);
          subjectMinTokensOut = reserves.map(balance =>
            balance.mul(subjectLiquidity).div(totalSupply),
          );
        });

        const subject = async () => {
          return await curveAmmAdapter.getRemoveLiquidityCalldata(
            owner.address,
            subjectAmmPool,
            subjectComponents,
            subjectMinTokensOut,
            subjectLiquidity,
          );
        };

        it("should return the correct provide liquidity calldata", async () => {
          const calldata = await subject();

          const expectedCallData = curveAmmAdapter.interface.encodeFunctionData("removeLiquidity", [
            poolTokenAddress,
            subjectLiquidity,
            subjectMinTokensOut,
            owner.address,
          ]);

          expect(JSON.stringify(calldata)).to.eq(
            JSON.stringify([curveAmmAdapter.address, ZERO, expectedCallData]),
          );
        });

        it("should revert if invalid pool address", async () => {
          subjectAmmPool = ADDRESS_ZERO;
          await expect(subject()).to.revertedWith("invalid pool address");
        });

        it("should revert if poolToken amounts length doesn't match", async () => {
          subjectMinTokensOut = [];
          await expect(subject()).to.revertedWith("invalid amounts");
        });

        it("should revert if liquidity is more than the balance", async () => {
          subjectLiquidity = subjectLiquidity.add(1);
          await expect(subject()).to.revertedWith("_liquidity must be <= to current balance");
        });

        it("should revert if poolToken amounts is more than the liquidity", async () => {
          subjectMinTokensOut[1] = subjectMinTokensOut[1].mul(2);
          await expect(subject()).to.revertedWith("amounts must be <= ownedTokens");
        });
      });

      describe("#getRemoveLiquiditySingleAssetCalldata", () => {
        let subjectAmmPool: Address;
        let subjectComponent: Address;
        let subjectMinTokenOut: BigNumber;
        let subjectLiquidity: BigNumber;
        let reserves: BigNumber[];
        let totalSupply: BigNumber;

        beforeEach(async () => {
          reserves = await getReserves(poolMinter, coinCount);
          totalSupply = await poolToken.totalSupply();

          subjectAmmPool = poolTokenAddress;
          subjectComponent = coinAddresses[1];
          subjectLiquidity = await poolToken.balanceOf(owner.address);
          subjectMinTokenOut = reserves[1].mul(subjectLiquidity).div(totalSupply);
        });

        const subject = async () => {
          return await curveAmmAdapter.getRemoveLiquiditySingleAssetCalldata(
            owner.address,
            subjectAmmPool,
            subjectComponent,
            subjectMinTokenOut,
            subjectLiquidity,
          );
        };

        it("should return the correct provide liquidity calldata", async () => {
          const calldata = await subject();

          const expectedCallData = curveAmmAdapter.interface.encodeFunctionData(
            "removeLiquidityOneCoin",
            [poolTokenAddress, subjectLiquidity, 1, subjectMinTokenOut, owner.address],
          );

          expect(JSON.stringify(calldata)).to.eq(
            JSON.stringify([curveAmmAdapter.address, ZERO, expectedCallData]),
          );
        });

        it("should revert if invalid pool address", async () => {
          subjectAmmPool = ADDRESS_ZERO;
          await expect(subject()).to.revertedWith("invalid pool address");
        });

        it("should revert if invalid component token", async () => {
          subjectComponent = ADDRESS_ZERO;
          await expect(subject()).to.revertedWith("invalid component token");
        });

        it("should revert if liquidity is more than the balance", async () => {
          subjectLiquidity = subjectLiquidity.add(1);
          await expect(subject()).to.revertedWith("_liquidity must be <= to current balance");
        });
      });

      describe("#addLiquidity", () => {
        let subjectAmmPool: Address;
        let subjectMaxTokensIn: BigNumber[];
        let subjectMinLiquidity: BigNumber;
        let subjectDestination: Address;
        let reserves: BigNumber[];

        beforeEach(async () => {
          reserves = await getReserves(poolMinter, coinCount);

          subjectAmmPool = poolTokenAddress;
          subjectMaxTokensIn = reserves.map(balance => balance.div(100));
          subjectMinLiquidity = BigNumber.from(1);
          subjectDestination = owner.address;

          for (let i = 0; i < coinCount; i++) {
            await coins[i].approve(curveAmmAdapter.address, subjectMaxTokensIn[i]);
          }
        });

        const subject = async () => {
          return await curveAmmAdapter.addLiquidity(
            subjectAmmPool,
            subjectMaxTokensIn,
            subjectMinLiquidity,
            subjectDestination,
          );
        };

        it("should revert if invalid pool address", async () => {
          subjectAmmPool = ADDRESS_ZERO;
          await expect(subject()).to.revertedWith("invalid pool address");
        });

        it("should revert if amounts length doesn't match", async () => {
          subjectMaxTokensIn = [];
          await expect(subject()).to.revertedWith("invalid amounts");
        });

        it("should revert if amounts are all zero", async () => {
          subjectMaxTokensIn = subjectMaxTokensIn.map(() => BigNumber.from("0"));
          await expect(subject()).to.revertedWith("invalid amounts");
        });

        it("should revert if zero min liquidity", async () => {
          subjectMinLiquidity = BigNumber.from("0");
          await expect(subject()).to.revertedWith("invalid min liquidity");
        });

        it("should revert if destinatination address is zero", async () => {
          subjectDestination = ADDRESS_ZERO;
          await expect(subject()).to.revertedWith("invalid destination");
        });

        it("should add liquidity and get LP token", async () => {
          const liquidityBefore = await poolToken.balanceOf(owner.address);
          const coinBalancesBefore = [];
          for (let i = 0; i < coinCount; i++) {
            coinBalancesBefore[i] = await coins[i].balanceOf(owner.address);
          }

          await subject();

          expect(await poolToken.balanceOf(owner.address)).to.gt(liquidityBefore);
          for (let i = 0; i < coinCount; i++) {
            expect(await coins[i].balanceOf(owner.address)).to.lt(coinBalancesBefore[i]);
          }

          // no tokens remain after transfer
          expect(await poolToken.balanceOf(curveAmmAdapter.address)).to.equal(0);
          for (let i = 0; i < coinCount; i++) {
            expect(await coins[i].balanceOf(curveAmmAdapter.address)).to.equal(0);
          }
        });
      });

      describe("#removeLiquidity", () => {
        let subjectAmmPool: Address;
        let subjectLiquidity: BigNumber;
        let subjectMinAmountsOut: BigNumber[];
        let subjectDestination: Address;

        beforeEach(async () => {
          subjectAmmPool = poolTokenAddress;
          subjectMinAmountsOut = Array(coinCount).fill(0);
          subjectLiquidity = await poolToken.balanceOf(owner.address);
          subjectDestination = owner.address;

          await poolToken.approve(curveAmmAdapter.address, subjectLiquidity);
        });

        const subject = async () => {
          return await curveAmmAdapter.removeLiquidity(
            subjectAmmPool,
            subjectLiquidity,
            subjectMinAmountsOut,
            subjectDestination,
          );
        };

        it("should revert if invalid pool address", async () => {
          subjectAmmPool = ADDRESS_ZERO;
          await expect(subject()).to.revertedWith("invalid pool address");
        });

        it("should revert if amounts length doesn't match", async () => {
          subjectMinAmountsOut = [];
          await expect(subject()).to.revertedWith("invalid amounts");
        });

        it("should revert if destinatination address is zero", async () => {
          subjectDestination = ADDRESS_ZERO;
          await expect(subject()).to.revertedWith("invalid destination");
        });

        it("should remove liquidity and get expect coins", async () => {
          const liquidityBefore = await poolToken.balanceOf(owner.address);
          const coinBalancesBefore = [];
          for (let i = 0; i < coinCount; i++) {
            coinBalancesBefore[i] = await coins[i].balanceOf(owner.address);
          }

          await subject();

          expect(await poolToken.balanceOf(owner.address)).to.lt(liquidityBefore);
          for (let i = 0; i < coinCount; i++) {
            expect(await coins[i].balanceOf(owner.address)).to.gt(coinBalancesBefore[i]);
          }

          // no tokens remain after transfer
          expect(await poolToken.balanceOf(curveAmmAdapter.address)).to.equal(0);
          for (let i = 0; i < coinCount; i++) {
            expect(await coins[i].balanceOf(curveAmmAdapter.address)).to.equal(0);
          }
        });
      });

      describe("#removeLiquidityOneCoin", () => {
        let subjectAmmPool: Address;
        let subjectLiquidity: BigNumber;
        let subjectCoinIndex: number;
        let subjectMinTokenOut: BigNumber;
        let subjectDestination: Address;

        beforeEach(async () => {
          subjectAmmPool = poolTokenAddress;
          subjectLiquidity = await poolToken.balanceOf(owner.address);
          subjectCoinIndex = 1;
          subjectMinTokenOut = BigNumber.from(0);
          subjectDestination = owner.address;

          await poolToken.approve(curveAmmAdapter.address, subjectLiquidity);
        });

        const subject = async () => {
          return await curveAmmAdapter.removeLiquidityOneCoin(
            subjectAmmPool,
            subjectLiquidity,
            subjectCoinIndex,
            subjectMinTokenOut,
            subjectDestination,
          );
        };

        it("should revert if invalid pool address", async () => {
          subjectAmmPool = ADDRESS_ZERO;
          await expect(subject()).to.revertedWith("invalid pool address");
        });

        it("should revert if destinatination address is zero", async () => {
          subjectDestination = ADDRESS_ZERO;
          await expect(subject()).to.revertedWith("invalid destination");
        });

        it("should remove liquidity and get exact one token out", async () => {
          const liquidityBefore = await poolToken.balanceOf(owner.address);
          const coinBalancesBefore = [];
          for (let i = 0; i < coinCount; i++) {
            coinBalancesBefore[i] = await coins[i].balanceOf(owner.address);
          }

          await subject();

          expect(await poolToken.balanceOf(owner.address)).to.lt(liquidityBefore);
          for (let i = 0; i < coinCount; i++) {
            if (i === subjectCoinIndex) {
              expect(await coins[i].balanceOf(owner.address)).to.gt(coinBalancesBefore[i]);
            } else {
              expect(await coins[i].balanceOf(owner.address)).to.eq(coinBalancesBefore[i]);
            }
          }

          // no tokens remain after transfer
          expect(await poolToken.balanceOf(curveAmmAdapter.address)).to.equal(0);
          for (let i = 0; i < coinCount; i++) {
            expect(await coins[i].balanceOf(curveAmmAdapter.address)).to.equal(0);
          }
        });
      });
    });
  };

  const testScenarios = [
    {
      scenarioName: "Curve LP with 2 coins (v1) - MIM/3CRV",
      poolTokenAddress: "0x5a6A4D54456819380173272A5E8E9B9904BdF41B",
      poolMinterAddress: "0x5a6A4D54456819380173272A5E8E9B9904BdF41B",
      isCurveV1: true,
      coinCount: 2,
      coinAddresses: [
        "0x99D8a9C45b2ecA8864373A26D1459e3Dff1e17F3", // MIM
        "0x6c3F90f043a72FA612cbac8115EE7e52BDe6E490", // 3CRV
      ],
      poolTokenWhale: "0x11B49699aa0462a0488d93aEFdE435D4D6608469", // Curve MIM/3CRV whale
      coinWhales: [
        "0x4240781A9ebDB2EB14a183466E8820978b7DA4e2", // MIM whale
        "0x5438649eE5B0150B2cd218004aA324075e2f292C", // 3CRV whale
      ],
    },
    {
      scenarioName: "Curve LP with 3 coins (v2) - USDT/WBTC/WETH",
      poolTokenAddress: "0xc4AD29ba4B3c580e6D59105FFf484999997675Ff",
      poolMinterAddress: "0xD51a44d3FaE010294C616388b506AcdA1bfAAE46",
      isCurveV1: false,
      coinCount: 3,
      coinAddresses: [
        "0xdAC17F958D2ee523a2206206994597C13D831ec7", // USDT
        "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599", // WBTC
        "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2", // WETH
      ],
      poolTokenWhale: "0xfE4d9D4F102b40193EeD8aA6C52BD87a328177fc", // Curve USDT/WBTC/WETH whale
      coinWhales: [
        "0x5a52E96BAcdaBb82fd05763E25335261B270Efcb", // USDT whale
        "0xf584F8728B874a6a5c7A8d4d387C9aae9172D621", // WBTC whale
        "0x06920C9fC643De77B99cB7670A944AD31eaAA260", // WETH whale
      ],
    },
  ];

  testScenarios.forEach(scenario => runTestScenarioForCurveLP(scenario));
});
