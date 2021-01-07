import { BigNumber } from "@ethersproject/bignumber";

import { Account } from "../../utils/types";
import { PRECISE_UNIT, MIN_INT_256, MAX_INT_256, ZERO } from "../../utils/constants";
import { PreciseUnitMathMock } from "../../utils/contracts";
import DeployHelper from "../../utils/deploys";
import {
  addSnapshotBeforeRestoreAfterEach,
  ether,
  getAccounts,
  getWaffleExpect,
  divDown,
  preciseDiv,
  preciseDivCeil,
  preciseMul,
  preciseMulCeil,
  preciseMulCeilInt,
  preciseDivCeilInt,
} from "../../utils";

const expect = getWaffleExpect();

describe("PreciseUnitMath", () => {
  let owner: Account;
  let deployer: DeployHelper;

  let mathMock: PreciseUnitMathMock;

  // Used to make sure rounding is done correctly, 1020408168544454473
  const preciseNumber = BigNumber.from("0x0e2937d2abffc749");

  before(async () => {
    [
      owner,
    ] = await getAccounts();

    deployer = new DeployHelper(owner.wallet);

    mathMock = await deployer.mocks.deployPreciseUnitMathMock();
  });

  addSnapshotBeforeRestoreAfterEach();

  describe("#preciseUnit", async () => {
    async function subject(): Promise<BigNumber> {
      return mathMock.preciseUnit();
    }

    it("returns the correct number", async () => {
      const preciseUnit = await subject();
      expect(preciseUnit).to.eq(PRECISE_UNIT);
    });
  });

  describe("#preciseUnitInt", async () => {
    async function subject(): Promise<BigNumber> {
      return mathMock.preciseUnitInt();
    }

    it("returns the correct number", async () => {
      const preciseUnitInt = await subject();
      expect(preciseUnitInt).to.eq(PRECISE_UNIT);
    });
  });

  describe("#maxInt256", async () => {
    async function subject(): Promise<BigNumber> {
      return mathMock.maxInt256();
    }

    it("returns the correct number", async () => {
      const maxInt256 = await subject();
      expect(maxInt256).to.eq(MAX_INT_256);
    });
  });

  describe("#minInt256", async () => {
    async function subject(): Promise<BigNumber> {
      return mathMock.minInt256();
    }

    it("returns the correct number", async () => {
      const minInt256 = await subject();
      expect(minInt256).to.eq(MIN_INT_256);
    });
  });

  describe("#preciseMul: uint256", async () => {
    let subjectA: BigNumber;
    let subjectB: BigNumber;

    beforeEach(async () => {
      subjectA = preciseNumber;
      subjectB = ether(.3);
    });

    async function subject(): Promise<BigNumber> {
      return mathMock.preciseMul(subjectA, subjectB);
    }

    it("returns the correct number", async () => {
      const product = await subject();

      const expectedProduct = preciseMul(subjectA, subjectB);
      expect(product).to.eq(expectedProduct);
    });
  });

  describe("#preciseMul: int256", async () => {
    let subjectA: BigNumber;
    let subjectB: BigNumber;

    beforeEach(async () => {
      subjectA = preciseNumber;
      subjectB = ether(.3).mul(-1);
    });

    async function subject(): Promise<BigNumber> {
      return mathMock.preciseMulInt(subjectA, subjectB);
    }

    it("returns the correct number", async () => {
      const product = await subject();

      const expectedProduct = preciseMul(subjectA, subjectB);
      expect(product).to.eq(expectedProduct);
    });
  });

  describe("#preciseMulCeil: uint256", async () => {
    let subjectA: BigNumber;
    let subjectB: BigNumber;

    beforeEach(async () => {
      subjectA = preciseNumber;
      subjectB = ether(.3);
    });

    async function subject(): Promise<BigNumber> {
      return mathMock.preciseMulCeil(subjectA, subjectB);
    }

    it("returns the correct number", async () => {
      const product = await subject();

      const expectedProduct = preciseMulCeil(subjectA, subjectB);
      expect(product).to.eq(expectedProduct);
    });

    describe("when a is 0", async () => {
      beforeEach(async () => {
        subjectA = ZERO;
      });

      it("should return 0", async () => {
        const product = await subject();
        expect(product).to.eq(ZERO);
      });
    });

    describe("when b is 0", async () => {
      beforeEach(async () => {
        subjectB = ZERO;
      });

      it("should return 0", async () => {
        const product = await subject();
        expect(product).to.eq(ZERO);
      });
    });
  });

  describe("#preciseDiv: uint256", async () => {
    let subjectA: BigNumber;
    let subjectB: BigNumber;

    beforeEach(async () => {
      subjectA = preciseNumber;
      subjectB = ether(.03);
    });

    async function subject(): Promise<[BigNumber]> {
      return mathMock.functions["preciseDiv(uint256,uint256)"](subjectA, subjectB);
    }

    it("returns the correct number", async () => {
      const product = await subject();

      const expectedProduct = preciseDiv(subjectA, subjectB);
      expect(product[0]).to.eq(expectedProduct);
    });
  });

  describe("#preciseDivCeil: uint256", async () => {
    let subjectA: BigNumber;
    let subjectB: BigNumber;

    beforeEach(async () => {
      subjectA = preciseNumber;
      subjectB = ether(.3);
    });

    async function subject(): Promise<BigNumber> {
      return mathMock.preciseDivCeil(subjectA, subjectB);
    }

    it("returns the correct number", async () => {
      const division = await subject();

      const expectedDivision = preciseDivCeil(subjectA, subjectB);
      expect(division).to.eq(expectedDivision);
    });

    describe("when a is 0", async () => {
      beforeEach(async () => {
        subjectA = ZERO;
      });

      it("should return 0", async () => {
        const division = await subject();
        expect(division).to.eq(ZERO);
      });
    });

    describe("when b is 0", async () => {
      beforeEach(async () => {
        subjectA = ZERO;
        subjectB = ZERO;
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Cant divide by 0");
      });
    });
  });

  describe("#divDown: int256", async () => {
    let subjectA: BigNumber;
    let subjectB: BigNumber;

    beforeEach(async () => {
      subjectA = ether(4);
      subjectB = ether(2);
    });

    async function subject(): Promise<BigNumber> {
      return mathMock.divDown(subjectA, subjectB);
    }

    it("returns the correct number", async () => {
      const division = await subject();

      const expectedDivision = subjectA.div(subjectB);
      expect(division).to.eq(expectedDivision);
    });

    describe("when result is negative", async () => {
      beforeEach(async () => {
        subjectB = ether(2).mul(-1);
      });

      it("should return the correct number", async () => {
        const division = await subject();
        const expectedDivision = divDown(subjectA, subjectB);
        expect(division).to.eq(expectedDivision);
      });
    });

    describe("when result is negative and the value is rounded", async () => {
      beforeEach(async () => {
        subjectB = ether(-4 / 3);
      });

      it("should return the correct number", async () => {
        const division = await subject();
        const expectedDivision = divDown(subjectA, subjectB);
        expect(division).to.eq(expectedDivision);
      });
    });

    describe("when b is 0", async () => {
      beforeEach(async () => {
        subjectB = ZERO;
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Cant divide by 0");
      });
    });

    describe("when a is the max int and b is -1", async () => {
      beforeEach(async () => {
        subjectA = BigNumber.from(MIN_INT_256);
        subjectB = BigNumber.from(-1);
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Invalid input");
      });
    });
  });

  describe("#conservativePreciseMul: int256", async () => {
    let subjectA: BigNumber;
    let subjectB: BigNumber;

    beforeEach(async () => {
      subjectA = preciseNumber;
      subjectB = ether(.3);
    });

    async function subject(): Promise<BigNumber> {
      return mathMock.conservativePreciseMul(subjectA, subjectB);
    }

    it("returns the correct number", async () => {
      const division = await subject();

      const expectedMultiplication = preciseMul(subjectA, subjectB);
      expect(division).to.eq(expectedMultiplication);
    });

    describe("when result is negative", async () => {
      beforeEach(async () => {
        subjectB = ether(0.3).mul(-1);
      });

      it("should return the correct number", async () => {
        const division = await subject();
        const expectedMultiplication = preciseMulCeilInt(subjectA, subjectB);
        expect(division).to.eq(expectedMultiplication);
      });
    });

    describe("when a is 0", async () => {
      beforeEach(async () => {
        subjectA = ZERO;
      });

      it("should return 0", async () => {
        const division = await subject();
        expect(division).to.eq(ZERO);
      });
    });
  });

  describe("#conservativePreciseDiv: int256", async () => {
    let subjectA: BigNumber;
    let subjectB: BigNumber;

    beforeEach(async () => {
      subjectA = preciseNumber;
      subjectB = ether(.3);
    });

    async function subject(): Promise<BigNumber> {
      return mathMock.conservativePreciseDiv(subjectA, subjectB);
    }

    it("returns the correct number", async () => {
      const division = await subject();

      const expectedDivision = preciseDiv(subjectA, subjectB);
      expect(division).to.eq(expectedDivision);
    });

    describe("when result is negative", async () => {
      beforeEach(async () => {
        subjectB = ether(0.3).mul(-1);
      });

      it("should return the correct number", async () => {
        const division = await subject();
        const expectedDivision = preciseDivCeilInt(subjectA, subjectB);
        expect(division).to.eq(expectedDivision);
      });
    });

    describe("when a is 0", async () => {
      beforeEach(async () => {
        subjectA = ZERO;
      });

      it("should return 0", async () => {
        const division = await subject();
        expect(division).to.eq(ZERO);
      });
    });

    describe("when both values are 0", async () => {
      beforeEach(async () => {
        subjectA = ZERO;
        subjectB = ZERO;
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Cant divide by 0");
      });
    });
  });

  describe("#safePower", async () => {
    let subjectBase: BigNumber;
    let subjectPower: BigNumber;

    beforeEach(async () => {
      subjectBase = BigNumber.from(10);
      subjectPower = BigNumber.from(5);
    });

    async function subject(): Promise<BigNumber> {
      return mathMock.safePower(
        subjectBase,
        subjectPower,
      );
    }

    it("returns the correct value", async () => {
      const result = await subject();

      const expectedResult =
        BigNumber.from(subjectBase).pow(subjectPower.toNumber());
      expect(result).to.eq(expectedResult);
    });

    describe("when the the base is 1", async () => {
      beforeEach(async () => {
        subjectBase = BigNumber.from(1);
        subjectPower = BigNumber.from(5);
      });

      it("returns the correct value", async () => {
        const result = await subject();

        const expectedResult =
          BigNumber.from(subjectBase).pow(subjectPower.toNumber());
        expect(result).to.eq(expectedResult);
      });
    });

    describe("when the values overflow", async () => {
      beforeEach(async () => {
        subjectBase = BigNumber.from(10000);
        subjectPower = BigNumber.from(100);
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("SafeMath: multiplication overflow");
      });
    });

    describe("when the the base is 0", async () => {
      beforeEach(async () => {
        subjectBase = BigNumber.from(0);
        subjectPower = BigNumber.from(5);
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Value must be positive");
      });
    });
  });
});
