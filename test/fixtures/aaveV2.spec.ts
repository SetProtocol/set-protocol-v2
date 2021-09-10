import "module-alias/register";

import { Account } from "@utils/test/types";
import {
  getAccounts,
  getSystemFixture,
  getWaffleExpect,
  getAaveV2Fixture
} from "@utils/test/index";
import { SystemFixture, AaveV2Fixture } from "@utils/fixtures";
import { BigNumber } from "ethers";
import { ether } from "@utils/common";

const expect = getWaffleExpect();

describe("AaveV2Fixture", async () => {
  let owner: Account;

  let setup: SystemFixture;
  let aaveSetup: AaveV2Fixture;

  before(async () => {
    [
      owner,
    ] = await getAccounts();

    setup = getSystemFixture(owner.address);
    aaveSetup = getAaveV2Fixture(owner.address);

    await setup.initialize();
  });

  describe("#initialize", async () => {
    async function subject(): Promise<void> {
      await aaveSetup.initialize(setup.weth.address, setup.dai.address);
    }

    it("should deploy all contracts and set their addresses in the LendingPoolAddressProvider", async () => {
      await subject();

      const addressProvider = aaveSetup.lendingPoolAddressesProvider;
      const lendingPoolAddress = await addressProvider.getLendingPool();
      const lendingPoolConfiuratorAddress = await addressProvider.getLendingPoolConfigurator();
      const lendingPoolCollateralManager = await addressProvider.getLendingPoolCollateralManager();
      const protocolDataProvider = await addressProvider.getAddress("0x0100000000000000000000000000000000000000000000000000000000000000");

      expect(lendingPoolAddress).to.eq(aaveSetup.lendingPool.address);
      expect(lendingPoolConfiuratorAddress).to.eq(aaveSetup.lendingPoolConfigurator.address);
      expect(lendingPoolCollateralManager).to.eq(aaveSetup.lendingPoolCollateralManager.address);
      expect(protocolDataProvider).to.eq(aaveSetup.protocolDataProvider.address);
    });

    it("should set initial asset prices and market rates", async () => {
      const oneRay = BigNumber.from(10).pow(27);	// 1e27
      await subject();

      const wethPriceInEth = await aaveSetup.priceOracle.getAssetPrice(setup.weth.address);
      const daiPriceInEth = await aaveSetup.priceOracle.getAssetPrice(setup.dai.address);
      const wethMarketBorrowRate = await aaveSetup.lendingRateOracle.getMarketBorrowRate(setup.weth.address);
      const daiMarketBorrowRate = await aaveSetup.lendingRateOracle.getMarketBorrowRate(setup.dai.address);

      expect(wethPriceInEth).to.eq(ether(1));
      expect(daiPriceInEth).to.eq(ether(0.001));
      expect(wethMarketBorrowRate).to.eq(oneRay.mul(3).div(100));
      expect(daiMarketBorrowRate).to.eq(oneRay.mul(39).div(1000));
    });

    it("should deploy WETH reserve with correct configuration", async () => {
      await subject();

      const wethReserveTokens = aaveSetup.wethReserveTokens;
      const reservesList = await aaveSetup.lendingPool.getReservesList();
      const tokenAddresses = await aaveSetup.protocolDataProvider.getReserveTokensAddresses(setup.weth.address);
      const config = await aaveSetup.protocolDataProvider.getReserveConfigurationData(setup.weth.address);

      expect(reservesList).to.contain(setup.weth.address);

      expect(wethReserveTokens.aToken.address).to.eq(tokenAddresses.aTokenAddress);
      expect(wethReserveTokens.stableDebtToken.address).to.eq(tokenAddresses.stableDebtTokenAddress);
      expect(wethReserveTokens.variableDebtToken.address).to.eq(tokenAddresses.variableDebtTokenAddress);

      expect(config.isActive).to.eq(true);
      expect(config.isFrozen).to.eq(false);
      expect(config.decimals).to.eq(BigNumber.from(18));
      expect(config.ltv).to.eq(BigNumber.from(8000));
      expect(config.liquidationThreshold).to.eq(BigNumber.from(8250));
      expect(config.liquidationBonus).to.eq(BigNumber.from(10500));
      expect(config.reserveFactor).to.eq(BigNumber.from(1000));
      expect(config.borrowingEnabled).to.eq(true);
      expect(config.usageAsCollateralEnabled).to.eq(true);
      expect(config.stableBorrowRateEnabled).to.eq(true);
    });

    it("should deploy DAI reserve with correct configuration", async () => {
      await subject();

      const daiReserveTokens = aaveSetup.daiReserveTokens;
      const reservesList = await aaveSetup.lendingPool.getReservesList();
      const tokenAddresses = await aaveSetup.protocolDataProvider.getReserveTokensAddresses(setup.dai.address);
      const config = await aaveSetup.protocolDataProvider.getReserveConfigurationData(setup.dai.address);

      expect(reservesList).to.contain(setup.dai.address);

      expect(daiReserveTokens.aToken.address).to.eq(tokenAddresses.aTokenAddress);
      expect(daiReserveTokens.stableDebtToken.address).to.eq(tokenAddresses.stableDebtTokenAddress);
      expect(daiReserveTokens.variableDebtToken.address).to.eq(tokenAddresses.variableDebtTokenAddress);

      expect(config.isActive).to.eq(true);
      expect(config.isFrozen).to.eq(false);
      expect(config.decimals).to.eq(BigNumber.from(18));
      expect(config.ltv).to.eq(BigNumber.from(7500));
      expect(config.liquidationThreshold).to.eq(BigNumber.from(8000));
      expect(config.liquidationBonus).to.eq(BigNumber.from(10500));
      expect(config.reserveFactor).to.eq(BigNumber.from(1000));
      expect(config.borrowingEnabled).to.eq(true);
      expect(config.usageAsCollateralEnabled).to.eq(true);
      expect(config.stableBorrowRateEnabled).to.eq(true);
    });
  });
});
