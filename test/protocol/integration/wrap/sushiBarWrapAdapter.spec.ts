import "module-alias/register";
import { BigNumber } from "@ethersproject/bignumber";

import { Address } from "@utils/types";
import { Account } from "@utils/test/types";
import { ZERO } from "@utils/constants";
import DeployHelper from "@utils/deploys";
import {
  cacheBeforeEach,
  getAccounts,
  getWaffleExpect
} from "@utils/test";
import {
  ether,
  bigNumberToData
} from "@utils/common";
import { SushiBarWrapAdapter } from "@utils/contracts";

const expect = getWaffleExpect();

describe("SushiBarWrapAdapter", () => {
  let owner: Account;
  let deployer: DeployHelper;
  let sushiWrapAdapter: SushiBarWrapAdapter;
  let underlyingToken: Account;
  let wrappedToken: Account;
  let ethWrappedToken: Account;
  let otherUnderlyingToken: Account;

  cacheBeforeEach(async () => {
    [
      owner,
      underlyingToken,
      wrappedToken,
      ethWrappedToken,
      otherUnderlyingToken,
    ] = await getAccounts();

    deployer = new DeployHelper(owner.wallet);
    sushiWrapAdapter = await deployer.adapters.deploySushiBarWrapAdapter(
      underlyingToken.address,
      wrappedToken.address
    );
  });

  describe("#constructor", async () => {

    async function subject(): Promise<any> {
      return deployer.adapters.deploySushiBarWrapAdapter(
        underlyingToken.address,
        wrappedToken.address
      );
    }

    it("should have the correct sushi and sushiBar addresses", async () => {
      const deployedSushiBarWrapAdapter = await subject();

      const actualSushi = await deployedSushiBarWrapAdapter.sushiToken();
      const actualSushiBar = await deployedSushiBarWrapAdapter.xSushiToken();
      expect(actualSushi).to.eq(underlyingToken.address);
      expect(actualSushiBar).to.eq(wrappedToken.address);
    });
  });

  describe("#getSpenderAddress", async () => {
    async function subject(): Promise<any> {
      return sushiWrapAdapter.getSpenderAddress(underlyingToken.address, wrappedToken.address);
    }

    it("should return the correct spender address", async () => {
      const spender = await subject();

      expect(spender).to.eq(wrappedToken.address);
    });
  });

  describe("#getWrapCallData", async () => {
    let subjectUnderlyingToken: Address;
    let subjectWrappedToken: Address;
    let subjectUnderlyingUnits: BigNumber;
    const depositSignature = "0xa59f3e0c"; // enter(uint256)
    const generateCallData = (token: Address, units: BigNumber) =>
      depositSignature +
      bigNumberToData(units);

    beforeEach(async () => {
      subjectUnderlyingToken = underlyingToken.address;
      subjectWrappedToken = wrappedToken.address;
      subjectUnderlyingUnits = ether(2);
    });

    async function subject(): Promise<any> {
      return sushiWrapAdapter.getWrapCallData(
        subjectUnderlyingToken,
        subjectWrappedToken,
        subjectUnderlyingUnits
      );
    }

    it("should return correct data for valid pair", async () => {
      const [targetAddress, ethValue, callData] = await subject();

      const expectedCallData = generateCallData(subjectUnderlyingToken, subjectUnderlyingUnits);

      expect(targetAddress).to.eq(wrappedToken.address);
      expect(ethValue).to.eq(ZERO);
      expect(callData).to.eq(expectedCallData);
    });



    describe("when invalid underlying token", () => {
      beforeEach(async () => {
        subjectUnderlyingToken = otherUnderlyingToken.address;
        subjectWrappedToken = wrappedToken.address;
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Underlying token must be SUSHI");
      });
    });

    describe("when invalid wrapped token", () => {
      beforeEach(async () => {
        subjectUnderlyingToken = underlyingToken.address;
        subjectWrappedToken = ethWrappedToken.address;
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Wrapped token must be xSUSHI");
      });
    });
  });

  describe("#getUnwrapCallData", async () => {
    let subjectUnderlyingToken: Address;
    let subjectWrappedToken: Address;
    let subjectWrappedTokenUnits: BigNumber;
    const redeemSignature = "0x67dfd4c9"; // leave(uint256)
    const generateCallData = (units: BigNumber) => redeemSignature + bigNumberToData(units);

    beforeEach(async () => {
      subjectUnderlyingToken = underlyingToken.address;
      subjectWrappedToken = wrappedToken.address;
      subjectWrappedTokenUnits = ether(2);
    });

    async function subject(): Promise<any> {
      return sushiWrapAdapter.getUnwrapCallData(
        subjectUnderlyingToken,
        subjectWrappedToken,
        subjectWrappedTokenUnits
      );
    }

    it("should return correct data for valid pair", async () => {
      const [targetAddress, ethValue, callData] = await subject();

      const expectedCallData = generateCallData(subjectWrappedTokenUnits);

      expect(targetAddress).to.eq(subjectWrappedToken);
      expect(ethValue).to.eq(ZERO);
      expect(callData).to.eq(expectedCallData);
    });

    describe("when invalid underlying token", () => {
      beforeEach(async () => {
        subjectUnderlyingToken = otherUnderlyingToken.address;
        subjectWrappedToken = wrappedToken.address;
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Underlying token must be SUSHI");
      });
    });

    describe("when invalid wrapped token", () => {
      beforeEach(async () => {
        subjectUnderlyingToken = underlyingToken.address;
        subjectWrappedToken = ethWrappedToken.address;
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Wrapped token must be xSUSHI");
      });
    });
  });
});
