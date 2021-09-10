import "module-alias/register";
import { BigNumber } from "ethers";

import { Address } from "@utils/types";
import { Account } from "@utils/test/types";
import { ZERO, ZERO_BYTES } from "@utils/constants";
import { AaveV2WrapV2Adapter, StandardTokenMock } from "@utils/contracts";
import DeployHelper from "@utils/deploys";
import { ether } from "@utils/index";
import {
  addSnapshotBeforeRestoreAfterEach,
  getAaveV2Fixture,
  getAccounts,
  getRandomAddress,
  getSystemFixture,
  getWaffleExpect,
} from "@utils/test/index";
import { AaveV2AToken } from "@utils/contracts/aaveV2";
import { AaveV2Fixture, SystemFixture } from "@utils/fixtures";

const expect = getWaffleExpect();

describe("AaveV2WrapAdapter", () => {

  let owner: Account;
  let deployer: DeployHelper;

  let setV2Setup: SystemFixture;
  let aaveV2Setup: AaveV2Fixture;

  let aaveWrapAdapter: AaveV2WrapV2Adapter;

  let underlyingToken: StandardTokenMock;
  let wrappedToken: AaveV2AToken;

  before(async () => {
    [ owner ] = await getAccounts();

    deployer = new DeployHelper(owner.wallet);

    setV2Setup = getSystemFixture(owner.address);
    aaveV2Setup = getAaveV2Fixture(owner.address);

    await setV2Setup.initialize();
    await aaveV2Setup.initialize(setV2Setup.weth.address, setV2Setup.dai.address);

    underlyingToken = setV2Setup.dai;
    wrappedToken = aaveV2Setup.daiReserveTokens.aToken;

    aaveWrapAdapter = await deployer.adapters.deployAaveV2WrapV2Adapter(aaveV2Setup.lendingPool.address);
  });

  addSnapshotBeforeRestoreAfterEach();

  describe("#constructor", async () => {
    let subjectLendingPool: Address;

    beforeEach(async () => {
      subjectLendingPool = aaveV2Setup.lendingPool.address;
    });

    async function subject(): Promise<AaveV2WrapV2Adapter> {
      return deployer.adapters.deployAaveV2WrapV2Adapter(subjectLendingPool);
    }

    it("should have the correct LendingPool addresses", async () => {
      const deployedAaveV2WrapAdapter = await subject();

      expect(await deployedAaveV2WrapAdapter.lendingPool()).to.eq(subjectLendingPool);
    });
  });

  describe("#getSpenderAddress", async () => {
    async function subject(): Promise<any> {
      return aaveWrapAdapter.getSpenderAddress(underlyingToken.address, wrappedToken.address);
    }

    it("should return the correct spender address", async () => {
      const spender = await subject();

      expect(spender).to.eq(aaveV2Setup.lendingPool.address);
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
      return aaveWrapAdapter.getWrapCallData(subjectUnderlyingToken, subjectWrappedToken, subjectUnderlyingUnits, subjectTo, subjectWrapData);
    }

    it("should return correct data for valid pair", async () => {
      const [targetAddress, ethValue, callData] = await subject();

      const expectedCallData = aaveV2Setup.lendingPool.interface.encodeFunctionData(
        "deposit",
        [subjectUnderlyingToken, subjectUnderlyingUnits, subjectTo, 0]
      );

      expect(targetAddress).to.eq(aaveV2Setup.lendingPool.address);
      expect(ethValue).to.eq(ZERO);
      expect(callData).to.eq(expectedCallData);
    });

    describe("when invalid wrapped token / underlying token pair", () => {
      beforeEach(async () => {
        subjectUnderlyingToken = underlyingToken.address;
        subjectWrappedToken = aaveV2Setup.wethReserveTokens.aToken.address;
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
      return aaveWrapAdapter.getUnwrapCallData(subjectUnderlyingToken, subjectWrappedToken, subjectWrappedTokenUnits, subjectTo, subjectUnwrapData);
    }

    it("should return correct data for valid pair", async () => {
      const [targetAddress, ethValue, callData] = await subject();

      const expectedCallData = aaveV2Setup.lendingPool.interface.encodeFunctionData(
        "withdraw",
        [subjectUnderlyingToken, subjectWrappedTokenUnits, subjectTo]
      );

      expect(targetAddress).to.eq(aaveV2Setup.lendingPool.address);
      expect(ethValue).to.eq(ZERO);
      expect(callData).to.eq(expectedCallData);
    });

    describe("when invalid wrapped token / underlying token pair", () => {
      beforeEach(async () => {
        subjectUnderlyingToken = underlyingToken.address;
        subjectWrappedToken = aaveV2Setup.wethReserveTokens.aToken.address;
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Must be a valid token pair");
      });
    });
  });
});
