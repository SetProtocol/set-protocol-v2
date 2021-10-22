import "module-alias/register";
import { BigNumber } from "ethers";

import { Address } from "@utils/types";
import { Account } from "@utils/test/types";
import { ZERO } from "@utils/constants";
import { AGIMigrationWrapAdapter } from "@utils/contracts";
import { SingularityNetToken } from "@utils/contracts/";
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

describe("AGIMigrationWrapAdapter", () => {
  let owner: Account;
  let deployer: DeployHelper;
  let agiToken: SingularityNetToken;
  let agiMigrationWrapAdapter: AGIMigrationWrapAdapter;

  let agiTokenV2: Account;
  let mockOtherUnderlyingToken: Account;
  let mockOtherWrappedToken: Account;

  before(async () => {
    [
      owner,
      agiTokenV2,
      mockOtherUnderlyingToken,
      mockOtherWrappedToken,
    ] = await getAccounts();

    deployer = new DeployHelper(owner.wallet);

    agiToken = await deployer.external.deploySingularityNetToken();

    agiMigrationWrapAdapter = await deployer.adapters.deployAGIMigrationWrapAdapter(
      agiToken.address,
      agiTokenV2.address
    );
  });

  addSnapshotBeforeRestoreAfterEach();

  describe("#constructor", async () => {
    let subjectAgiToken: Address;
    let subjectAgiTokenV2: Address;

    beforeEach(async () => {
      subjectAgiToken = agiToken.address;
      subjectAgiTokenV2 = agiTokenV2.address;
    });

    async function subject(): Promise<any> {
      return deployer.adapters.deployAGIMigrationWrapAdapter(
        subjectAgiToken,
        subjectAgiTokenV2
      );
    }

    it("should have the correct AGI token address", async () => {
      const agiMigrationWrapAdapter = await subject();

      const agiToken = await agiMigrationWrapAdapter.agiLegacyToken();
      const expectedAgiToken = subjectAgiToken;

      expect(agiToken).to.eq(expectedAgiToken);
    });

    it("should have the correct AGI token V2 (AGIX) address", async () => {
      const agiMigrationWrapAdapter = await subject();

      const agixToken = await agiMigrationWrapAdapter.agixToken();
      const expectedAgixToken = subjectAgiTokenV2;

      expect(agixToken).to.eq(expectedAgixToken);
    });
  });

  describe("#getSpenderAddress", async () => {
    async function subject(): Promise<any> {
      return agiMigrationWrapAdapter.getSpenderAddress(
        agiToken.address,
        agiTokenV2.address
      );
    }

    it("should return the correct spender address", async () => {
      const spender = await subject();

      expect(spender).to.eq(agiToken.address);
    });
  });

  describe("#getWrapCallData", async () => {
    let subjectUnderlyingToken: Address;
    let subjectWrappedToken: Address;
    let subjectUnderlyingUnits: BigNumber;

    beforeEach(async () => {
      subjectUnderlyingToken = agiToken.address;
      subjectWrappedToken = agiTokenV2.address;
      subjectUnderlyingUnits = ether(2);
    });

    async function subject(): Promise<any> {
      return agiMigrationWrapAdapter.getWrapCallData(subjectUnderlyingToken, subjectWrappedToken, subjectUnderlyingUnits);
    }

    it("should return correct data for valid pair", async () => {
      const [targetAddress, ethValue, callData] = await subject();

      const expectedCallData = agiToken.interface.encodeFunctionData("burn", [subjectUnderlyingUnits]);

      expect(targetAddress).to.eq(agiToken.address);
      expect(ethValue).to.eq(ZERO);
      expect(callData).to.eq(expectedCallData);
    });

    describe("when underlying asset is not AGI token", () => {
      beforeEach(async () => {
        subjectUnderlyingToken = mockOtherUnderlyingToken.address;
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Must be AGI token");
      });
    });

    describe("when wrapped asset is not AGI token V2 (AGIX)", () => {
      beforeEach(async () => {
        subjectWrappedToken = mockOtherWrappedToken.address;
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Must be AGIX token");
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
      return agiMigrationWrapAdapter.getUnwrapCallData(subjectUnderlyingToken, subjectWrappedToken, subjectWrappedTokenUnits);
    }

    it("should revert", async () => {
      await expect(subject()).to.be.revertedWith("AGI burn cannot be reversed");
    });
  });
});
