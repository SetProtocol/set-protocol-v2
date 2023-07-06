import "module-alias/register";

import { BigNumber } from "ethers";
import { utils } from "ethers";

import { Bytes } from "@utils/types";
import { Account } from "@utils/test/types";
import {
  ADDRESS_ZERO,
  ZERO,
} from "@utils/constants";
import { ConstantPriceAdapter } from "@utils/contracts";
import DeployHelper from "@utils/deploys";
import {
  ether,
} from "@utils/index";
import {
  addSnapshotBeforeRestoreAfterEach,
  getAccounts,
  getSystemFixture,
  getWaffleExpect,
} from "@utils/test/index";

import { SystemFixture } from "@utils/fixtures";

const expect = getWaffleExpect();

describe("ConstantPriceAdapter", () => {
  let owner: Account;
  let deployer: DeployHelper;
  let setup: SystemFixture;

  let constantPriceAdapter: ConstantPriceAdapter;

  before(async () => {
    [owner] = await getAccounts();

    deployer = new DeployHelper(owner.wallet);
    setup = getSystemFixture(owner.address);

    await setup.initialize();

    constantPriceAdapter = await deployer.adapters.deployConstantPriceAdapter();
  });

  addSnapshotBeforeRestoreAfterEach();

  describe("#getPrice", async () => {
    let subjectPrice: BigNumber;
    let subjectPriceAdapterConfigData: Bytes;

    beforeEach(async () => {
      subjectPrice = ether(100);
      subjectPriceAdapterConfigData = await constantPriceAdapter.getEncodedData(subjectPrice);
    });

    async function subject(): Promise<any> {
      return await constantPriceAdapter.getPrice(
        ADDRESS_ZERO,
        ADDRESS_ZERO,
        ZERO,
        ZERO,
        ZERO,
        subjectPriceAdapterConfigData
      );
    }

    it("should return the correct price", async () => {
      const returnedPrice = await subject();

      expect(returnedPrice).to.eq(subjectPrice);
    });

    describe("when the price is 0", async () => {
      beforeEach(async () => {
        subjectPrice = ZERO;
        subjectPriceAdapterConfigData = await constantPriceAdapter.getEncodedData(subjectPrice);
      });

      it("should revert with 'ConstantPriceAdapter: Price must be greater than 0'", async () => {
        await expect(subject()).to.be.revertedWith("ConstantPriceAdapter: Price must be greater than 0");
      });
    });
  });

  describe("#isPriceAdapterConfigDataValid", async () => {
    let subjectPrice: BigNumber;
    let subjectPriceAdapterConfigData: Bytes;

    beforeEach(async () => {
      subjectPrice = ether(100);
      subjectPriceAdapterConfigData = await constantPriceAdapter.getEncodedData(subjectPrice);
    });

    async function subject(): Promise<any> {
      return await constantPriceAdapter.isPriceAdapterConfigDataValid(subjectPriceAdapterConfigData);
    }

    it("should return true for valid prices", async () => {
      const isValid = await subject();

      expect(isValid).to.be.true;
    });

    describe("when the price is 0", async () => {
      beforeEach(async () => {
        subjectPrice = ZERO;
        subjectPriceAdapterConfigData = await constantPriceAdapter.getEncodedData(subjectPrice);
      });

      it("should return false", async () => {
        const isValid = await subject();

        expect(isValid).to.be.false;
      });
    });
  });

  describe("#getEncodedData", async () => {
    let subjectPrice: BigNumber;

    beforeEach(async () => {
      subjectPrice = ether(100);
    });

    async function subject(): Promise<any> {
      return await constantPriceAdapter.getEncodedData(subjectPrice);
    }

    it("should correctly encode data", async () => {
      const encodedData = await subject();

      const expectedData = utils.defaultAbiCoder.encode(["uint256"], [subjectPrice]);

      expect(encodedData).to.eq(expectedData);
    });
  });

  describe("#getDecodedData", async () => {
    let subjectPrice: BigNumber;
    let subjectPriceAdapterConfigData: Bytes;

    beforeEach(async () => {
      subjectPrice = ether(100);
      subjectPriceAdapterConfigData = utils.defaultAbiCoder.encode(["uint256"], [subjectPrice]);
    });

    async function subject(): Promise<any> {
      return await constantPriceAdapter.getDecodedData(subjectPriceAdapterConfigData);
    }

    it("should correctly decode data", async () => {
      const decodedData = await subject();
      expect(decodedData).to.eq(subjectPrice);
    });
  });
});
