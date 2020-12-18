import "module-alias/register";
import { BigNumber } from "ethers/utils";

import { Address, Account } from "@utils/types";
import { UniswapPairPriceAdapter } from "@utils/contracts";
import { ADDRESS_ZERO, MAX_UINT_256, ZERO } from "@utils/constants";
import DeployHelper from "@utils/deploys";
import {
  bitcoin,
  ether,
  getAccounts,
  getSystemFixture,
  getWaffleExpect,
  getUniswapFixture,
  preciseDiv,
  preciseMul,
} from "@utils/index";
import { SystemFixture, UniswapFixture } from "@utils/fixtures";

const expect = getWaffleExpect();

describe("UniswapPairPriceAdapter", () => {
  let owner: Account;
  let attacker: Account;

  let deployer: DeployHelper;
  let setup: SystemFixture;
  let uniswapSetup: UniswapFixture;

  let uniswapPriceAdapter: UniswapPairPriceAdapter;

  before(async () => {
    [
      owner,
      attacker,
    ] = await getAccounts();

    deployer = new DeployHelper(owner.wallet);
    setup = getSystemFixture(owner.address);
    uniswapSetup = getUniswapFixture(owner.address);

    await setup.initialize();
    await uniswapSetup.initialize(
      owner,
      setup.weth.address,
      setup.wbtc.address,
      setup.dai.address
    );

    // Add owner as module to read prices
    await setup.controller.addModule(owner.address);

    uniswapPriceAdapter = await deployer.adapters.deployUniswapPairPriceAdapter(
      setup.controller.address,
      uniswapSetup.factory.address,
      [uniswapSetup.wethDaiPool.address, uniswapSetup.wethWbtcPool.address]
    );

    await setup.controller.addResource(uniswapPriceAdapter.address, new BigNumber(3));
    await setup.priceOracle.addAdapter(uniswapPriceAdapter.address);

    // Approve and add liquidity to pools
    await setup.weth.approve(uniswapSetup.router.address, MAX_UINT_256);
    await setup.wbtc.approve(uniswapSetup.router.address, MAX_UINT_256);
    await setup.dai.approve(uniswapSetup.router.address, MAX_UINT_256);
    await uniswapSetup.router.addLiquidity(
      setup.weth.address,
      setup.wbtc.address,
      ether(40),
      bitcoin(1),
      ether(40),
      bitcoin(1),
      owner.address,
      MAX_UINT_256
    );

    await uniswapSetup.router.addLiquidity(
      setup.weth.address,
      setup.dai.address,
      ether(10),
      ether(2300),
      ether(10),
      ether(2300),
      owner.address,
      MAX_UINT_256
    );
  });

  describe("constructor", async () => {
    let subjectController: Address;
    let subjectUniswapFactory: Address;
    let subjectUniswapPools: Address[];

    beforeEach(async () => {
      subjectController = setup.controller.address;
      subjectUniswapPools = [uniswapSetup.wethDaiPool.address, uniswapSetup.wethWbtcPool.address];
      subjectUniswapFactory = uniswapSetup.factory.address;
    });

    async function subject(): Promise<UniswapPairPriceAdapter> {
      return deployer.adapters.deployUniswapPairPriceAdapter(
        subjectController,
        subjectUniswapFactory,
        subjectUniswapPools
      );
    }

    it("should have the correct controller address", async () => {
      const priceAdapter = await subject();

      const actualController = await priceAdapter.controller();
      expect(actualController).to.eq(subjectController);
    });

    it("should have the correct Uniswap pools array", async () => {
      const priceAdapter = await subject();

      const actualAllowedPools = await priceAdapter.getAllowedUniswapPools();
      expect(JSON.stringify(actualAllowedPools)).to.eq(JSON.stringify(subjectUniswapPools));
    });

    it("should have the correct Uniswap pool 1 settings", async () => {
      const priceAdapter = await subject();

      const actualWethDaiPoolSettings = await priceAdapter.uniswapPoolsToSettings(subjectUniswapPools[0]);

      const [expectedTokenOne, expectedTokenTwo] = uniswapSetup.getTokenOrder(
        setup.weth.address,
        setup.dai.address
      );

      expect(actualWethDaiPoolSettings.tokenOne).to.eq(expectedTokenOne);
      expect(actualWethDaiPoolSettings.tokenTwo).to.eq(expectedTokenTwo);
      expect(actualWethDaiPoolSettings.tokenOneBaseUnit).to.eq(ether(1));
      expect(actualWethDaiPoolSettings.tokenOneBaseUnit).to.eq(ether(1));
      expect(actualWethDaiPoolSettings.isValid).to.eq(true);
    });

    it("should have the correct Uniswap pool 2 settings", async () => {
      const priceAdapter = await subject();

      const actualWethWbtcPoolSettings = await priceAdapter.uniswapPoolsToSettings(subjectUniswapPools[1]);

      const [expectedTokenOne, expectedTokenTwo] = uniswapSetup.getTokenOrder(
        setup.weth.address,
        setup.wbtc.address
      );
      const expectedTokenOneBaseUnit = expectedTokenOne === setup.weth.address ? ether(1) : bitcoin(1);
      const expectedTokenTwoBaseUnit = expectedTokenTwo === setup.weth.address ? ether(1) : bitcoin(1);

      expect(actualWethWbtcPoolSettings.tokenOne).to.eq(expectedTokenOne);
      expect(actualWethWbtcPoolSettings.tokenTwo).to.eq(expectedTokenTwo);
      expect(actualWethWbtcPoolSettings.tokenOneBaseUnit).to.eq(expectedTokenOneBaseUnit);
      expect(actualWethWbtcPoolSettings.tokenTwoBaseUnit).to.eq(expectedTokenTwoBaseUnit);
      expect(actualWethWbtcPoolSettings.isValid).to.eq(true);
    });

    it("should have the correct Uniswap factory address", async () => {
      const priceAdapter = await subject();

      const actualFactory = await priceAdapter.uniswapFactory();
      expect(actualFactory).to.eq(subjectUniswapFactory);
    });

    describe("when passed uniswap pool address is not unique", async () => {
      beforeEach(async () => {
        subjectUniswapPools = [uniswapSetup.wethDaiPool.address, uniswapSetup.wethDaiPool .address];
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Uniswap pool address must be unique.");
      });
    });
  });

  describe("#getPrice", async () => {
    let subjectAssetOne: Address;
    let subjectAssetTwo: Address;
    let subjectCaller: Account;

    context("when a Uniswap pool is the base asset", async () => {
      beforeEach(async () => {
        subjectAssetOne = uniswapSetup.wethDaiPool.address;
        subjectAssetTwo = setup.usdc.address;
        subjectCaller = owner;
      });

      async function subject(): Promise<any> {
        uniswapPriceAdapter = uniswapPriceAdapter.connect(subjectCaller.wallet);
        return uniswapPriceAdapter.getPrice(
          subjectAssetOne,
          subjectAssetTwo
        );
      }

      it("should return the price", async () => {
        const returnedValue = await subject();

        // Get oracle prices
        const ethUsdPrice = await setup.ETH_USD_Oracle.read();
        const daiUsdPrice = await setup.DAI_USD_Oracle.read();
        const usdUsdPrice = await setup.USD_USD_Oracle.read();

        // Get uniswap reserve info
        const wethReserves = await setup.weth.balanceOf(uniswapSetup.wethDaiPool.address);
        const daiReserves = await setup.dai.balanceOf(uniswapSetup.wethDaiPool.address);
        const poolTotalSupply = await uniswapSetup.wethDaiPool.totalSupply();
        const wethBaseUnits = ether(1);
        const daiBaseUnits = ether(1);

        // Calculate normalized units
        const normalizedWethReserves = preciseDiv(wethReserves, wethBaseUnits);
        const normalizedDaiReserves = preciseDiv(daiReserves, daiBaseUnits);

        // Get expected price
        const poolMarketCap = preciseMul(normalizedWethReserves, ethUsdPrice).add(preciseMul(normalizedDaiReserves, daiUsdPrice));
        const poolPriceToMaster = preciseDiv(poolMarketCap, poolTotalSupply);
        const expectedPrice = preciseDiv(poolPriceToMaster, usdUsdPrice);

        expect(returnedValue[0]).to.be.true;
        expect(returnedValue[1]).to.eq(expectedPrice);
      });

      describe("when the caller is not a system contract (i.e. external party seeking access to data)", async () => {
        beforeEach(async () => {
          subjectCaller = attacker;
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("Must be system contract");
        });
      });

      describe("when the contract is not a system resource", async () => {
        beforeEach(async () => {
          await setup.controller.removeResource(new BigNumber(3));
        });

        afterEach(async () => {
          await setup.controller.addResource(uniswapPriceAdapter.address, new BigNumber(3));
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("PriceOracle.getPrice: Caller must be system contract.");
        });
      });

      describe("when both base and quote asset are not Uniswap pools", async () => {
        beforeEach(async () => {
          subjectAssetOne = setup.dai.address;
        });

        it("should return false and 0", async () => {
          const returnedValue = await subject();
          expect(returnedValue[0]).to.be.false;
          expect(returnedValue[1]).to.eq(ZERO);
        });
      });
    });

    context("when a Uniswap pool is the quote asset", async () => {
      beforeEach(async () => {
        subjectAssetOne = setup.dai.address;
        subjectAssetTwo = uniswapSetup.wethWbtcPool.address;
        subjectCaller = owner;
      });

      async function subject(): Promise<any> {
        uniswapPriceAdapter = uniswapPriceAdapter.connect(subjectCaller.wallet);
        return uniswapPriceAdapter.getPrice(
          subjectAssetOne,
          subjectAssetTwo
        );
      }

      it("should return the price", async () => {
        const returnedValue = await subject();
        // Get oracle prices
        const ethUsdPrice = await setup.ETH_USD_Oracle.read();
        const wbtcUsdPrice = await setup.BTC_USD_Oracle.read();
        const usdUsdPrice = await setup.USD_USD_Oracle.read();

        // Get uniswap reserve info
        const wethReserves = await setup.weth.balanceOf(uniswapSetup.wethWbtcPool.address);
        const wbtcReserves = await setup.wbtc.balanceOf(uniswapSetup.wethWbtcPool.address);
        const poolTotalSupply = await uniswapSetup.wethWbtcPool.totalSupply();
        const wethBaseUnits = ether(1);
        const wbtcBaseUnits = bitcoin(1);

        // Calculate normalized units
        const normalizedWethReserves = preciseDiv(wethReserves, wethBaseUnits);
        const normalizedWbtcReserves = preciseDiv(wbtcReserves, wbtcBaseUnits);

        // Get expected price
        const poolMarketCap = preciseMul(normalizedWethReserves, ethUsdPrice).add(preciseMul(normalizedWbtcReserves, wbtcUsdPrice));
        const poolPriceToMaster = preciseDiv(poolMarketCap, poolTotalSupply);
        const expectedPrice = preciseDiv(usdUsdPrice, poolPriceToMaster);

        expect(returnedValue[0]).to.be.true;
        expect(returnedValue[1]).to.eq(expectedPrice);
      });
    });

    context("when Uniswap pools are both the base and quote asset", async () => {
      beforeEach(async () => {
        subjectAssetOne = uniswapSetup.wethDaiPool.address;
        subjectAssetTwo = uniswapSetup.wethWbtcPool.address;
        subjectCaller = owner;
      });

      async function subject(): Promise<any> {
        uniswapPriceAdapter = uniswapPriceAdapter.connect(subjectCaller.wallet);
        return uniswapPriceAdapter.getPrice(
          subjectAssetOne,
          subjectAssetTwo
        );
      }

      it("should return the price", async () => {
        const returnedValue = await subject();
        // Get oracle prices
        const ethUsdPrice = await setup.ETH_USD_Oracle.read();
        const wbtcUsdPrice = await setup.BTC_USD_Oracle.read();
        const daiUsdPrice = await setup.USD_USD_Oracle.read();

        const wethBaseUnits = ether(1);
        const wbtcBaseUnits = bitcoin(1);
        const daiBaseUnits = ether(1);

        // Get uniswap pool one reserve info
        const wethReservesOne = await setup.weth.balanceOf(uniswapSetup.wethDaiPool.address);
        const daiReservesOne = await setup.dai.balanceOf(uniswapSetup.wethDaiPool.address);
        const poolTotalSupplyOne = await uniswapSetup.wethDaiPool.totalSupply();
        // Calculate normalized units for pool one
        const normalizedWethReservesOne = preciseDiv(wethReservesOne, wethBaseUnits);
        const normalizedDaiReservesOne = preciseDiv(daiReservesOne, daiBaseUnits);
        // Get price for pool one
        const poolMarketCapOne = preciseMul(normalizedWethReservesOne, ethUsdPrice).add(preciseMul(normalizedDaiReservesOne, daiUsdPrice));
        const poolPriceToMasterOne = preciseDiv(poolMarketCapOne, poolTotalSupplyOne);

        // Get uniswap pool two reserve info
        const wethReservesTwo = await setup.weth.balanceOf(uniswapSetup.wethWbtcPool.address);
        const wbtcReservesTwo = await setup.wbtc.balanceOf(uniswapSetup.wethWbtcPool.address);
        const poolTotalSupplyTwo = await uniswapSetup.wethWbtcPool.totalSupply();
        // Calculate normalized units for pool two
        const normalizedWethReservesTwo = preciseDiv(wethReservesTwo, wethBaseUnits);
        const normalizedWbtcReservesTwo = preciseDiv(wbtcReservesTwo, wbtcBaseUnits);
        // Get price for pool two
        const poolMarketCapTwo = preciseMul(normalizedWethReservesTwo, ethUsdPrice).add(preciseMul(normalizedWbtcReservesTwo, wbtcUsdPrice));
        const poolPriceToMasterTwo = preciseDiv(poolMarketCapTwo, poolTotalSupplyTwo);

        const expectedPrice = preciseDiv(poolPriceToMasterOne, poolPriceToMasterTwo);

        expect(returnedValue[0]).to.be.true;
        expect(returnedValue[1]).to.eq(expectedPrice);
      });
    });
  });

  describe("#addPool", async () => {
    let mockTokenOneAddress: Address;
    let mockTokenTwoAddress: Address;
    let subjectPoolAddress: Address;
    let subjectCaller: Account;

    beforeEach(async () => {
      const mockTokenOne = await deployer.mocks.deployTokenMock(owner.address);
      const mockTokenTwo = await deployer.mocks.deployTokenMock(owner.address, ether(100000), 8);
      mockTokenOneAddress = mockTokenOne.address;
      mockTokenTwoAddress = mockTokenTwo.address;

      const uniswapPool = await uniswapSetup.createNewPair(mockTokenOneAddress, mockTokenTwoAddress);
      subjectPoolAddress = uniswapPool.address;
      subjectCaller = owner;
    });

    async function subject(): Promise<any> {
      return uniswapPriceAdapter.connect(subjectCaller.wallet).addPool(subjectPoolAddress);
    }

    it("adds the address to the pools list", async () => {
      const existingPools = await uniswapPriceAdapter.getAllowedUniswapPools();

      await subject();

      const newPools = await uniswapPriceAdapter.getAllowedUniswapPools();
      existingPools.push(subjectPoolAddress);
      expect(newPools).to.deep.equal(existingPools);
    });

    it("adds the pool settings to the allowed pools mapping", async () => {
      await subject();

      const newSettings = await uniswapPriceAdapter.uniswapPoolsToSettings(subjectPoolAddress);
      const [expectedTokenOne, expectedTokenTwo] = uniswapSetup.getTokenOrder(
        mockTokenOneAddress,
        mockTokenTwoAddress
      );

      const [expectedTokenOneDecimals, expectedTokenTwoDecimals] = expectedTokenOne == mockTokenOneAddress ?
        [ether(1), bitcoin(1)] : [bitcoin(1), ether(1)];
      expect(newSettings.tokenOne).to.eq(expectedTokenOne);
      expect(newSettings.tokenTwo).to.eq(expectedTokenTwo);
      expect(newSettings.tokenOneBaseUnit).to.eq(expectedTokenOneDecimals);
      expect(newSettings.tokenTwoBaseUnit).to.eq(expectedTokenTwoDecimals);
      expect(newSettings.isValid).to.eq(true);
    });

    describe("when someone other than the owner tries to add an address", async () => {
      beforeEach(async () => {
        subjectCaller = attacker;
      });

      it("should revert", async () => {
        await expect(subject()).to.be.reverted;
      });
    });

    describe("when the address is already in the allowList", async () => {
      beforeEach(async () => {
        subjectPoolAddress = uniswapSetup.wethWbtcPool.address;
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Uniswap pool address already added");
      });
    });
  });

  describe("#removePair", async () => {
    let subjectPoolAddress: Address;
    let subjectCaller: Account;

    beforeEach(async () => {
      const mockTokenOne = await deployer.mocks.deployTokenMock(owner.address);
      const mockTokenTwo = await deployer.mocks.deployTokenMock(owner.address);

      const uniswapPool = await uniswapSetup.createNewPair(mockTokenOne.address, mockTokenTwo.address);
      await uniswapPriceAdapter.addPool(uniswapPool.address);

      subjectPoolAddress = uniswapPool.address;
      subjectCaller = owner;
    });

    async function subject(): Promise<any> {
      return uniswapPriceAdapter.connect(subjectCaller.wallet).removePool(subjectPoolAddress);
    }

    it("removes the address from the addresses list", async () => {
      await subject();

      const newAddresses = await uniswapPriceAdapter.getAllowedUniswapPools();
      const addressIndex = newAddresses.indexOf(subjectPoolAddress);
      expect(addressIndex).to.equal(-1);
    });

    it("updates the address in the settings mapping to null", async () => {
      await subject();

      const poolSettings = await uniswapPriceAdapter.uniswapPoolsToSettings(subjectPoolAddress);
      expect(poolSettings.tokenOne).to.eq(ADDRESS_ZERO);
      expect(poolSettings.tokenTwo).to.eq(ADDRESS_ZERO);
      expect(poolSettings.tokenOneBaseUnit).to.eq(ZERO);
      expect(poolSettings.tokenTwoBaseUnit).to.eq(ZERO);
      expect(poolSettings.isValid).to.equal(false);
    });

    describe("when someone other than the owner tries to remove an address", async () => {
      beforeEach(async () => {
        subjectCaller = attacker;
      });

      it("should revert", async () => {
        await expect(subject()).to.be.reverted;
      });
    });

    describe("when the address is not in the allowList", async () => {
      beforeEach(async () => {
        subjectPoolAddress = owner.address;
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Uniswap pool address does not exist");
      });
    });
  });
});