import "module-alias/register";

import { BigNumber } from "ethers";
import { utils } from "ethers";

import { Bytes } from "@utils/types";
import { Account } from "@utils/test/types";
import {
  ADDRESS_ZERO,
  MAX_UINT_256,
  ONE_HOUR_IN_SECONDS,
  ZERO,
} from "@utils/constants";
import { BoundedStepwiseLinearPriceAdapter } from "@utils/contracts";
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

describe("BoundedStepwiseLinearPriceAdapter", () => {
  let owner: Account;
  let deployer: DeployHelper;
  let setup: SystemFixture;

  let boundedStepwiseLinearPriceAdapter: BoundedStepwiseLinearPriceAdapter;

  before(async () => {
    [owner] = await getAccounts();

    deployer = new DeployHelper(owner.wallet);
    setup = getSystemFixture(owner.address);

    await setup.initialize();

    boundedStepwiseLinearPriceAdapter = await deployer.adapters.deployBoundedStepwiseLinearPriceAdapter();
  });

  addSnapshotBeforeRestoreAfterEach();

  describe("#getPrice", async () => {
    let subjectInitialPrice: BigNumber;
    let subjectSlope: BigNumber;
    let subjectBucketSize: BigNumber;
    let subjectIsDecreasing: boolean;
    let subjectMaxPrice: BigNumber;
    let subjectMinPrice: BigNumber;

    let subjectIncreaseTime: BigNumber;
    let subjectPriceAdapterConfigData: Bytes;

    beforeEach(async () => {
      subjectInitialPrice = ether(100);
      subjectSlope = ether(1);
      subjectBucketSize = ONE_HOUR_IN_SECONDS;
      subjectIsDecreasing = true;
      subjectMaxPrice = ether(100);
      subjectMinPrice = ether(90);

      subjectPriceAdapterConfigData = await boundedStepwiseLinearPriceAdapter.getEncodedData(
        subjectInitialPrice,
        subjectSlope,
        subjectBucketSize,
        subjectIsDecreasing,
        subjectMaxPrice,
        subjectMinPrice
      );

      subjectIncreaseTime = ONE_HOUR_IN_SECONDS;
    });

    async function subject(): Promise<any> {
      return await boundedStepwiseLinearPriceAdapter.getPrice(
        ADDRESS_ZERO,
        ADDRESS_ZERO,
        ZERO,
        subjectIncreaseTime,
        ZERO,
        subjectPriceAdapterConfigData
      );
    }

    it("should return the correct price", async () => {
      const returnedPrice = await subject();

      const expectedPrice = subjectInitialPrice.sub(subjectSlope.mul(subjectIncreaseTime).div(subjectBucketSize));

      expect(returnedPrice).to.eq(expectedPrice);
    });

    describe("when it is not decreasing", async () => {
      beforeEach(async () => {
        subjectIsDecreasing = false;
        subjectMaxPrice = ether(110);
        subjectMinPrice = ether(100);
        subjectPriceAdapterConfigData = await boundedStepwiseLinearPriceAdapter.getEncodedData(
          subjectInitialPrice,
          subjectSlope,
          subjectBucketSize,
          subjectIsDecreasing,
          subjectMaxPrice,
          subjectMinPrice
        );
      });

      it("should return the correct price", async () => {
        const returnedPrice = await subject();

        const expectedPrice = subjectInitialPrice.add(subjectSlope.mul(subjectIncreaseTime).div(subjectBucketSize));

        expect(returnedPrice).to.eq(expectedPrice);
      });
    });

    describe("when the time elapsed is 0", async () => {
      beforeEach(async () => {
        subjectIncreaseTime = ZERO;
      });

      it("should return the initial price", async () => {
        const returnedPrice = await subject();

        expect(returnedPrice).to.eq(subjectInitialPrice);
      });
    });

    describe("when the bucket and slope multiplication will overflow", async () => {
      beforeEach(async () => {
        subjectSlope = MAX_UINT_256;
        subjectPriceAdapterConfigData = await boundedStepwiseLinearPriceAdapter.getEncodedData(
          subjectInitialPrice,
          subjectSlope,
          subjectBucketSize,
          subjectIsDecreasing,
          subjectMaxPrice,
          subjectMinPrice
        );

        subjectIncreaseTime = ONE_HOUR_IN_SECONDS.mul(2);
      });

      it("should return the min price if it was decreasing", async () => {
        const returnedPrice = await subject();

        expect(returnedPrice).to.eq(subjectMinPrice);
      });

      describe("when it was not decreasing", async () => {
        beforeEach(async () => {
          subjectIsDecreasing = false;
          subjectMaxPrice = ether(110);
          subjectMinPrice = ether(100);
          subjectPriceAdapterConfigData = await boundedStepwiseLinearPriceAdapter.getEncodedData(
            subjectInitialPrice,
            subjectSlope,
            subjectBucketSize,
            subjectIsDecreasing,
            subjectMaxPrice,
            subjectMinPrice
          );
        });

        it("should return the max price", async () => {
          const returnedPrice = await subject();

          expect(returnedPrice).to.eq(subjectMaxPrice);
        });
      });

    });

    describe("when it is decreasing and the price computation will underflow", async () => {
      beforeEach(async () => {
        subjectSlope = subjectInitialPrice;
        subjectPriceAdapterConfigData = await boundedStepwiseLinearPriceAdapter.getEncodedData(
          subjectInitialPrice,
          subjectSlope,
          subjectBucketSize,
          subjectIsDecreasing,
          subjectMaxPrice,
          subjectMinPrice
        );

        subjectIncreaseTime = ONE_HOUR_IN_SECONDS.mul(2);
      });

      it("should return the min price", async () => {
        const returnedPrice = await subject();

        expect(returnedPrice).to.eq(subjectMinPrice);
      });
    });

    describe("when it is decreasing and the price computation returns below the minimum", async () => {
      beforeEach(async () => {
        subjectSlope = subjectInitialPrice.div(3);
        subjectPriceAdapterConfigData = await boundedStepwiseLinearPriceAdapter.getEncodedData(
          subjectInitialPrice,
          subjectSlope,
          subjectBucketSize,
          subjectIsDecreasing,
          subjectMaxPrice,
          subjectMinPrice
        );

        subjectIncreaseTime = ONE_HOUR_IN_SECONDS.mul(2);
      });

      it("should return the min price", async () => {
        const returnedPrice = await subject();

        expect(returnedPrice).to.eq(subjectMinPrice);
      });
    });

    describe("when it is not decreasing and the price computation will overflow", async () => {
      beforeEach(async () => {
        subjectSlope = MAX_UINT_256;
        subjectIsDecreasing = false;
        subjectMaxPrice = ether(110);
        subjectMinPrice = ether(100);
        subjectPriceAdapterConfigData = await boundedStepwiseLinearPriceAdapter.getEncodedData(
          subjectInitialPrice,
          subjectSlope,
          subjectBucketSize,
          subjectIsDecreasing,
          subjectMaxPrice,
          subjectMinPrice
        );

        subjectIncreaseTime = ONE_HOUR_IN_SECONDS.mul(1);
      });

      it("should return the max price", async () => {
        const returnedPrice = await subject();

        expect(returnedPrice).to.eq(subjectMaxPrice);
      });
    });

    describe("when it is not decreasing and the price computation returns above the maximum", async () => {
      beforeEach(async () => {
        subjectSlope = subjectInitialPrice.div(3);
        subjectIsDecreasing = false;
        subjectMaxPrice = ether(110);
        subjectMinPrice = ether(100);
        subjectPriceAdapterConfigData = await boundedStepwiseLinearPriceAdapter.getEncodedData(
          subjectInitialPrice,
          subjectSlope,
          subjectBucketSize,
          subjectIsDecreasing,
          subjectMaxPrice,
          subjectMinPrice
        );

        subjectIncreaseTime = ONE_HOUR_IN_SECONDS.mul(2);
      });

      it("should return the max price", async () => {
        const returnedPrice = await subject();

        expect(returnedPrice).to.eq(subjectMaxPrice);
      });
    });

    describe("when the price adapter config data is invalid", async () => {
      describe("when the initial price is 0", async () => {
        beforeEach(async () => {
          subjectInitialPrice = ZERO;
          subjectPriceAdapterConfigData = await boundedStepwiseLinearPriceAdapter.getEncodedData(
            subjectInitialPrice,
            subjectSlope,
            subjectBucketSize,
            subjectIsDecreasing,
            subjectMaxPrice,
            subjectMinPrice
          );
        });

        it("should revert with 'BoundedStepwiseLinearPriceAdapter: Invalid params'", async () => {
          await expect(subject()).to.be.revertedWith("BoundedStepwiseLinearPriceAdapter: Invalid params");
        });
      });

      describe("when the slope is 0", async () => {
        beforeEach(async () => {
          subjectSlope = ZERO;
          subjectPriceAdapterConfigData = await boundedStepwiseLinearPriceAdapter.getEncodedData(
            subjectInitialPrice,
            subjectSlope,
            subjectBucketSize,
            subjectIsDecreasing,
            subjectMaxPrice,
            subjectMinPrice
          );
        });

        it("should revert with 'BoundedStepwiseLinearPriceAdapter: Invalid params'", async () => {
          await expect(subject()).to.be.revertedWith("BoundedStepwiseLinearPriceAdapter: Invalid params");
        });
      });

      describe("when the bucket size is 0", async () => {
        beforeEach(async () => {
          subjectBucketSize = ZERO;
          subjectPriceAdapterConfigData = await boundedStepwiseLinearPriceAdapter.getEncodedData(
            subjectInitialPrice,
            subjectSlope,
            subjectBucketSize,
            subjectIsDecreasing,
            subjectMaxPrice,
            subjectMinPrice
          );
        });

        it("should revert with 'BoundedStepwiseLinearPriceAdapter: Invalid params'", async () => {
          await expect(subject()).to.be.revertedWith("BoundedStepwiseLinearPriceAdapter: Invalid params");
        });
      });

      describe("when the initial price is greater than the max price", async () => {
        beforeEach(async () => {
          subjectMaxPrice = ZERO;
          subjectPriceAdapterConfigData = await boundedStepwiseLinearPriceAdapter.getEncodedData(
            subjectInitialPrice,
            subjectSlope,
            subjectBucketSize,
            subjectIsDecreasing,
            subjectMaxPrice,
            subjectMinPrice
          );
        });

        it("should revert with 'BoundedStepwiseLinearPriceAdapter: Invalid params'", async () => {
          await expect(subject()).to.be.revertedWith("BoundedStepwiseLinearPriceAdapter: Invalid params");
        });
      });

      describe("when the initial price is less than the minimum price", async () => {
        beforeEach(async () => {
          subjectMinPrice = ether(100).add(1);
          subjectPriceAdapterConfigData = await boundedStepwiseLinearPriceAdapter.getEncodedData(
            subjectInitialPrice,
            subjectSlope,
            subjectBucketSize,
            subjectIsDecreasing,
            subjectMaxPrice,
            subjectMinPrice
          );
        });

        it("should revert with 'BoundedStepwiseLinearPriceAdapter: Invalid params'", async () => {
          await expect(subject()).to.be.revertedWith("BoundedStepwiseLinearPriceAdapter: Invalid params");
        });
      });
    });
  });

  describe("#isPriceAdapterConfigDataValid", async () => {
    let subjectInitialPrice: BigNumber;
    let subjectSlope: BigNumber;
    let subjectBucketSize: BigNumber;
    let subjectIsDecreasing: boolean;
    let subjectMaxPrice: BigNumber;
    let subjectMinPrice: BigNumber;

    let subjectPriceAdapterConfigData: Bytes;

    beforeEach(async () => {
      subjectInitialPrice = ether(100);
      subjectSlope = ether(1);
      subjectBucketSize = ONE_HOUR_IN_SECONDS;
      subjectIsDecreasing = false;
      subjectMaxPrice = ether(110);
      subjectMinPrice = ether(100);

      subjectPriceAdapterConfigData = await boundedStepwiseLinearPriceAdapter.getEncodedData(
        subjectInitialPrice,
        subjectSlope,
        subjectBucketSize,
        subjectIsDecreasing,
        subjectMaxPrice,
        subjectMinPrice
      );
    });

    async function subject(): Promise<any> {
      return await boundedStepwiseLinearPriceAdapter.isPriceAdapterConfigDataValid(subjectPriceAdapterConfigData);
    }

    it("should return true for valid parameters", async () => {
      const isValid = await subject();

      expect(isValid).to.eq(true);
    });

    describe("when the initial price is 0", async () => {
      beforeEach(async () => {
        subjectInitialPrice = ZERO;
        subjectPriceAdapterConfigData = await boundedStepwiseLinearPriceAdapter.getEncodedData(
          subjectInitialPrice,
          subjectSlope,
          subjectBucketSize,
          subjectIsDecreasing,
          subjectMaxPrice,
          subjectMinPrice
        );
      });

      it("should return false", async () => {
        const isValid = await subject();

        expect(isValid).to.eq(false);
      });
    });

    describe("when the slope is 0", async () => {
      beforeEach(async () => {
        subjectSlope = ZERO;
        subjectPriceAdapterConfigData = await boundedStepwiseLinearPriceAdapter.getEncodedData(
          subjectInitialPrice,
          subjectSlope,
          subjectBucketSize,
          subjectIsDecreasing,
          subjectMaxPrice,
          subjectMinPrice
        );
      });

      it("should return false", async () => {
        const isValid = await subject();

        expect(isValid).to.eq(false);
      });
    });

    describe("when the bucket size is 0", async () => {
      beforeEach(async () => {
        subjectBucketSize = ZERO;
        subjectPriceAdapterConfigData = await boundedStepwiseLinearPriceAdapter.getEncodedData(
          subjectInitialPrice,
          subjectSlope,
          subjectBucketSize,
          subjectIsDecreasing,
          subjectMaxPrice,
          subjectMinPrice
        );
      });

      it("should return false", async () => {
        const isValid = await subject();

        expect(isValid).to.eq(false);
      });
    });

    describe("when the initial price is greater than the max price", async () => {
      beforeEach(async () => {
        subjectMaxPrice = ZERO;
        subjectPriceAdapterConfigData = await boundedStepwiseLinearPriceAdapter.getEncodedData(
          subjectInitialPrice,
          subjectSlope,
          subjectBucketSize,
          subjectIsDecreasing,
          subjectMaxPrice,
          subjectMinPrice
        );
      });

      it("should return false", async () => {
        const isValid = await subject();

        expect(isValid).to.eq(false);
      });
    });

    describe("when the initial price is less than the minimum price", async () => {
      beforeEach(async () => {
        subjectMinPrice = ether(100).add(1);
        subjectPriceAdapterConfigData = await boundedStepwiseLinearPriceAdapter.getEncodedData(
          subjectInitialPrice,
          subjectSlope,
          subjectBucketSize,
          subjectIsDecreasing,
          subjectMaxPrice,
          subjectMinPrice
        );
      });

      it("should return false", async () => {
        const isValid = await subject();

        expect(isValid).to.eq(false);
      });
    });
  });

  describe("#areParamsValid", async () => {
    let subjectInitialPrice: BigNumber;
    let subjectSlope: BigNumber;
    let subjectBucketSize: BigNumber;
    let subjectMaxPrice: BigNumber;
    let subjectMinPrice: BigNumber;

    beforeEach(async () => {
      subjectInitialPrice = ether(100);
      subjectSlope = ether(1);
      subjectBucketSize = ONE_HOUR_IN_SECONDS;
      subjectMaxPrice = ether(110);
      subjectMinPrice = ether(100);
    });

    async function subject(): Promise<any> {
      return await boundedStepwiseLinearPriceAdapter.areParamsValid(
        subjectInitialPrice,
        subjectSlope,
        subjectBucketSize,
        subjectMaxPrice,
        subjectMinPrice
      );
    }

    it("should return true for valid parameters", async () => {
      const isValid = await subject();

      expect(isValid).to.eq(true);
    });

    describe("when the initial price is 0", async () => {
      beforeEach(async () => {
        subjectInitialPrice = ZERO;
      });

      it("should return false", async () => {
        const isValid = await subject();

        expect(isValid).to.eq(false);
      });
    });

    describe("when the slope is 0", async () => {
      beforeEach(async () => {
        subjectSlope = ZERO;
      });

      it("should return false", async () => {
        const isValid = await subject();

        expect(isValid).to.eq(false);
      });
    });

    describe("when the bucket size is 0", async () => {
      beforeEach(async () => {
        subjectBucketSize = ZERO;
      });

      it("should return false", async () => {
        const isValid = await subject();

        expect(isValid).to.eq(false);
      });
    });

    describe("when the initial price is greater than the max price", async () => {
      beforeEach(async () => {
        subjectMaxPrice = ZERO;
      });

      it("should return false", async () => {
        const isValid = await subject();

        expect(isValid).to.eq(false);
      });
    });

    describe("when the initial price is less than the minimum price", async () => {
      beforeEach(async () => {
        subjectMinPrice = ether(100).add(1);
      });

      it("should return false", async () => {
        const isValid = await subject();

        expect(isValid).to.eq(false);
      });
    });
  });

  describe("#getDecodedData", async () => {
    let subjectInitialPrice: BigNumber;
    let subjectSlope: BigNumber;
    let subjectBucketSize: BigNumber;
    let subjectIsDecreasing: boolean;
    let subjectMaxPrice: BigNumber;
    let subjectMinPrice: BigNumber;

    let subjectPriceAdapterConfigData: Bytes;

    beforeEach(async () => {
      subjectInitialPrice = ether(100);
      subjectSlope = ether(1);
      subjectBucketSize = ONE_HOUR_IN_SECONDS;
      subjectIsDecreasing = false;
      subjectMaxPrice = ether(110);
      subjectMinPrice = ether(100);

      subjectPriceAdapterConfigData = utils.defaultAbiCoder.encode(
        ["uint256", "uint256", "uint256", "bool", "uint256", "uint256"],
        [subjectInitialPrice, subjectSlope, subjectBucketSize, subjectIsDecreasing, subjectMaxPrice, subjectMinPrice]
      );
    });

    async function subject(): Promise<any> {
      return await boundedStepwiseLinearPriceAdapter.getDecodedData(subjectPriceAdapterConfigData);
    }

    it("should decode data correctly and return the expected values", async () => {
      const [
        decodedInitialPrice,
        decodedSlope,
        decodedBucketSize,
        decodedIsDecreasing,
        decodedMaxPrice,
        decodedMinPrice
      ] = await subject();

      expect(decodedInitialPrice).to.eq(subjectInitialPrice);
      expect(decodedSlope).to.eq(subjectSlope);
      expect(decodedBucketSize).to.eq(subjectBucketSize);
      expect(decodedIsDecreasing).to.eq(subjectIsDecreasing);
      expect(decodedMaxPrice).to.eq(subjectMaxPrice);
      expect(decodedMinPrice).to.eq(subjectMinPrice);
    });
  });

  describe("#getEncodedData", async () => {
    let subjectInitialPrice: BigNumber;
    let subjectSlope: BigNumber;
    let subjectBucketSize: BigNumber;
    let subjectIsDecreasing: boolean;
    let subjectMaxPrice: BigNumber;
    let subjectMinPrice: BigNumber;

    beforeEach(async () => {
      subjectInitialPrice = ether(100);
      subjectSlope = ether(1);
      subjectBucketSize = ONE_HOUR_IN_SECONDS;
      subjectIsDecreasing = false;
      subjectMaxPrice = ether(110);
      subjectMinPrice = ether(100);
    });

    async function subject(): Promise<any> {
      return await boundedStepwiseLinearPriceAdapter.getEncodedData(
        subjectInitialPrice,
        subjectSlope,
        subjectBucketSize,
        subjectIsDecreasing,
        subjectMaxPrice,
        subjectMinPrice
      );
    }

    it("should encode data correctly and match the expected encoded representation", async () => {
      const encodedData = await subject();

      const expectedData = utils.defaultAbiCoder.encode(
        ["uint256", "uint256", "uint256", "bool", "uint256", "uint256"],
        [subjectInitialPrice, subjectSlope, subjectBucketSize, subjectIsDecreasing, subjectMaxPrice, subjectMinPrice]
      );

      expect(encodedData).to.eq(expectedData);
    });
  });
});
