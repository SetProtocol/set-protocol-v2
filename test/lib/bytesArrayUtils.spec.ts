import "module-alias/register";
import { BigNumber } from "ethers";
import { solidityPack } from "ethers/lib/utils";

import { Address, Bytes } from "@utils/types";
import { Account } from "@utils/test/types";
import { MAX_UINT_256 } from "@utils/constants";
import { BytesArrayUtilsMock } from "@utils/contracts";
import DeployHelper from "@utils/deploys";
import {
  addSnapshotBeforeRestoreAfterEach,
  getAccounts,
  getWaffleExpect,
  getRandomAddress
} from "@utils/test/index";

const expect = getWaffleExpect();

describe("BytesArrayUtils", () => {
  let owner: Account;
  let deployer: DeployHelper;

  let bytesArrayUtils: BytesArrayUtilsMock;


  before(async () => {
    [
      owner,
    ] = await getAccounts();

    deployer = new DeployHelper(owner.wallet);
    bytesArrayUtils = await deployer.mocks.deployBytesArrayUtilsMock();
  });

  addSnapshotBeforeRestoreAfterEach();

  describe("#toBool", async () => {
    let bool: boolean;
    let randomAddress: Address;

    let subjectBytes: Bytes;
    let subjectStart: BigNumber;

    before(async () => {
      randomAddress = await getRandomAddress();
    });

    beforeEach(async() => {
      bool = true;

      subjectBytes = solidityPack(
        ["address", "bool"],
        [randomAddress, bool]
      );
      subjectStart = BigNumber.from(20);    // Address is 20 bytes long
    });

    async function subject(): Promise<boolean> {
      return await bytesArrayUtils.testToBool(subjectBytes, subjectStart);
    }

    it("should return correct bool", async () => {
      const actualBool = await subject();

      expect(actualBool).to.eq(bool);
    });

    describe("when bool is false", async () => {
      beforeEach(async() => {
        bool = false;

        subjectBytes = solidityPack(
          ["address", "bool"],
          [randomAddress, bool]
        );
      });

      it("should return correct bool", async () => {
        const actualBool = await subject();

        expect(actualBool).to.eq(bool);
      });
    });

    describe("when start is max uint 256", async () => {
      beforeEach(() => {
        subjectStart = MAX_UINT_256;
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("toBool_overflow");
      });
    });


    describe("when start is out of bounds", async () => {
      beforeEach(() => {
        subjectStart = BigNumber.from(subjectBytes.length);
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("toBool_outOfBounds");
      });
    });
  });
});
