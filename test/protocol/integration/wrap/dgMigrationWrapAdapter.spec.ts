import "module-alias/register";
import { BigNumber } from "ethers";
import { Address } from "@utils/types";
import { Account } from "@utils/test/types";
import { DgMigrationWrapAdapter } from "@utils/contracts";
import { DGLight, DgToken } from "@utils/contracts/dg";
import { ZERO } from "@utils/constants";
import DeployHelper from "@utils/deploys";
import {
  ether,
} from "@utils/index";
import {
  addSnapshotBeforeRestoreAfterEach,
  getAccounts,
  getWaffleExpect,
} from "@utils/test/index";

const expect = getWaffleExpect();

describe("DgMigrationWrapAdapter", () => {
  let owner: Account;
  let deployer: DeployHelper;

  let dgToken: DgToken;
  let dgLight: DGLight;
  let adapter: DgMigrationWrapAdapter;

  let mockOtherUnderlyingToken: Account;
  let mockOtherWrappedToken: Account;

  before(async () => {
    [
      owner,
      mockOtherUnderlyingToken,
      mockOtherWrappedToken
    ] = await getAccounts();

    deployer = new DeployHelper(owner.wallet);
    dgToken = await deployer.mocks.deployTokenMock(owner.address);
    dgLight = await deployer.external.deployDGLight(dgToken.address);

    adapter = await deployer.adapters.deployDgMigrationWrapAdapter(
      dgToken.address,
      dgLight.address
    );
  });

  addSnapshotBeforeRestoreAfterEach();

  describe("#constructor", () => {
    let subjectUnderlyingAddress: string;
    let subjectWrappedAddress: string;

    beforeEach(async () => {
      subjectUnderlyingAddress = dgToken.address;
      subjectWrappedAddress = dgLight.address;
    });

    async function subject(): Promise<DgMigrationWrapAdapter> {
      return deployer.adapters.deployDgMigrationWrapAdapter(
        subjectUnderlyingAddress,
        subjectWrappedAddress
      );
    }

    it("should have the correct legacy token address", async () => {
      const deployedAdapter = await subject();

      expect(await deployedAdapter.dgTokenV1()).to.eq(subjectUnderlyingAddress);
    });

    it("should have the correct new token address", async () => {
      const deployedAdapter = await subject();
      expect(await deployedAdapter.dgTokenV2()).to.eq(subjectWrappedAddress);
    });
  });

  describe("#getWrapCallData", () => {
    let subjectUnderlyingToken: Address;
    let subjectWrappedToken: Address;
    let subjectNotionalUnderlying: BigNumber;

    beforeEach(async () => {
      subjectUnderlyingToken = dgToken.address;
      subjectWrappedToken = dgLight.address;
      subjectNotionalUnderlying = ether(2);
    });

    async function subject(): Promise<[string, BigNumber, string]> {
      return adapter.getWrapCallData(subjectUnderlyingToken, subjectWrappedToken, subjectNotionalUnderlying);
    }

    it("should return correct calldata", async () => {
      const [targetAddress, ethValue, callData] = await subject();

      const expectedCallData = dgLight.interface.encodeFunctionData("goLight", [subjectNotionalUnderlying]);
      expect(targetAddress).to.eq(subjectWrappedToken);
      expect(ethValue).to.eq(ZERO);
      expect(callData).to.eq(expectedCallData);
    });

    describe("should revert when underlying is not old dg token", async () => {
      beforeEach(async () => {
        subjectUnderlyingToken = mockOtherUnderlyingToken.address;
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Must be DG V1 token");
      });
    });

    describe("should revert when wrapped asset is not new dg token", async () => {
      beforeEach(async () => {
        subjectWrappedToken = mockOtherWrappedToken.address;
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Must be DG V2 token");
      });
    });
  });

  describe("#getUnwrapCallData", () => {
    let subjectUnderlyingToken: string;
    let subjectWrappedToken: string;
    let subjectAmount: BigNumber;

    beforeEach(async () => {
      subjectUnderlyingToken = dgToken.address;
      subjectWrappedToken = dgLight.address;
      subjectAmount = ether(2);
    });

    async function subject(): Promise<[string, BigNumber, string]> {
      return adapter.getUnwrapCallData(subjectUnderlyingToken, subjectWrappedToken, subjectAmount);
    }

    it("should revert", async () => {
      await expect(subject()).to.be.revertedWith("DG migration cannot be reversed");
    });
  });

  describe("#getSpenderAddress", () => {
    async function subject(): Promise<string> {
      return adapter.getSpenderAddress(dgToken.address, dgLight.address);
    }
    it("should return the correct spender address", async () => {
      const spender = await subject();
      expect(spender).to.eq(dgLight.address);
    });
  });
});
