import "module-alias/register";
import { BigNumber } from "ethers";

import { Address } from "@utils/types";
import { Account } from "@utils/test/types";
import { ZERO, ZERO_BYTES } from "@utils/constants";
import { ERC4626WrapV2Adapter, ERC4626Mock, StandardTokenMock } from "@utils/contracts";
import DeployHelper from "@utils/deploys";
import { ether } from "@utils/index";
import {
  addSnapshotBeforeRestoreAfterEach,
  getAccounts,
  getRandomAddress,
  getSystemFixture,
  getWaffleExpect,
} from "@utils/test/index";
import { SystemFixture } from "@utils/fixtures";

const expect = getWaffleExpect();

describe("ERC4626WrapV2Adapter", () => {

  let owner: Account;
  let deployer: DeployHelper;

  let setV2Setup: SystemFixture;

  let wrapAdapter: ERC4626WrapV2Adapter;

  let underlyingToken: StandardTokenMock;
  let wrappedToken: ERC4626Mock;

  before(async () => {
    [ owner ] = await getAccounts();

    deployer = new DeployHelper(owner.wallet);

    setV2Setup = getSystemFixture(owner.address);

    await setV2Setup.initialize();

    underlyingToken = setV2Setup.dai;
    wrappedToken = await deployer.mocks.deployERC4626Mock("maDAI", "maDAI", setV2Setup.dai.address);

    wrapAdapter = await deployer.adapters.deployERC4626WrapV2Adapter();
  });

  addSnapshotBeforeRestoreAfterEach();

  describe("#getSpenderAddress", async () => {
    async function subject(): Promise<any> {
      return wrapAdapter.getSpenderAddress(underlyingToken.address, wrappedToken.address);
    }

    it("should return the correct spender address", async () => {
      const spender = await subject();

      expect(spender).to.eq(wrappedToken.address);
    });
  });

  describe("#getWrapCallData", async () => {
    let subjectUnderlyingToken: Address;
    let subjectWrappedToken: Address;
    let subjectUnderlyingUnits: BigNumber;
    let subjectTo: Address;
    let subjectWrapData: string;

    beforeEach(async () => {
      subjectUnderlyingToken = underlyingToken.address;
      subjectWrappedToken = wrappedToken.address;
      subjectUnderlyingUnits = ether(2);
      subjectTo = await getRandomAddress();
      subjectWrapData = ZERO_BYTES;
    });

    async function subject(): Promise<[string, BigNumber, string]> {
      return wrapAdapter.getWrapCallData(subjectUnderlyingToken, subjectWrappedToken, subjectUnderlyingUnits, subjectTo, subjectWrapData);
    }

    it("should return correct data for valid pair", async () => {
      const [targetAddress, ethValue, callData] = await subject();

      const expectedCallData = wrappedToken.interface.encodeFunctionData(
        "deposit",
        [subjectUnderlyingUnits, subjectTo]
      );

      expect(targetAddress).to.eq(wrappedToken.address);
      expect(ethValue).to.eq(ZERO);
      expect(callData).to.eq(expectedCallData);
    });

    describe("when invalid wrapped token / underlying token pair", () => {
      beforeEach(async () => {
        subjectUnderlyingToken = setV2Setup.usdc.address;
        subjectWrappedToken = wrappedToken.address;
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Must be a valid token pair");
      });
    });
  });

  describe("#getUnwrapCallData", async () => {
    let subjectUnderlyingToken: Address;
    let subjectWrappedToken: Address;
    let subjectWrappedTokenUnits: BigNumber;
    let subjectTo: Address;
    let subjectUnwrapData: string;

    beforeEach(async () => {
      subjectUnderlyingToken = underlyingToken.address;
      subjectWrappedToken = wrappedToken.address;
      subjectWrappedTokenUnits = ether(2);
      subjectTo = await getRandomAddress();
      subjectUnwrapData = ZERO_BYTES;
    });

    async function subject(): Promise<[string, BigNumber, string]> {
      return wrapAdapter.getUnwrapCallData(subjectUnderlyingToken, subjectWrappedToken, subjectWrappedTokenUnits, subjectTo, subjectUnwrapData);
    }

    it("should return correct data for valid pair", async () => {
      const [targetAddress, ethValue, callData] = await subject();

      const expectedCallData = wrappedToken.interface.encodeFunctionData(
        "redeem",
        [subjectWrappedTokenUnits, subjectTo, subjectTo]
      );

      expect(targetAddress).to.eq(wrappedToken.address);
      expect(ethValue).to.eq(ZERO);
      expect(callData).to.eq(expectedCallData);
    });

    describe("when invalid wrapped token / underlying token pair", () => {
      beforeEach(async () => {
        subjectUnderlyingToken = setV2Setup.usdc.address;
        subjectWrappedToken = wrappedToken.address;
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Must be a valid token pair");
      });
    });
  });
});
