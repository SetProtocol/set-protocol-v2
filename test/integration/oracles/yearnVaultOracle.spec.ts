import "module-alias/register";
import { BigNumber } from "ethers";

import { Address } from "@utils/types";
import { Account } from "@utils/test/types";
import { OracleMock, YearnVaultOracle, YearnVaultMock } from "@utils/contracts";

import DeployHelper from "@utils/deploys";

import {
  ether
} from "@utils/index";
import {
  getAccounts,
  getWaffleExpect,
  getSystemFixture,
  getYearnFixture,
  addSnapshotBeforeRestoreAfterEach,
} from "@utils/test/index";
import { YearnFixture, SystemFixture } from "@utils/fixtures";

const expect = getWaffleExpect();

describe("YearnVaultOracle", () => {
  let owner: Account;
  let deployer: DeployHelper;
  let setup: SystemFixture;

  let yearnSetup: YearnFixture;
  let daiVault: YearnVaultMock;

  let daiUsdcOracle: OracleMock;
  let daiUsdcPrice: BigNumber;
  let yearnVaultDaiOracle: YearnVaultOracle;
  let daiFullUnit: BigNumber;
  let pricePerShare: BigNumber;

  before(async () => {
    [
      owner,
    ] = await getAccounts();

    // System setup
    deployer = new DeployHelper(owner.wallet);
    setup = getSystemFixture(owner.address);
    await setup.initialize();

    // Yearn setup
    yearnSetup = getYearnFixture(owner.address);
    await yearnSetup.initialize();

    pricePerShare = ether(1.5);
    daiVault = await deployer.mocks.deployYearnVaultMock(pricePerShare);
    daiUsdcPrice = ether(1);
    daiUsdcOracle = await deployer.mocks.deployOracleMock(daiUsdcPrice);
    daiFullUnit = ether(1);
    yearnVaultDaiOracle = await deployer.oracles.deployYearnVaultOracle(
      daiVault.address,
      daiUsdcOracle.address,
      daiFullUnit,
      "yvDAIUSDC Oracle"
    );

  });

  addSnapshotBeforeRestoreAfterEach();

  describe("#constructor", async () => {
    let subjectVaultAddress: Address;
    let subjectUnderlyingOracle: Address;
    let subjectUnderlyingFullUnit: BigNumber;
    let subjectDataDescription: string;

    before(async () => {
      subjectVaultAddress = daiVault.address;
      subjectUnderlyingFullUnit = ether(1);
      subjectUnderlyingOracle = daiUsdcOracle.address;
      subjectDataDescription = "yvDAI Oracle";
    });

    async function subject(): Promise<YearnVaultOracle> {
      return deployer.oracles.deployYearnVaultOracle(
        subjectVaultAddress,
        subjectUnderlyingOracle,
        subjectUnderlyingFullUnit,
        subjectDataDescription
      );
    }

    it("sets the correct vault address", async () => {
      const yearVaultOracle = await subject();
      const vaultAddress = await yearVaultOracle.vault();
      expect(vaultAddress).to.equal(subjectVaultAddress);
    });

    it("sets the correct underlying full unit", async () => {
      const yearVaultOracle = await subject();
      const underlyingFullUnit = await yearVaultOracle.underlyingFullUnit();
      expect(underlyingFullUnit).to.eq(subjectUnderlyingFullUnit);
    });

    it("sets the correct underlying oracle address", async () => {
      const yearVaultOracle = await subject();
      const underlyingOracleAddress = await yearVaultOracle.underlyingOracle();
      expect(underlyingOracleAddress).to.eq(subjectUnderlyingOracle);
    });

    it("sets the correct data description", async () => {
      const yearVaultOracle = await subject();
      const actualDataDescription = await yearVaultOracle.dataDescription();
      expect(actualDataDescription).to.eq(subjectDataDescription);
    });

  });


  describe("#read", async () => {

    async function subject(): Promise<BigNumber> {
      return yearnVaultDaiOracle.read();
    }

    it("returns the correct vault value", async () => {
      const result = await subject();
      const expectedResult = pricePerShare
        .mul(daiUsdcPrice)
        .div(daiFullUnit);
      expect(result).to.eq(expectedResult);
    });
  });
});
