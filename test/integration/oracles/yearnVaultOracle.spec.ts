import "module-alias/register";
import { BigNumber } from "@ethersproject/bignumber";

import { Address } from "@utils/types";
import { Account } from "@utils/test/types";
import { OracleMock, YearnVaultOracle } from "@utils/contracts";
import { Vault } from "../../../typechain/Vault";

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

describe("CTokenOracle", () => {
  let owner: Account;
  let deployer: DeployHelper;
  let setup: SystemFixture;

  let yearnSetup: YearnFixture;
  let daiVault: Vault;

  let daiUsdcOracle: OracleMock;
  let daiUsdcPrice: BigNumber;
  let yearnVaultDaiOracle: YearnVaultOracle;
  let daiFullUnit: BigNumber;

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

    daiVault =  await yearnSetup.createAndEnableVaultWithStrategyMock(
      setup.dai.address, owner.address, owner.address, owner.address, "MockStrategy", "M", ether(100)
    );

    daiUsdcPrice = BigNumber.from("1000000000000000000");
    daiUsdcOracle = await deployer.mocks.deployOracleMock(daiUsdcPrice);
    daiFullUnit = BigNumber.from("1000000000000000000");
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
      subjectUnderlyingFullUnit = BigNumber.from("1000000000000000000");
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
    let subjectUnderlyingPricePerShare: BigNumber;

    before(async () => {
      subjectUnderlyingPricePerShare = BigNumber.from("1000000000000000000");
    });

    async function subject(): Promise<BigNumber> {
      return yearnVaultDaiOracle.read();
    }

    it("returns the correct vault value", async () => {
      const result = await subject();
      const expectedResult = subjectUnderlyingPricePerShare
                              .div(daiFullUnit)
                              .mul(daiUsdcPrice);

      expect(result).to.eq(expectedResult);
    });
  });
});
