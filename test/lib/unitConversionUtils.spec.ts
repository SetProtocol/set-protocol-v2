import "module-alias/register";

import { BigNumber } from "ethers";

import { Account } from "@utils/test/types";
import { UnitConversionUtilsMock } from "@utils/contracts";
import DeployHelper from "@utils/deploys";
import {
  addSnapshotBeforeRestoreAfterEach,
  getAccounts,
  getWaffleExpect,
} from "@utils/test/index";

import { ether, usdc } from "@utils/index";

const expect = getWaffleExpect();

describe("UnitConversionUtils", () => {
  let owner: Account;
  let deployer: DeployHelper;
  let quantity: number;
  let usdcDecimals: number;

  let unitConversionUtilsMock: UnitConversionUtilsMock;

  before(async () => {
    [
      owner,
    ] = await getAccounts();

    deployer = new DeployHelper(owner.wallet);
    unitConversionUtilsMock = await deployer.mocks.deployUnitConversionUtilsMock();

    quantity = 5;
    usdcDecimals = 6;
  });

  addSnapshotBeforeRestoreAfterEach();

  describe("#fromPreciseUnitToDecimals (int)", async () => {
    let subjectPreciseUnitQuantity: BigNumber;
    let subjectDecimals: number;

    async function subject(): Promise<BigNumber>{
      return await unitConversionUtilsMock.testFromPreciseUnitToDecimalsInt(
        subjectPreciseUnitQuantity,
        subjectDecimals
      );
    };

    beforeEach(() => {
      subjectPreciseUnitQuantity = ether(quantity);
      subjectDecimals = usdcDecimals;
    });

    it("should convert from precise unit value to decimals value correctly", async () => {
      const expectedValue = usdc(quantity);
      const actualValue = await subject();

      expect(actualValue).eq(expectedValue);
    });
  });

  describe("#fromPreciseUnitToDecimals (uint)", async () => {
    let subjectPreciseUnitQuantity: BigNumber;
    let subjectDecimals: number;

    async function subject(): Promise<BigNumber>{
      return await unitConversionUtilsMock.testFromPreciseUnitToDecimalsUint(
        subjectPreciseUnitQuantity,
        subjectDecimals
      );
    };

    beforeEach(() => {
      subjectPreciseUnitQuantity = ether(quantity);
      subjectDecimals = usdcDecimals;
    });

    it("should convert from precise unit value to decimals value correctly", async () => {
      const expectedValue = usdc(quantity);
      const actualValue = await subject();

      expect(actualValue).eq(expectedValue);
    });
  });

  describe("#fromPreciseUnitToDecimals (int)", async () => {
    let subjectDecimalsQuantity: BigNumber;
    let subjectDecimals: number;

    async function subject(): Promise<BigNumber>{
      return await unitConversionUtilsMock.testToPreciseUnitsFromDecimalsInt(
        subjectDecimalsQuantity,
        subjectDecimals
      );
    };

    beforeEach(() => {
      subjectDecimalsQuantity = usdc(quantity);
      subjectDecimals = usdcDecimals;
    });

    it("should convert to precise unit value from decimals value correctly", async () => {
      const expectedValue = ether(quantity);
      const actualValue = await subject();

      expect(actualValue).eq(expectedValue);
    });
  });
});
