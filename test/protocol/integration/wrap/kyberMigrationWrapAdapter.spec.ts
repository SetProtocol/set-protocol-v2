import "module-alias/register";
import { BigNumber } from "ethers";

import { Address } from "@utils/types";
import { Account } from "@utils/test/types";
import { ZERO } from "@utils/constants";
import { KyberMigrationWrapAdapter } from "@utils/contracts";
import { KyberNetworkTokenV2 } from "@utils/contracts/kyberV3";
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
  let kyberNetworkTokenV2: KyberNetworkTokenV2;
  let kyberMigrationWrapAdapter: KyberMigrationWrapAdapter;

  let minter: Account;
  let kncLegacyToken: Account;
  let mockOtherUnderlyingToken: Account;
  let mockOtherWrappedToken: Account;

  before(async () => {
    [
      owner,
      minter,
      kncLegacyToken,
      mockOtherUnderlyingToken,
      mockOtherWrappedToken,
    ] = await getAccounts();

    deployer = new DeployHelper(owner.wallet);

    kyberNetworkTokenV2 = await deployer.external.deployKyberNetworkTokenV2();
    await kyberNetworkTokenV2.initialize(kncLegacyToken.address, minter.address);

    kyberMigrationWrapAdapter = await deployer.adapters.deployKyberMigrationWrapAdapter(
      kncLegacyToken.address,
      kyberNetworkTokenV2.address
    );
  });

  addSnapshotBeforeRestoreAfterEach();

  describe("#constructor", async () => {
    let subjectKncLegacyToken: Address;
    let subjectKncToken: Address;

    beforeEach(async () => {
      subjectKncLegacyToken = kncLegacyToken.address;
      subjectKncToken = kyberNetworkTokenV2.address;
    });

    async function subject(): Promise<any> {
      return deployer.adapters.deployKyberMigrationWrapAdapter(
        subjectKncLegacyToken,
        subjectKncToken
      );
    }

    it("should have the correct KNC Legacy token address", async () => {
      const deployKyberMigrationWrapAdapter = await subject();

      const kncLegacyToken = await deployKyberMigrationWrapAdapter.kncLegacyToken();
      const expectedKncLegacyToken = subjectKncLegacyToken;

      expect(kncLegacyToken).to.eq(expectedKncLegacyToken);
    });

    it("should have the correct KNC token address", async () => {
      const deployKyberMigrationWrapAdapter = await subject();

      const kncToken = await deployKyberMigrationWrapAdapter.kncToken();
      const expectedKncToken = subjectKncToken;

      expect(kncToken).to.eq(expectedKncToken);
    });
  });

  describe("#getSpenderAddress", async () => {
    async function subject(): Promise<any> {
      return kyberMigrationWrapAdapter.getSpenderAddress(
        kncLegacyToken.address,
        kyberNetworkTokenV2.address
      );
    }

    it("should return the correct spender address", async () => {
      const spender = await subject();

      expect(spender).to.eq(kyberNetworkTokenV2.address);
    });
  });

  describe("#getWrapCallData", async () => {
    let subjectUnderlyingToken: Address;
    let subjectWrappedToken: Address;
    let subjectUnderlyingUnits: BigNumber;

    beforeEach(async () => {
      subjectUnderlyingToken = kncLegacyToken.address;
      subjectWrappedToken = kyberNetworkTokenV2.address;
      subjectUnderlyingUnits = ether(2);
    });

    async function subject(): Promise<any> {
      return kyberMigrationWrapAdapter.getWrapCallData(subjectUnderlyingToken, subjectWrappedToken, subjectUnderlyingUnits);
    }

    it("should return correct data for valid pair", async () => {
      const [targetAddress, ethValue, callData] = await subject();

      const expectedCallData = kyberNetworkTokenV2.interface.encodeFunctionData("mintWithOldKnc", [subjectUnderlyingUnits]);

      expect(targetAddress).to.eq(kyberNetworkTokenV2.address);
      expect(ethValue).to.eq(ZERO);
      expect(callData).to.eq(expectedCallData);
    });

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
