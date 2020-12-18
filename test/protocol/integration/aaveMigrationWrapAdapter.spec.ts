import "module-alias/register";
import { BigNumber } from "ethers/utils";

import { Address, Account } from "@utils/types";
import { ZERO } from "@utils/constants";
import { AaveMigrationWrapAdapter } from "@utils/contracts";
import DeployHelper from "@utils/deploys";
import {
  addSnapshotBeforeRestoreAfterEach,
  ether,
  getAccounts,
  getWaffleExpect,
  getAaveFixture
} from "@utils/index";
import { AaveFixture } from "@utils/fixtures";


const expect = getWaffleExpect();

describe("AaveMigrationWrapAdapter", () => {
  let owner: Account;
  let deployer: DeployHelper;
  let aaveMigrationWrapAdapter: AaveMigrationWrapAdapter;
  let mockOtherUnderlyingToken: Account;
  let mockOtherWrappedToken: Account;
  let aaveSetup: AaveFixture;

  before(async () => {
    [
      owner,
      mockOtherUnderlyingToken,
      mockOtherWrappedToken,
    ] = await getAccounts();

    deployer = new DeployHelper(owner.wallet);

    aaveSetup = getAaveFixture(owner.address);
    await aaveSetup.initialize();

    // Note: In production, the spender is the
    aaveMigrationWrapAdapter = await deployer.adapters.deployAaveMigrationWrapAdapter(
      aaveSetup.lendToAaveMigrator.address,
      aaveSetup.lendToken.address,
      aaveSetup.aaveToken.address
    );
  });

  addSnapshotBeforeRestoreAfterEach();

  describe("#constructor", async () => {
    let subjectAaveMigrationProxy: Address;
    let subjectLendToken: Address;
    let subjectAaveToken: Address;

    beforeEach(async () => {
      subjectAaveMigrationProxy = aaveSetup.lendToAaveMigrator.address;
      subjectLendToken = aaveSetup.lendToken.address;
      subjectAaveToken = aaveSetup.aaveToken.address;
    });

    async function subject(): Promise<any> {
      return deployer.adapters.deployAaveMigrationWrapAdapter(
        subjectAaveMigrationProxy,
        subjectLendToken,
        subjectAaveToken
      );
    }

    it("should have the correct migration proxy address", async () => {
      const deployedAaveMigrationWrapAdapter = await subject();

      const actualAaveMigrationProxy = await deployedAaveMigrationWrapAdapter.lendToAaveMigrationProxy();
      expect(actualAaveMigrationProxy).to.eq(subjectAaveMigrationProxy);
    });

    it("should have the correct LEND token address", async () => {
      const deployedAaveMigrationWrapAdapter = await subject();

      const actualLendTokenAddress = await deployedAaveMigrationWrapAdapter.lendToken();
      expect(actualLendTokenAddress).to.eq(subjectLendToken);
    });
  });

  describe("#getSpenderAddress", async () => {
    async function subject(): Promise<any> {
      return aaveMigrationWrapAdapter.getSpenderAddress(
        aaveSetup.lendToken.address,
        aaveSetup.aaveToken.address,
      );
    }

    it("should return the correct spender address", async () => {
      const spender = await subject();

      expect(spender).to.eq(aaveSetup.lendToAaveMigrator.address);
    });
  });

  describe("#getWrapCallData", async () => {
    let subjectUnderlyingToken: Address;
    let subjectWrappedToken: Address;
    let subjectUnderlyingUnits: BigNumber;

    beforeEach(async () => {
      subjectUnderlyingToken = aaveSetup.lendToken.address;
      subjectWrappedToken = aaveSetup.aaveToken.address;
      subjectUnderlyingUnits = ether(2);
    });

    async function subject(): Promise<any> {
      return aaveMigrationWrapAdapter.getWrapCallData(subjectUnderlyingToken, subjectWrappedToken, subjectUnderlyingUnits);
    }

    it("should return correct data for valid pair", async () => {
      const [targetAddress, ethValue, callData] = await subject();

      const expectedCallData = aaveSetup.lendToAaveMigrator.interface.functions.migrateFromLEND.encode([subjectUnderlyingUnits]);

      expect(targetAddress).to.eq(aaveSetup.lendToAaveMigrator.address);
      expect(ethValue).to.eq(ZERO);
      expect(callData).to.eq(expectedCallData);
    });

    describe("when underlying asset is not LEND token", () => {
      beforeEach(async () => {
        subjectUnderlyingToken = mockOtherUnderlyingToken.address;
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Must be LEND token");
      });
    });

    describe("when wrapped asset is not AAVE token", () => {
      beforeEach(async () => {
        subjectWrappedToken = mockOtherWrappedToken.address;
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Must be AAVE token");
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
      return aaveMigrationWrapAdapter.getUnwrapCallData(subjectUnderlyingToken, subjectWrappedToken, subjectWrappedTokenUnits);
    }

    it("should revert", async () => {
      await expect(subject()).to.be.revertedWith("AAVE migration cannot be reversed");
    });
  });
});
