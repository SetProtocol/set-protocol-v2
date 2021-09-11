import "module-alias/register";
import { BigNumber } from "ethers";

import { Address } from "@utils/types";
import { Account } from "@utils/test/types";
import { CEther, CERc20 } from "@utils/contracts/compound";
import { ETH_ADDRESS, ZERO, ZERO_BYTES } from "@utils/constants";
import { CompoundFixture, SystemFixture } from "@utils/fixtures";
import { CompoundWrapV2Adapter } from "@utils/contracts";
import DeployHelper from "@utils/deploys";
import { ether } from "@utils/index";
import {
  addSnapshotBeforeRestoreAfterEach,
  getAccounts,
  getSystemFixture,
  getRandomAddress,
  getCompoundFixture,
  getWaffleExpect,
} from "@utils/test/index";

const expect = getWaffleExpect();

describe("CompoundWrapV2Adapter", () => {
  let owner: Account;
  let deployer: DeployHelper;
  let setup: SystemFixture;
  let compoundSetup: CompoundFixture;
  let compoundWrapAdapter: CompoundWrapV2Adapter;
  let cEther: CEther;
  let cDai: CERc20;

  before(async () => {
    [
      owner,
    ] = await getAccounts();

    deployer = new DeployHelper(owner.wallet);
    setup = getSystemFixture(owner.address);
    await setup.initialize();

    compoundSetup = getCompoundFixture(owner.address);
    await compoundSetup.initialize();

    cEther = await compoundSetup.createAndEnableCEther(
      ether(200000000),
      compoundSetup.comptroller.address,
      compoundSetup.interestRateModel.address,
      "Compound ether",
      "cETH",
      8,
      ether(0.75), // 75% collateral factor
      ether(1000)
    );

    cDai = await compoundSetup.createAndEnableCToken(
      setup.dai.address,
      ether(200000000),
      compoundSetup.comptroller.address,
      compoundSetup.interestRateModel.address,
      "Compound Dai",
      "cDAI",
      8,
      ether(0.75), // 75% collateral factor
      ether(1)
    );

    const compoundLibrary = await deployer.libraries.deployCompound();
    compoundWrapAdapter = await deployer.adapters.deployCompoundWrapV2Adapter(
      "contracts/protocol/integration/lib/Compound.sol:Compound",
      compoundLibrary.address
    );
  });

  addSnapshotBeforeRestoreAfterEach();

  describe("#getSpenderAddress", async () => {
    async function subject(): Promise<any> {
      return compoundWrapAdapter.getSpenderAddress(setup.dai.address, cDai.address);
    }

    it("should return the correct spender address", async () => {
      const spender = await subject();
      expect(spender).to.eq(cDai.address);
    });
  });

  describe("#getWrapCallData", async () => {
    let subjectCToken: Address;
    let subjectUnderlyingToken: Address;
    let subjectQuantity: BigNumber;
    let subjectTo: Address;
    let subjectWrapData: string;

    beforeEach(async () => {
      subjectQuantity = ether(1);
      subjectUnderlyingToken = setup.dai.address;
      subjectCToken = cDai.address;
      subjectTo = await getRandomAddress();
      subjectWrapData = ZERO_BYTES;
    });

    async function subject(): Promise<any> {
      return compoundWrapAdapter.getWrapCallData(subjectUnderlyingToken, subjectCToken, subjectQuantity, subjectTo, subjectWrapData);
    }

    it("should return correct data)", async () => {
      const [targetAddress, ethValue, callData] = await subject();

      const expectedCalldata = cDai.interface.encodeFunctionData("mint", [subjectQuantity]);

      expect(targetAddress).to.eq(subjectCToken);
      expect(ethValue).to.eq(ZERO);
      expect(callData).to.eq(expectedCalldata);
    });


    describe("when underlying asset is ETH", () => {
      let subjectCToken: Address;
      let subjectQuantity: BigNumber;

      beforeEach(async () => {
        subjectCToken = cEther.address;
        subjectUnderlyingToken = ETH_ADDRESS;
        subjectQuantity = ether(1);
      });

      async function subject(): Promise<any> {
        return compoundWrapAdapter.getWrapCallData(subjectUnderlyingToken, subjectCToken, subjectQuantity, subjectTo, subjectWrapData);
      }

      it("should return correct data", async () => {
        const [targetAddress, ethValue, callData] = await subject();

        const expectedCallData = cEther.interface.encodeFunctionData("mint");

        expect(targetAddress).to.eq(subjectCToken);
        expect(ethValue).to.eq(subjectQuantity);
        expect(callData).to.eq(expectedCallData);
      });
    });

  });

  describe("#getUnwrapCallData", async () => {
    let subjectCToken: Address;
    let subjectUnderlyingToken: Address;
    let subjectQuantity: BigNumber;
    let subjectTo: Address;
    let subjectUnwrapData: string;

    beforeEach(async () => {
      subjectCToken = cDai.address;
      subjectUnderlyingToken = setup.dai.address;
      subjectQuantity = ether(1);
      subjectTo = await getRandomAddress();
      subjectUnwrapData = ZERO_BYTES;
    });

    async function subject(): Promise<any> {
      return compoundWrapAdapter.getUnwrapCallData(subjectUnderlyingToken, subjectCToken, subjectQuantity, subjectTo, subjectUnwrapData);
    }

    it("should return correct data", async () => {
      const [targetAddress, ethValue, callData] = await subject();

      const expectedCallData = cDai.interface.encodeFunctionData("redeem", [subjectQuantity]);

      expect(targetAddress).to.eq(subjectCToken);
      expect(ethValue).to.eq(ZERO);
      expect(callData).to.eq(expectedCallData);
    });
  });

});
