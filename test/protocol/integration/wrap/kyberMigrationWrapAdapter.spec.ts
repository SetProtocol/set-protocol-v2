import "module-alias/register";
import { BigNumber } from "@ethersproject/bignumber";

import { Address } from "@utils/types";
import { Account } from "@utils/test/types";
import { KyberMigrationWrapAdapter } from "@utils/contracts";
import DeployHelper from "@utils/deploys";
import {
  ether,
} from "@utils/index";
import {
  addSnapshotBeforeRestoreAfterEach,
  getAccounts,
  getWaffleExpect
} from "@utils/test/index";


const expect = getWaffleExpect();

describe("KyberMigrationWrapAdapter", () => {
  let owner: Account;
  let deployer: DeployHelper;
  let kyberMigrationWrapAdapter: KyberMigrationWrapAdapter;

  let kncLegacyToKncMigrationProxy: Account;
  let kncLegacyToken: Account;
  let kncToken: Account;
  let mockOtherUnderlyingToken: Account;
  let mockOtherWrappedToken: Account;

  before(async () => {
    [
      owner,
      kncLegacyToKncMigrationProxy,
      kncLegacyToken,
      kncToken,
      mockOtherUnderlyingToken,
      mockOtherWrappedToken,
    ] = await getAccounts();

    deployer = new DeployHelper(owner.wallet);

    kyberMigrationWrapAdapter = await deployer.adapters.deployKyberMigrationWrapAdapter(
        kncLegacyToKncMigrationProxy.address,
        kncLegacyToken.address,
        kncToken.address
    );
  });

  addSnapshotBeforeRestoreAfterEach();

  describe("#constructor", async () => {
    let subjectKncLegacyToKncMigrationProxy: Address;
    let subjectKncLegacyToken: Address;
    let subjectKncToken: Address;

    beforeEach(async () => {
      subjectKncLegacyToKncMigrationProxy = kncLegacyToKncMigrationProxy.address;
      subjectKncLegacyToken = kncLegacyToken.address;
      subjectKncToken = kncToken.address;
    });

    async function subject(): Promise<any> {
      return deployer.adapters.deployKyberMigrationWrapAdapter(
        subjectKncLegacyToKncMigrationProxy,
        subjectKncLegacyToken,
        subjectKncToken
      );
    }

    it("should have the correct migration proxy address", async () => {
      const deployKyberMigrationWrapAdapter = await subject();

      const expectedKncLegacyToKncMigrationProxy = await deployKyberMigrationWrapAdapter.kncLegacyToKncMigrationProxy();
      expect(expectedKncLegacyToKncMigrationProxy).to.eq(subjectKncLegacyToKncMigrationProxy);
    });

    it("should have the correct KNC Legacy token address", async () => {
      const deployKyberMigrationWrapAdapter = await subject();

      const expectedKncLegacyToken = await deployKyberMigrationWrapAdapter.kncLegacyToken();
      expect(expectedKncLegacyToken).to.eq(subjectKncLegacyToken);
    });

    it("should have the correct KNC token address", async () => {
        const deployKyberMigrationWrapAdapter = await subject();

        const expectedKncToken = await deployKyberMigrationWrapAdapter.kncToken();
        expect(expectedKncToken).to.eq(subjectKncToken);
    });
  });

  describe("#getSpenderAddress", async () => {
    async function subject(): Promise<any> {
      return kyberMigrationWrapAdapter.getSpenderAddress(
        kncLegacyToken.address,
        kncToken.address,
      );
    }

    it("should return the correct spender address", async () => {
      const spender = await subject();

      expect(spender).to.eq(kncLegacyToKncMigrationProxy.address);
    });
  });

  describe("#getWrapCallData", async () => {
    let subjectUnderlyingToken: Address;
    let subjectWrappedToken: Address;
    let subjectUnderlyingUnits: BigNumber;

    beforeEach(async () => {
      subjectUnderlyingToken = kncLegacyToken.address;
      subjectWrappedToken = kncToken.address;
      subjectUnderlyingUnits = ether(2);
    });

    async function subject(): Promise<any> {
      return kyberMigrationWrapAdapter.getWrapCallData(subjectUnderlyingToken, subjectWrappedToken, subjectUnderlyingUnits);
    }

    // it("should return correct data for valid pair", async () => {
    //   const [targetAddress, ethValue, callData] = await subject();

    //   const expectedCallData = kncLegacyToKncWrapAdapter.interface.encodeFunctionData("mintWithOldKnc", [subjectUnderlyingUnits]);

    //   expect(targetAddress).to.eq(kncLegacyToKncMigrationProxy.address);
    //   expect(ethValue).to.eq(ZERO);
    //   expect(callData).to.eq(expectedCallData);
    // });

    describe("when underlying asset is not KNC Legacy token", () => {
      beforeEach(async () => {
        subjectUnderlyingToken = mockOtherUnderlyingToken.address;
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Must be KNC Legacy token");
      });
    });

    describe("when wrapped asset is not KNC token", () => {
      beforeEach(async () => {
        subjectWrappedToken = mockOtherWrappedToken.address;
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Must be KNC token");
      });
    });
  });

  describe("#getUnwrapCallData", async () => {
    let subjectUnderlyingToken: Address;
    let subjectWrappedToken: Address;
    let subjectWrappedTokenUnits: BigNumber;

    beforeEach(async () => {
      subjectUnderlyingToken = mockOtherUnderlyingToken.address;
      subjectWrappedToken = mockOtherWrappedToken.address;
      subjectWrappedTokenUnits = ether(2);
    });

    async function subject(): Promise<any> {
      return kyberMigrationWrapAdapter.getUnwrapCallData(subjectUnderlyingToken, subjectWrappedToken, subjectWrappedTokenUnits);
    }

    it("should revert", async () => {
      await expect(subject()).to.be.revertedWith("KNC migration cannot be reversed");
    });
  });
});
