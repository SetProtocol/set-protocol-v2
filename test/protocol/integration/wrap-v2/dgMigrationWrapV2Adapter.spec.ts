import "module-alias/register";
import { BigNumber } from "ethers";
import { Address } from "@utils/types";
import { Account } from "@utils/test/types";
import { DgMigrationWrapV2Adapter, StandardTokenMock } from "@utils/contracts";
import { Dg } from "@utils/contracts/dg";
import { ZERO } from "@utils/constants";
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

describe("DgMigrationWrapV2Adapter", () => {
  let owner: Account;
  let deployer: DeployHelper;
  let dg: Dg;
  let adapter: DgMigrationWrapV2Adapter;

  let dgV2Token: StandardTokenMock;
  let dgV1Token: StandardTokenMock;

  let mockOtherUnderlyingToken: Account;
  let mockOtherWrappedToken: Account;

  before(async () => {
    [
      owner,
      mockOtherUnderlyingToken,
      mockOtherWrappedToken
    ] = await getAccounts();

    deployer = new DeployHelper(owner.wallet);
    dg = await deployer.external.deployDg(owner.address);
    dgV1Token = await deployer.mocks.deployTokenMock(owner.address);
    dgV2Token = await deployer.mocks.deployTokenMock(owner.address);

    adapter = await deployer.adapters.deployDgMigrationWrapV2Adapter(
      dgV1Token.address,
      dgV2Token.address
    );
  });

  addSnapshotBeforeRestoreAfterEach();

  describe("#constructor", () => {
    let subjectV1Address: string;
    let subjectV2Address: string;
    beforeEach(async () => {
      subjectV1Address = dgV1Token.address;
      subjectV2Address = dgV2Token.address;
    });
    async function subject(): Promise<DgMigrationWrapV2Adapter> {
      return deployer.adapters.deployDgMigrationWrapV2Adapter(
        subjectV1Address,
        subjectV2Address
      );
    }
    it("should have the correct legacy token address", async () => {
      const deployedAdapter = await subject();

      expect(await deployedAdapter.dgTokenV1()).to.eq(subjectV1Address);
    });
    it("should have the correct new token address", async () => {
      const deployedAdapter = await subject();
      expect(await deployedAdapter.dgTokenV2()).to.eq(subjectV2Address);
    });
  });

  describe("#getWrapCallData", () => {
    let subjectUnderlyingToken: Address;
    let subjectWrappedToken: Address;
    let subjectNotionalUnderlying: BigNumber;

    beforeEach(async () => {
      subjectUnderlyingToken = dgV1Token.address;
      subjectWrappedToken = dgV2Token.address;
      subjectNotionalUnderlying = ether(2);
    });

    async function subject(): Promise<[string, BigNumber, string]> {
      return adapter.getWrapCallData(subjectUnderlyingToken, subjectWrappedToken, subjectNotionalUnderlying);
    }

    it("should return correct calldata", async () => {
      const [targetAddress, ethValue, callData] = await subject();

      const expectedCallData = dg.interface.encodeFunctionData("goLight", [subjectNotionalUnderlying]);
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
      subjectUnderlyingToken = dgV1Token.address;
      subjectWrappedToken = dgV2Token.address;
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
      return adapter.getSpenderAddress(dgV1Token.address, dgV2Token.address);
    }
    it("should return the correct spender address", async () => {
      const spender = await subject();
      expect(spender).to.eq(dgV2Token.address);
    });
  });
});
