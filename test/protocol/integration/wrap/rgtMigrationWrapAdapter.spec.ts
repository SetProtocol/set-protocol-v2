import "module-alias/register";

import { BigNumber } from "ethers";
import { Address } from "@utils/types";
import { Account } from "@utils/test/types";
import { ZERO } from "@utils/constants";
import { RgtMigrationWrapAdapter } from "@utils/contracts";
import { TribePegExchangerMock } from "@utils/contracts";
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

describe("RgtMigrationWrapAdapter", () => {
  let owner: Account;
  let deployer: DeployHelper;
  let pegExchanger: TribePegExchangerMock;
  let rgtMigrationWrapAdapter: RgtMigrationWrapAdapter;

  before(async () => {
    [
      owner,
    ] = await getAccounts();

    deployer = new DeployHelper(owner.wallet);

    const rgt = await deployer.mocks.deployTokenMock(owner.address);
    const tribe = await deployer.mocks.deployTokenMock(owner.address);
    pegExchanger = await deployer.mocks.deployTribePegExchangerMock(rgt.address, tribe.address);

    rgtMigrationWrapAdapter = await deployer.adapters.deployRgtMigrationWrapAdapter(pegExchanger.address);
  });

  addSnapshotBeforeRestoreAfterEach();

  describe("#constructor", async () => {
    let subjectPegExchanger: Address;

    beforeEach(async () => {
      subjectPegExchanger = pegExchanger.address;
    });

    async function subject(): Promise<any> {
      return deployer.adapters.deployRgtMigrationWrapAdapter(subjectPegExchanger);
    }

    it("should have the correct PegExchanger address", async () => {
      const deployRgtMigrationWrapAdapter = await subject();

      const pegExchanger = await deployRgtMigrationWrapAdapter.pegExchanger();
      const expectedPegExchanger = subjectPegExchanger;

      expect(pegExchanger).to.eq(expectedPegExchanger);
    });
  });

  describe("#getSpenderAddress", async () => {
    async function subject(): Promise<any> {
      return rgtMigrationWrapAdapter.getSpenderAddress(owner.address, owner.address);
    }

    it("should return the correct spender address", async () => {
      const spender = await subject();

      expect(spender).to.eq(pegExchanger.address);
    });
  });

  describe("#getWrapCallData", async () => {
    let subjectUnderlyingUnits: BigNumber;

    beforeEach(async () => {
      subjectUnderlyingUnits = ether(2);
    });

    async function subject(): Promise<any> {
      return rgtMigrationWrapAdapter.getWrapCallData(owner.address, owner.address, subjectUnderlyingUnits);
    }

    it("should return correct data for valid pair", async () => {
      const [targetAddress, ethValue, callData] = await subject();

      const expectedCallData = pegExchanger.interface.encodeFunctionData("exchange", [subjectUnderlyingUnits]);

      expect(targetAddress).to.eq(pegExchanger.address);
      expect(ethValue).to.eq(ZERO);
      expect(callData).to.eq(expectedCallData);
    });
  });

  describe("#getUnwrapCallData", async () => {
    let subjectWrappedTokenUnits: BigNumber;

    beforeEach(async () => {
      subjectWrappedTokenUnits = ether(2);
    });

    async function subject(): Promise<any> {
      return rgtMigrationWrapAdapter.getUnwrapCallData(owner.address, owner.address, subjectWrappedTokenUnits);
    }

    it("should revert", async () => {
      await expect(subject()).to.be.revertedWith("RGT migration cannot be reversed");
    });
  });

});
