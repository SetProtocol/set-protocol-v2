import "module-alias/register";

import { Address } from "@utils/types";
import { Account } from "@utils/test/types";
import { AmmModule, StandardTokenMock } from "@utils/contracts";
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
import { CurveTwoPoolStableswapMock__factory } from "../../../../typechain/factories/CurveTwoPoolStableswapMock__factory";
import { IERC20__factory } from "../../../../typechain/factories/IERC20__factory";
import { ICurveMinter__factory } from "../../../../typechain/factories/ICurveMinter__factory";
import { ethers } from "hardhat";

const expect = getWaffleExpect();

describe("CurveAmmAdapter", () => {
  let owner: Account;
  let liquidityProvider: Account;
  let deployer: DeployHelper;
  let setup: SystemFixture;
  let ammModule: AmmModule;

  const coins: StandardTokenMock[] = [];
  const coinAddresses: Address[] = [];
  let poolToken: IERC20;
  let poolMinter: ICurveMinter;
  let isCurveV1: boolean;
  let coinCount: number;
  let poolTokenAddress: Address;
  let poolMinterAddress: Address;

  let curveAmmAdapter: CurveAmmAdapter;
  let curveAmmAdapterName: string;

  const getReserves = async (): Promise<BigNumber[]> => {
    const reserves: BigNumber[] = [];
    for (let i = 0; i < coinCount; i++) {
      reserves.push(await poolMinter.balances(i));
    }
    return reserves;
  };

  before(async () => {
    [owner, liquidityProvider] = await getAccounts();

    deployer = new DeployHelper(owner.wallet);
    setup = getSystemFixture(owner.address);
    await setup.initialize();

    ammModule = await deployer.modules.deployAmmModule(setup.controller.address);
    await setup.controller.addModule(ammModule.address);

    isCurveV1 = true;
    coinCount = 2;
    // deploy mocked coins for Curve Pool
    for (let i = 0; i < coinCount; i++) {
      coins.push(await deployer.mocks.deployTokenMock(owner.address, 0, 18));
      coinAddresses.push(coins[i].address);
      await coins[i].mint(liquidityProvider.address, ethers.utils.parseUnits("100"));
      await coins[i].mint(owner.address, ethers.utils.parseUnits("10"));
    }

    // deployed mocked Curve Pool
    const curvePool = await new CurveTwoPoolStableswapMock__factory(
      owner.wallet,
    ).deploy("Curve.fi Pool ERC20", "CPE", [coinAddresses[0], coinAddresses[1]]);

    poolToken = IERC20__factory.connect(curvePool.address, owner.wallet);
    poolMinter = ICurveMinter__factory.connect(curvePool.address, owner.wallet);

    poolTokenAddress = poolToken.address;
    poolMinterAddress = poolMinter.address;

    // provide liquidity
    for (let i = 0; i < coinCount; i++) {
      await coins[i]
        .connect(liquidityProvider.wallet)
        .approve(poolMinter.address, ethers.utils.parseUnits("100"));
    }
    await poolMinter
      .connect(liquidityProvider.wallet)
      ["add_liquidity(uint256[2],uint256)"](
        [ethers.utils.parseUnits("100"), ethers.utils.parseUnits("100")],
        0,
        {
          gasLimit: "10000000",
        },
      );
    await poolToken.connect(liquidityProvider.wallet).transfer(owner.address, ether(10));

    // deploy CurveAmmAdapter
    curveAmmAdapter = await deployer.adapters.deployCurveAmmAdapter(
      poolTokenAddress,
      poolMinterAddress,
      isCurveV1,
      coinCount,
    );
    curveAmmAdapterName = "CURVEAMM";

    // add integraion
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
        expect(await curveAmmAdapter.isValidPool(poolTokenAddress, [coinAddresses[i]])).to.eq(true);
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
      reserves = await getReserves();
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
      reserves = await getReserves();
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
      reserves = await getReserves();
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
      reserves = await getReserves();
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
      reserves = await getReserves();

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

    it("should revert if zero liquidity", async () => {
      subjectLiquidity = BigNumber.from(0);
      await expect(subject()).to.revertedWith("invalid liquidity");
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
      subjectMinTokenOut = BigNumber.from(1);
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

    it("should revert if zero liquidity", async () => {
      subjectLiquidity = BigNumber.from(0);
      await expect(subject()).to.revertedWith("invalid liquidity");
    });

    it("should revert if invalid coinIndex", async () => {
      subjectCoinIndex = 4;
      await expect(subject()).to.revertedWith("invalid coin index");
    });

    it("should revert if zero min token out", async () => {
      subjectMinTokenOut = BigNumber.from(0);
      await expect(subject()).to.revertedWith("invalid min token out");
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
