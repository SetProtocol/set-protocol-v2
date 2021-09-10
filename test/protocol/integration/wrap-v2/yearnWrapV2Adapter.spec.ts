import "module-alias/register";
import { utils, BigNumber } from "ethers";

import { Address } from "@utils/types";
import { Account } from "@utils/test/types";
import { ZERO, ZERO_BYTES } from "@utils/constants";
import { YearnFixture, SystemFixture } from "@utils/fixtures";
import { YearnWrapV2Adapter } from "@utils/contracts";
import { Vault } from "@utils/contracts/yearn";
import DeployHelper from "@utils/deploys";
import { ether } from "@utils/index";
import {
  addSnapshotBeforeRestoreAfterEach,
  getAccounts,
  getSystemFixture,
  getRandomAddress,
  getWaffleExpect,
  getYearnFixture,
} from "@utils/test/index";
import { solidityKeccak256 } from "ethers/lib/utils";

const expect = getWaffleExpect();

describe("YearnWrapV2Adapter", () => {
  let owner: Account;
  let deployer: DeployHelper;
  let setup: SystemFixture;
  let yearnSetup: YearnFixture;
  let daiVault: Vault;
  let yearnWrapAdapter: YearnWrapV2Adapter;

  before(async () => {
    [
      owner,
    ] = await getAccounts();

    deployer = new DeployHelper(owner.wallet);
    setup = getSystemFixture(owner.address);
    await setup.initialize();

    yearnSetup = getYearnFixture(owner.address);
    await yearnSetup.initialize();

    daiVault =  await yearnSetup.createAndEnableVaultWithStrategyMock(
      setup.dai.address, owner.address, owner.address, owner.address, "daiMockStrategy", "yvDAI", ether(100)
    );

    yearnWrapAdapter = await deployer.adapters.deployYearnWrapV2Adapter();
  });

  addSnapshotBeforeRestoreAfterEach();

  describe("#getSpenderAddress", async () => {
    async function subject(): Promise<any> {
      return yearnWrapAdapter.getSpenderAddress(setup.dai.address, daiVault.address);
    }

    it("should return the correct spender address", async () => {
      const spender = await subject();
      expect(spender).to.eq(daiVault.address);
    });
  });

  describe("#getWrapCallData", async () => {
    let subjectYToken: Address;
    let subjectUnderlyingToken: Address;
    let subjectQuantity: BigNumber;
    let subjectTo: Address;
    let subjectWrapData: string;

    beforeEach(async () => {
      subjectQuantity = ether(1);
      subjectUnderlyingToken = setup.dai.address;
      subjectYToken = daiVault.address;
      subjectTo = await getRandomAddress();
      subjectWrapData = ZERO_BYTES;
    });

    async function subject(): Promise<any> {
      return yearnWrapAdapter.getWrapCallData(subjectUnderlyingToken, subjectYToken, subjectQuantity, subjectTo, subjectWrapData);
    }

    it("should return correct data)", async () => {
      const [targetAddress, ethValue, callData] = await subject();

      const selector = solidityKeccak256(["string"], ["deposit(uint256)"]).slice(0, 10);
      const data = utils.defaultAbiCoder.encode(["uint256"], [subjectQuantity]).slice(2);
      const expectedCalldata = selector + data;

      expect(targetAddress).to.eq(subjectYToken);
      expect(ethValue).to.eq(ZERO);
      expect(callData).to.eq(expectedCalldata);
    });
  });

  describe("#getUnwrapCallData", async () => {
    let subjectYToken: Address;
    let subjectUnderlyingToken: Address;
    let subjectQuantity: BigNumber;
    let subjectTo: Address;
    let subjectUnwrapData: string;

    beforeEach(async () => {
      subjectYToken = daiVault.address;
      subjectUnderlyingToken = setup.dai.address;
      subjectQuantity = ether(1);
      subjectTo = await getRandomAddress();
      subjectUnwrapData = ZERO_BYTES;
    });

    async function subject(): Promise<any> {
      return yearnWrapAdapter.getUnwrapCallData(subjectUnderlyingToken, subjectYToken, subjectQuantity, subjectTo, subjectUnwrapData);
    }

    it("should return correct data", async () => {
      const [targetAddress, ethValue, callData] = await subject();

      const selector = solidityKeccak256(["string"], ["withdraw(uint256)"]).slice(0, 10);
      const data = utils.defaultAbiCoder.encode(["uint256"], [subjectQuantity]).slice(2);
      const expectedCalldata = selector + data;

      expect(targetAddress).to.eq(subjectYToken);
      expect(ethValue).to.eq(ZERO);
      expect(callData).to.eq(expectedCalldata);
    });
  });
});
