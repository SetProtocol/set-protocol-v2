import "module-alias/register";
import { BigNumber } from "@ethersproject/bignumber";

import { Address, Account } from "@utils/types";
import { ETH_ADDRESS, ZERO } from "@utils/constants";
import { AaveWrapAdapter, AaveLendingPoolMock, AaveLendingPoolCoreMock } from "@utils/contracts";
import DeployHelper from "@utils/deploys";
import {
  addSnapshotBeforeRestoreAfterEach,
  ether,
  getAccounts,
  getWaffleExpect,
  addressToData,
  bigNumberToData
} from "@utils/index";

const expect = getWaffleExpect();

describe("AaveWrapAdapter", () => {
  let owner: Account;
  let deployer: DeployHelper;
  let aaveLendingPool: AaveLendingPoolMock;
  let aaveLendingPoolCore: AaveLendingPoolCoreMock;
  let aaveWrapAdapter: AaveWrapAdapter;
  let underlyingToken: Account;
  let wrappedToken: Account;
  let ethWrappedToken: Account;
  let otherUnderlyingToken: Account;

  before(async () => {
    [
      owner,
      underlyingToken,
      wrappedToken,
      ethWrappedToken,
      otherUnderlyingToken,
    ] = await getAccounts();

    deployer = new DeployHelper(owner.wallet);

    aaveLendingPoolCore = await deployer.mocks.deployAaveLendingPoolCoreMock();
    aaveLendingPool = await deployer.mocks.deployAaveLendingPoolMock(aaveLendingPoolCore.address);
    await aaveLendingPoolCore.setReserveATokenAddress(underlyingToken.address, wrappedToken.address);

    aaveWrapAdapter = await deployer.adapters.deployAaveWrapAdapter(aaveLendingPool.address);
  });

  addSnapshotBeforeRestoreAfterEach();

  describe("#constructor", async () => {
    let subjectAaveLendingPool: Address;

    beforeEach(async () => {
      subjectAaveLendingPool = aaveLendingPool.address;
    });

    async function subject(): Promise<any> {
      return deployer.adapters.deployAaveWrapAdapter(subjectAaveLendingPool);
    }

    it("should have the correct lendingPool and lendingPoolCore addresses", async () => {
      const deployedAaveWrapAdapter = await subject();

      const actualAaveLendingPool = await deployedAaveWrapAdapter.aaveLendingPool();
      const actualAaveLendingPoolCore = await deployedAaveWrapAdapter.aaveLendingPoolCore();
      expect(actualAaveLendingPool).to.eq(aaveLendingPool.address);
      expect(actualAaveLendingPoolCore).to.eq(aaveLendingPoolCore.address);
    });

    describe("when not a valid aaveLendingPool address", () => {
      beforeEach(async () => {
        subjectAaveLendingPool = aaveLendingPoolCore.address;
      });

      it("should revert", async () => {
        await expect(subject()).to.be.reverted;
      });
    });
  });

  describe("#getSpenderAddress", async () => {
    async function subject(): Promise<any> {
      return aaveWrapAdapter.getSpenderAddress(underlyingToken.address, wrappedToken.address);
    }

    it("should return the correct spender address", async () => {
      const spender = await subject();

      expect(spender).to.eq(aaveLendingPoolCore.address);
    });
  });

  describe("#getWrapCallData", async () => {
    let subjectUnderlyingToken: Address;
    let subjectWrappedToken: Address;
    let subjectUnderlyingUnits: BigNumber;
    const depositSignature = "0xd2d0e066"; // deposit(address,uint256,uint16)
    const generateCallData = (token: Address, units: BigNumber) =>
      depositSignature +
      addressToData(token.toLowerCase()) +
      bigNumberToData(units) +
      bigNumberToData(ZERO); // referral code

    beforeEach(async () => {
      subjectUnderlyingToken = underlyingToken.address;
      subjectWrappedToken = wrappedToken.address;
      subjectUnderlyingUnits = ether(2);
    });

    async function subject(): Promise<any> {
      return aaveWrapAdapter.getWrapCallData(subjectUnderlyingToken, subjectWrappedToken, subjectUnderlyingUnits);
    }

    it("should return correct data for valid pair", async () => {
      const [targetAddress, ethValue, callData] = await subject();

      const expectedCallData = generateCallData(subjectUnderlyingToken, subjectUnderlyingUnits);

      expect(targetAddress).to.eq(aaveLendingPool.address);
      expect(ethValue).to.eq(ZERO);
      expect(callData).to.eq(expectedCallData);
    });

    describe("when underlying asset is ETH", () => {
      beforeEach(async () => {
        subjectUnderlyingToken = ETH_ADDRESS;
        subjectWrappedToken = ethWrappedToken.address;
        subjectUnderlyingUnits = ether(2);

        await aaveLendingPoolCore.setReserveATokenAddress(subjectUnderlyingToken, subjectWrappedToken);
      });

      it("should return correct data with eth value to send", async () => {
        const [targetAddress, ethValue, callData] = await subject();

        const expectedCallData = generateCallData(subjectUnderlyingToken, subjectUnderlyingUnits);

        expect(targetAddress).to.eq(aaveLendingPool.address);
        expect(ethValue).to.eq(ether(2));
        expect(callData).to.eq(expectedCallData);
      });
    });

    describe("when invalid underlying token", () => {
      beforeEach(async () => {
        subjectUnderlyingToken = otherUnderlyingToken.address;
        subjectWrappedToken = wrappedToken.address;
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Must be a valid token pair");
      });
    });

    describe("when invalid wrapped token", () => {
      beforeEach(async () => {
        subjectUnderlyingToken = underlyingToken.address;
        subjectWrappedToken = ethWrappedToken.address;
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
    const redeemSignature = "0xdb006a75"; // redeem(uint256)
    const generateCallData = (units: BigNumber) => redeemSignature + bigNumberToData(units);

    beforeEach(async () => {
      subjectUnderlyingToken = underlyingToken.address;
      subjectWrappedToken = wrappedToken.address;
      subjectWrappedTokenUnits = ether(2);
    });

    async function subject(): Promise<any> {
      return aaveWrapAdapter.getUnwrapCallData(subjectUnderlyingToken, subjectWrappedToken, subjectWrappedTokenUnits);
    }

    it("should return correct data for valid pair", async () => {
      const [targetAddress, ethValue, callData] = await subject();

      const expectedCallData = generateCallData(subjectWrappedTokenUnits);

      expect(targetAddress).to.eq(subjectWrappedToken);
      expect(ethValue).to.eq(ZERO);
      expect(callData).to.eq(expectedCallData);
    });

    describe("when underlying asset is ETH", () => {
      beforeEach(async () => {
        subjectUnderlyingToken = ETH_ADDRESS;
        subjectWrappedToken = ethWrappedToken.address;
        subjectWrappedTokenUnits = ether(2);

        await aaveLendingPoolCore.setReserveATokenAddress(subjectUnderlyingToken, subjectWrappedToken);
      });

      it("should return correct data with 0 eth value to send", async () => {
        const [targetAddress, ethValue, callData] = await subject();

        const expectedCallData = generateCallData(subjectWrappedTokenUnits);

        expect(targetAddress).to.eq(subjectWrappedToken);
        expect(ethValue).to.eq(ZERO);
        expect(callData).to.eq(expectedCallData);
      });
    });

    describe("when invalid underlying token", () => {
      beforeEach(async () => {
        subjectUnderlyingToken = otherUnderlyingToken.address;
        subjectWrappedToken = wrappedToken.address;
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Must be a valid token pair");
      });
    });

    describe("when invalid wrapped token", () => {
      beforeEach(async () => {
        subjectUnderlyingToken = underlyingToken.address;
        subjectWrappedToken = ethWrappedToken.address;
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Must be a valid token pair");
      });
    });
  });
});
