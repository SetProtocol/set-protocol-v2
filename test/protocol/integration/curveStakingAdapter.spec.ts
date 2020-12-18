import "module-alias/register";
import { BigNumber } from "ethers/utils";

import { Address, Account } from "@utils/types";
import { ZERO } from "@utils/constants";
import { CurveStakingAdapter, GaugeControllerMock } from "@utils/contracts";
import DeployHelper from "@utils/deploys";
import {
  addSnapshotBeforeRestoreAfterEach, bigNumberToData,
  ether,
  getAccounts, getRandomAddress,
  getWaffleExpect,
} from "@utils/index";

const expect = getWaffleExpect();

describe("CurveStakingAdapter", () => {
  let owner: Account;
  let deployer: DeployHelper;
  let curveStakingAdapter: CurveStakingAdapter;
  let gaugeControllerMock: GaugeControllerMock;

  before(async () => {
    [
      owner,
    ] = await getAccounts();

    deployer = new DeployHelper(owner.wallet);

    gaugeControllerMock = await deployer.mocks.deployGaugeControllerMock();
    curveStakingAdapter = await deployer.adapters.deployCurveStakingAdapter(gaugeControllerMock.address);
  });

  addSnapshotBeforeRestoreAfterEach();

  describe("#constructor", async () => {
    let subjectGaugeController: Address;

    beforeEach(async () => {
      subjectGaugeController = gaugeControllerMock.address;
    });

    async function subject(): Promise<any> {
      return deployer.adapters.deployCurveStakingAdapter(subjectGaugeController);
    }

    it("set the correct variables", async () => {
      const adapter = await subject();

      const adapterGaugeController = await adapter.gaugeController();
      expect(adapterGaugeController).to.eq(subjectGaugeController);
    });
  });

  describe("#getSpenderAddress", async () => {
    let subjectStakingContract: Address;

    beforeEach(async () => {
      subjectStakingContract = await getRandomAddress();
    });

    async function subject(): Promise<any> {
      return curveStakingAdapter.getSpenderAddress(subjectStakingContract);
    }

    it("should return the correct address", async () => {
      const spender = await subject();

      expect(spender).to.eq(subjectStakingContract);
    });
  });

  describe("#getStakeCallData", async () => {
    let subjectStakingContract: Address;
    let subjectAmount: BigNumber;
    const stakeSignature = "0xb6b55f25"; // deposit(uint256)
    const generateCallData = (amount: BigNumber) =>
      stakeSignature +
      bigNumberToData(amount);

    beforeEach(async () => {
      subjectStakingContract = await getRandomAddress();
      await gaugeControllerMock.addGaugeType(subjectStakingContract, 0);
      subjectAmount = ether(1);
    });

    async function subject(): Promise<any> {
      return curveStakingAdapter.getStakeCallData(subjectStakingContract, subjectAmount);
    }

    it("should return the correct target, value and calldata", async () => {
      const [targetAddress, ethValue, callData] = await subject();

      const expectedCallData = generateCallData(subjectAmount);

      expect(targetAddress).to.eq(subjectStakingContract);
      expect(ethValue).to.eq(ZERO);
      expect(expectedCallData).to.eq(callData);
    });

    describe("when an invalid staking contract is used", async () => {
      beforeEach(async () => {
        subjectStakingContract = await getRandomAddress();
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Invalid staking contract");
      });
    });
  });

  describe("#getUnstakeCallData", async () => {
    let subjectStakingContract: Address;
    let subjectAmount: BigNumber;
    const unstakeSignature = "0x2e1a7d4d"; // withdraw(uint256)
    const generateCallData = (amount: BigNumber) =>
      unstakeSignature +
      bigNumberToData(amount);

    beforeEach(async () => {
      subjectStakingContract = await getRandomAddress();
      await gaugeControllerMock.addGaugeType(subjectStakingContract, 0);
      subjectAmount = ether(1);
    });

    async function subject(): Promise<any> {
      return curveStakingAdapter.getUnstakeCallData(subjectStakingContract, subjectAmount);
    }

    it("should return the correct target, value and calldata", async () => {
      const [targetAddress, ethValue, callData] = await subject();

      const expectedCallData = generateCallData(subjectAmount);

      expect(targetAddress).to.eq(subjectStakingContract);
      expect(ethValue).to.eq(ZERO);
      expect(expectedCallData).to.eq(callData);
    });

    describe("when an invalid staking contract is used", async () => {
      beforeEach(async () => {
        subjectStakingContract = await getRandomAddress();
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Invalid staking contract");
      });
    });
  });
});
