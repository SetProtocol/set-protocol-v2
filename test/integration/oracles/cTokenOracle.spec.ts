import "module-alias/register";
import { BigNumber } from "ethers";

import { Address } from "@utils/types";
import { Account } from "@utils/test/types";
import { CERc20 } from "@utils/contracts/compound";
import { OracleMock, CTokenOracle } from "@utils/contracts";
import DeployHelper from "@utils/deploys";

import {
  ether
} from "@utils/index";
import {
  getAccounts,
  getWaffleExpect,
  getSystemFixture,
  getCompoundFixture,
  addSnapshotBeforeRestoreAfterEach,
} from "@utils/test/index";
import { CompoundFixture, SystemFixture } from "@utils/fixtures";

const expect = getWaffleExpect();

describe("CTokenOracle", () => {
  let owner: Account;
  let deployer: DeployHelper;
  let setup: SystemFixture;

  let compoundSetup: CompoundFixture;
  let cDai: CERc20;
  let exchangeRate: BigNumber;
  let daiUsdcOracle: OracleMock;
  let cDaiOracle: CTokenOracle;
  let cDaiFullUnit: BigNumber;
  let daiFullUnit: BigNumber;

  before(async () => {
    [
      owner,
    ] = await getAccounts();

    // System setup
    deployer = new DeployHelper(owner.wallet);
    setup = getSystemFixture(owner.address);
    await setup.initialize();

    // Compound setup
    compoundSetup = getCompoundFixture(owner.address);
    await compoundSetup.initialize();

    exchangeRate = ether(0.5);

    cDai = await compoundSetup.createAndEnableCToken(
      setup.dai.address,
      exchangeRate,
      compoundSetup.comptroller.address,
      compoundSetup.interestRateModel.address,
      "Compound DAI",
      "cDAI",
      8,
      ether(0.75), // 75% collateral factor
      ether(1)
    );

    daiUsdcOracle = await deployer.mocks.deployOracleMock(ether(1));
    cDaiFullUnit = BigNumber.from("100000000");
    daiFullUnit = BigNumber.from("1000000000000000000");
    cDaiOracle = await deployer.oracles.deployCTokenOracle(
      cDai.address,
      daiUsdcOracle.address,
      cDaiFullUnit,
      daiFullUnit,
      "cDAI Oracle"
    );

  });

  addSnapshotBeforeRestoreAfterEach();

  describe("#constructor", async () => {
    let subjectCToken: Address;
    let subjectUnderlyingOracle: Address;
    let subjectCTokenFullUnit: BigNumber;
    let subjectUnderlyingFullUnit: BigNumber;
    let subjectDataDescription: string;

    before(async () => {
      subjectCToken = cDai.address;
      subjectCTokenFullUnit = BigNumber.from("100000000");
      subjectUnderlyingFullUnit = BigNumber.from("1000000000000000000");
      subjectUnderlyingOracle = daiUsdcOracle.address;
      subjectDataDescription = "cDAI Oracle";
    });

    async function subject(): Promise<CTokenOracle> {
      return deployer.oracles.deployCTokenOracle(
        subjectCToken,
        subjectUnderlyingOracle,
        subjectCTokenFullUnit,
        subjectUnderlyingFullUnit,
        subjectDataDescription
      );
    }

    it("sets the correct cToken address", async () => {
      const cTokenOracle = await subject();
      const cTokenAddress = await cTokenOracle.cToken();
      expect(cTokenAddress).to.equal(subjectCToken);
    });

    it("sets the correct cToken full unit", async () => {
      const cTokenOracle = await subject();
      const cTokenFullUnit = await cTokenOracle.cTokenFullUnit();
      expect(cTokenFullUnit).to.eq(subjectCTokenFullUnit);
    });

    it("sets the correct underlying full unit", async () => {
      const cTokenOracle = await subject();
      const underlyingFullUnit = await cTokenOracle.underlyingFullUnit();
      expect(underlyingFullUnit).to.eq(subjectUnderlyingFullUnit);
    });

    it("sets the correct underlying oracle address", async () => {
      const cTokenOracle = await subject();
      const underlyingOracleAddress = await cTokenOracle.underlyingOracle();
      expect(underlyingOracleAddress).to.eq(subjectUnderlyingOracle);
    });

    it("sets the correct data description", async () => {
      const cTokenOracle = await subject();
      const actualDataDescription = await cTokenOracle.dataDescription();
      expect(actualDataDescription).to.eq(subjectDataDescription);
    });

  });


  describe("#read", async () => {

    async function subject(): Promise<BigNumber> {
      return cDaiOracle.read();
    }

    it("returns the correct cTokenValue", async () => {
      const result = await subject();
      const expectedResult = ether(1)
        .mul(exchangeRate)
        .mul(cDaiFullUnit)
        .div(daiFullUnit)
        .div(ether(1));

      expect(result).to.eq(expectedResult);
    });
  });
});
