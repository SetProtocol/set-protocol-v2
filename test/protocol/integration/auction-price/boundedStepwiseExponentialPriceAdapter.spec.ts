import "module-alias/register";

import { BigNumber } from "ethers";
import { utils } from "ethers";

import { Bytes } from "@utils/types";
import { Account } from "@utils/test/types";
import {
  ADDRESS_ZERO,
  MAX_UINT_256,
  ONE_HOUR_IN_SECONDS, ZERO,
} from "@utils/constants";
import { BoundedStepwiseExponentialPriceAdapter } from "@utils/contracts";
import DeployHelper from "@utils/deploys";
import {
  ether,
} from "@utils/index";
import {
  addSnapshotBeforeRestoreAfterEach,
  getAccounts,
  getSystemFixture,
  getWaffleExpect
} from "@utils/test/index";

import { SystemFixture } from "@utils/fixtures";

const expect = getWaffleExpect();

describe("BoundedStepwiseExponentialPriceAdapter", () => {
  let owner: Account;
  let deployer: DeployHelper;
  let setup: SystemFixture;

  let boundedStepwiseExponentialPriceAdapter: BoundedStepwiseExponentialPriceAdapter;

  before(async () => {
    [owner] = await getAccounts();

    deployer = new DeployHelper(owner.wallet);
    setup = getSystemFixture(owner.address);

    await setup.initialize();

    boundedStepwiseExponentialPriceAdapter = await deployer.adapters.deployBoundedStepwiseExponentialPriceAdapter();
  });

  addSnapshotBeforeRestoreAfterEach();

  describe("#getPrice", async () => {
    let subjectInitialPrice: BigNumber;
    let subjectCoefficient: BigNumber;
    let subjectExponent: BigNumber;
    let subjectBucketSize: BigNumber;
    let subjectIsDecreasing: boolean;
    let subjectMaxPrice: BigNumber;
    let subjectMinPrice: BigNumber;

    let subjectIncreaseTime: BigNumber;
    let subjectPriceAdapterConfigData: Bytes;

    beforeEach(async () => {
      subjectInitialPrice = ether(100);
      subjectCoefficient = ether(1);
      subjectExponent = ether(1);
      subjectBucketSize = ONE_HOUR_IN_SECONDS;
      subjectIsDecreasing = true;
      subjectMaxPrice = ether(100);
      subjectMinPrice = ether(90);

      subjectPriceAdapterConfigData = await boundedStepwiseExponentialPriceAdapter.getEncodedData(
        subjectInitialPrice,
        subjectCoefficient,
        subjectExponent,
        subjectBucketSize,
        subjectIsDecreasing,
        subjectMaxPrice,
        subjectMinPrice
      );

      subjectIncreaseTime = ONE_HOUR_IN_SECONDS;
    });

    async function subject(): Promise<any> {
      return await boundedStepwiseExponentialPriceAdapter.getPrice(
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

      // https://github.com/Vectorized/solady/blob/a2fd11c87fd4941ef2a075177c03456fa227c7dc/test/FixedPointMathLib.t.sol#L23
      const expOneWad = ether(2.718281828459045235);
      const expectedPrice = subjectInitialPrice.sub(expOneWad).add(ether(1));
      const tolerance = 1000;

      expect(returnedPrice).to.be.closeTo(expectedPrice, tolerance);
    });

    describe("when it is not decreasing", async () => {
      beforeEach(async () => {
        subjectIsDecreasing = false;
        subjectMaxPrice = ether(110);
        subjectMinPrice = ether(100);
        subjectPriceAdapterConfigData = await boundedStepwiseExponentialPriceAdapter.getEncodedData(
          subjectInitialPrice,
          subjectCoefficient,
          subjectExponent,
          subjectBucketSize,
          subjectIsDecreasing,
          subjectMaxPrice,
          subjectMinPrice
        );
      });

      afterEach(async () => {
        subjectIsDecreasing = true;
        subjectMaxPrice = ether(100);
        subjectMinPrice = ether(90);
        subjectPriceAdapterConfigData = await boundedStepwiseExponentialPriceAdapter.getEncodedData(
          subjectInitialPrice,
          subjectCoefficient,
          subjectExponent,
          subjectBucketSize,
          subjectIsDecreasing,
          subjectMaxPrice,
          subjectMinPrice
        );
      });

      it("should return the correct price", async () => {
        const returnedPrice = await subject();

        // https://github.com/Vectorized/solady/blob/a2fd11c87fd4941ef2a075177c03456fa227c7dc/test/FixedPointMathLib.t.sol#L23
        const expOneWad = ether(2.718281828459045235);
        const expectedPrice = expOneWad.add(subjectInitialPrice).sub(ether(1));

        const tolerance = 1000;

        expect(returnedPrice).to.be.closeTo(expectedPrice, tolerance);
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

    describe("when the computation for exponential function argument will overflow", async () => {
      beforeEach(async () => {
        subjectExponent = MAX_UINT_256;
        subjectPriceAdapterConfigData = await boundedStepwiseExponentialPriceAdapter.getEncodedData(
          subjectInitialPrice,
          subjectCoefficient,
          subjectExponent,
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
          subjectPriceAdapterConfigData = await boundedStepwiseExponentialPriceAdapter.getEncodedData(
            subjectInitialPrice,
            subjectCoefficient,
            subjectExponent,
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

    describe("when the computation for price change will overflow", async () => {
      beforeEach(async () => {
        subjectPriceAdapterConfigData = await boundedStepwiseExponentialPriceAdapter.getEncodedData(
          subjectInitialPrice,
          MAX_UINT_256,
          subjectExponent,
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
          subjectPriceAdapterConfigData = await boundedStepwiseExponentialPriceAdapter.getEncodedData(
            subjectInitialPrice,
            MAX_UINT_256,
            subjectExponent,
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
        subjectExponent = subjectInitialPrice;
        subjectPriceAdapterConfigData = await boundedStepwiseExponentialPriceAdapter.getEncodedData(
          subjectInitialPrice,
          subjectCoefficient,
          subjectExponent,
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
        subjectExponent = subjectInitialPrice.div(3);
        subjectPriceAdapterConfigData = await boundedStepwiseExponentialPriceAdapter.getEncodedData(
          subjectInitialPrice,
          subjectCoefficient,
          subjectExponent,
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
        subjectIsDecreasing = false;
        subjectInitialPrice = MAX_UINT_256;
        subjectMaxPrice = MAX_UINT_256;
        subjectMinPrice = ether(100);
        subjectPriceAdapterConfigData = await boundedStepwiseExponentialPriceAdapter.getEncodedData(
          subjectInitialPrice,
          subjectCoefficient,
          subjectExponent,
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

    describe("when it is not decreasing and the price computation returns above the maximum", async () => {
      beforeEach(async () => {
        subjectExponent = subjectInitialPrice.div(3);
        subjectIsDecreasing = false;
        subjectMaxPrice = ether(110);
        subjectMinPrice = ether(100);
        subjectPriceAdapterConfigData = await boundedStepwiseExponentialPriceAdapter.getEncodedData(
          subjectInitialPrice,
          subjectCoefficient,
          subjectExponent,
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
          subjectPriceAdapterConfigData = await boundedStepwiseExponentialPriceAdapter.getEncodedData(
            subjectInitialPrice,
            subjectCoefficient,
            subjectExponent,
            subjectBucketSize,
            subjectIsDecreasing,
            subjectMaxPrice,
            subjectMinPrice
          );
        });

        it("should revert with 'BoundedStepwiseExponentialPriceAdapter: Invalid params'", async () => {
          await expect(subject()).to.be.revertedWith("BoundedStepwiseExponentialPriceAdapter: Invalid params");
        });
      });

      describe("when the coefficient is 0", async () => {
        beforeEach(async () => {
          subjectCoefficient = ZERO;
          subjectPriceAdapterConfigData = await boundedStepwiseExponentialPriceAdapter.getEncodedData(
            subjectInitialPrice,
            subjectCoefficient,
            subjectExponent,
            subjectBucketSize,
            subjectIsDecreasing,
            subjectMaxPrice,
            subjectMinPrice
          );
        });

        it("should revert with 'BoundedStepwiseExponentialPriceAdapter: Invalid params'", async () => {
          await expect(subject()).to.be.revertedWith("BoundedStepwiseExponentialPriceAdapter: Invalid params");
        });
      });

      describe("when the exponent is 0", async () => {
        beforeEach(async () => {
          subjectExponent = ZERO;
          subjectPriceAdapterConfigData = await boundedStepwiseExponentialPriceAdapter.getEncodedData(
            subjectInitialPrice,
            subjectCoefficient,
            subjectExponent,
            subjectBucketSize,
            subjectIsDecreasing,
            subjectMaxPrice,
            subjectMinPrice
          );
        });

        it("should revert with 'BoundedStepwiseExponentialPriceAdapter: Invalid params'", async () => {
          await expect(subject()).to.be.revertedWith("BoundedStepwiseExponentialPriceAdapter: Invalid params");
        });
      });

      describe("when the bucket size is 0", async () => {
        beforeEach(async () => {
          subjectBucketSize = ZERO;
          subjectPriceAdapterConfigData = await boundedStepwiseExponentialPriceAdapter.getEncodedData(
            subjectInitialPrice,
            subjectCoefficient,
            subjectExponent,
            subjectBucketSize,
            subjectIsDecreasing,
            subjectMaxPrice,
            subjectMinPrice
          );
        });

        it("should revert with 'BoundedStepwiseExponentialPriceAdapter: Invalid params'", async () => {
          await expect(subject()).to.be.revertedWith("BoundedStepwiseExponentialPriceAdapter: Invalid params");
        });
      });

      describe("when the initial price is greater than the max price", async () => {
        beforeEach(async () => {
          subjectMaxPrice = ZERO;
          subjectPriceAdapterConfigData = await boundedStepwiseExponentialPriceAdapter.getEncodedData(
            subjectInitialPrice,
            subjectCoefficient,
            subjectExponent,
            subjectBucketSize,
            subjectIsDecreasing,
            subjectMaxPrice,
            subjectMinPrice
          );
        });

        it("should revert with 'BoundedStepwiseExponentialPriceAdapter: Invalid params'", async () => {
          await expect(subject()).to.be.revertedWith("BoundedStepwiseExponentialPriceAdapter: Invalid params");
        });
      });

      describe("when the initial price is less than the minimum price", async () => {
        beforeEach(async () => {
          subjectMinPrice = ether(100).add(1);
          subjectPriceAdapterConfigData = await boundedStepwiseExponentialPriceAdapter.getEncodedData(
            subjectInitialPrice,
            subjectCoefficient,
            subjectExponent,
            subjectBucketSize,
            subjectIsDecreasing,
            subjectMaxPrice,
            subjectMinPrice
          );
        });

        it("should revert with 'BoundedStepwiseExponentialPriceAdapter: Invalid params'", async () => {
          await expect(subject()).to.be.revertedWith("BoundedStepwiseExponentialPriceAdapter: Invalid params");
        });
      });
    });
  });

  describe("#isPriceAdapterConfigDataValid", async () => {
    let subjectInitialPrice: BigNumber;
    let subjectCoefficient: BigNumber;
    let subjectExponent: BigNumber;
    let subjectBucketSize: BigNumber;
    let subjectIsDecreasing: boolean;
    let subjectMaxPrice: BigNumber;
    let subjectMinPrice: BigNumber;

    let subjectPriceAdapterConfigData: Bytes;

    beforeEach(async () => {
      subjectInitialPrice = ether(100);
      subjectCoefficient = ether(1);
      subjectExponent = ether(1);
      subjectBucketSize = ONE_HOUR_IN_SECONDS;
      subjectIsDecreasing = false;
      subjectMaxPrice = ether(110);
      subjectMinPrice = ether(100);

      subjectPriceAdapterConfigData = await boundedStepwiseExponentialPriceAdapter.getEncodedData(
        subjectInitialPrice,
        subjectCoefficient,
        subjectExponent,
        subjectBucketSize,
        subjectIsDecreasing,
        subjectMaxPrice,
        subjectMinPrice
      );
    });

    async function subject(): Promise<any> {
      return await boundedStepwiseExponentialPriceAdapter.isPriceAdapterConfigDataValid(subjectPriceAdapterConfigData);
    }

    it("should return true for valid parameters", async () => {
      const isValid = await subject();

      expect(isValid).to.eq(true);
    });

    describe("when the initial price is 0", async () => {
      beforeEach(async () => {
        subjectInitialPrice = ZERO;
        subjectPriceAdapterConfigData = await boundedStepwiseExponentialPriceAdapter.getEncodedData(
          subjectInitialPrice,
          subjectCoefficient,
          subjectExponent,
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

    describe("when the coefficient is 0", async () => {
      beforeEach(async () => {
        subjectCoefficient = ZERO;
        subjectPriceAdapterConfigData = await boundedStepwiseExponentialPriceAdapter.getEncodedData(
          subjectInitialPrice,
          subjectCoefficient,
          subjectExponent,
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

    describe("when the exponent is 0", async () => {
      beforeEach(async () => {
        subjectExponent = ZERO;
        subjectPriceAdapterConfigData = await boundedStepwiseExponentialPriceAdapter.getEncodedData(
          subjectInitialPrice,
          subjectCoefficient,
          subjectExponent,
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
        subjectPriceAdapterConfigData = await boundedStepwiseExponentialPriceAdapter.getEncodedData(
          subjectInitialPrice,
          subjectCoefficient,
          subjectExponent,
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
        subjectPriceAdapterConfigData = await boundedStepwiseExponentialPriceAdapter.getEncodedData(
          subjectInitialPrice,
          subjectCoefficient,
          subjectExponent,
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
        subjectPriceAdapterConfigData = await boundedStepwiseExponentialPriceAdapter.getEncodedData(
          subjectInitialPrice,
          subjectCoefficient,
          subjectExponent,
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
    let subjectCoefficient: number;
    let subjectExponent: BigNumber;
    let subjectBucketSize: BigNumber;
    let subjectMaxPrice: BigNumber;
    let subjectMinPrice: BigNumber;

    beforeEach(async () => {
      subjectInitialPrice = ether(100);
      subjectCoefficient = 1;
      subjectExponent = ether(1);
      subjectBucketSize = ONE_HOUR_IN_SECONDS;
      subjectMaxPrice = ether(110);
      subjectMinPrice = ether(100);
    });

    async function subject(): Promise<any> {
      return await boundedStepwiseExponentialPriceAdapter.areParamsValid(
        subjectInitialPrice,
        subjectCoefficient,
        subjectExponent,
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

    describe("when the coefficient is 0", async () => {
      beforeEach(async () => {
        subjectCoefficient = 0;
      });

      it("should return false", async () => {
        const isValid = await subject();

        expect(isValid).to.eq(false);
      });
    });

    describe("when the exponent is 0", async () => {
      beforeEach(async () => {
        subjectExponent = ZERO;
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
    let subjectCoefficient: BigNumber;
    let subjectExponent: BigNumber;
    let subjectBucketSize: BigNumber;
    let subjectIsDecreasing: boolean;
    let subjectMaxPrice: BigNumber;
    let subjectMinPrice: BigNumber;

    let subjectPriceAdapterConfigData: Bytes;

    beforeEach(async () => {
      subjectInitialPrice = ether(100);
      subjectCoefficient = ether(1);
      subjectExponent = ether(1);
      subjectBucketSize = ONE_HOUR_IN_SECONDS;
      subjectIsDecreasing = false;
      subjectMaxPrice = ether(110);
      subjectMinPrice = ether(100);

      subjectPriceAdapterConfigData = utils.defaultAbiCoder.encode(
        ["uint256", "uint256", "uint256", "uint256", "bool", "uint256", "uint256"],
        [
          subjectInitialPrice,
          subjectCoefficient,
          subjectExponent,
          subjectBucketSize,
          subjectIsDecreasing,
          subjectMaxPrice,
          subjectMinPrice
        ]
      );
    });

    async function subject(): Promise<any> {
      return await boundedStepwiseExponentialPriceAdapter.getDecodedData(subjectPriceAdapterConfigData);
    }

    it("should decode data correctly and return the expected values", async () => {
      const [
        decodedInitialPrice,
        decodedCoefficient,
        decodedExponent,
        decodedBucketSize,
        decodedIsDecreasing,
        decodedMaxPrice,
        decodedMinPrice
      ] = await subject();

      expect(decodedInitialPrice).to.eq(subjectInitialPrice);
      expect(decodedCoefficient).to.eq(subjectCoefficient);
      expect(decodedExponent).to.eq(subjectExponent);
      expect(decodedBucketSize).to.eq(subjectBucketSize);
      expect(decodedIsDecreasing).to.eq(subjectIsDecreasing);
      expect(decodedMaxPrice).to.eq(subjectMaxPrice);
      expect(decodedMinPrice).to.eq(subjectMinPrice);
    });
  });

  describe("#getEncodedData", async () => {
    let subjectInitialPrice: BigNumber;
    let subjectCoefficient: BigNumber;
    let subjectExponent: BigNumber;
    let subjectBucketSize: BigNumber;
    let subjectIsDecreasing: boolean;
    let subjectMaxPrice: BigNumber;
    let subjectMinPrice: BigNumber;

    beforeEach(async () => {
      subjectInitialPrice = ether(100);
      subjectCoefficient = ether(1);
      subjectExponent = ether(1);
      subjectBucketSize = ONE_HOUR_IN_SECONDS;
      subjectIsDecreasing = false;
      subjectMaxPrice = ether(110);
      subjectMinPrice = ether(100);
    });

    async function subject(): Promise<any> {
      return await boundedStepwiseExponentialPriceAdapter.getEncodedData(
        subjectInitialPrice,
        subjectCoefficient,
        subjectExponent,
        subjectBucketSize,
        subjectIsDecreasing,
        subjectMaxPrice,
        subjectMinPrice
      );
    }

    it("should encode data correctly and match the expected encoded representation", async () => {
      const encodedData = await subject();

      const expectedData = utils.defaultAbiCoder.encode(
        ["uint256", "uint256", "uint256", "uint256", "bool", "uint256", "uint256"],
        [
          subjectInitialPrice,
          subjectCoefficient,
          subjectExponent,
          subjectBucketSize,
          subjectIsDecreasing,
          subjectMaxPrice,
          subjectMinPrice
        ]
      );

      expect(encodedData).to.eq(expectedData);
    });
  });
});
