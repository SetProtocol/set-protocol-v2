import "module-alias/register";
import { BigNumber } from "ethers/utils";

import { Address, Account } from "@utils/types";
import { ONE } from "@utils/constants";
import { DebtIssuanceModule, DebtModuleMock, SetToken } from "@utils/contracts";
import DeployHelper from "@utils/deploys";
import {
  addSnapshotBeforeRestoreAfterEach,
  ether,
  getAccounts,
  getSystemFixture,
  getWaffleExpect,
} from "@utils/index";
import { SystemFixture } from "@utils/fixtures";
import { ContractTransaction } from "ethers";

const expect = getWaffleExpect();

describe("DebtIssuanceModule", () => {
  let owner: Account;
  let feeRecipient: Account;
  let deployer: DeployHelper;
  let setup: SystemFixture;

  let debtModule: DebtModuleMock;
  let debtIssuance: DebtIssuanceModule;
  let setToken: SetToken;

  before(async () => {
    [
      owner,
      feeRecipient,
    ] = await getAccounts();

    deployer = new DeployHelper(owner.wallet);
    setup = getSystemFixture(owner.address);

    await setup.initialize();

    debtIssuance = await deployer.modules.deployDebtIssuanceModule(setup.controller.address);
    debtModule = await deployer.mocks.deployDebtModuleMock(setup.controller.address, debtIssuance.address);
    await setup.controller.addModule(debtIssuance.address);
    await setup.controller.addModule(debtModule.address);

    setToken = await setup.createSetToken(
      [setup.weth.address],
      [ONE],
      [setup.issuanceModule.address, debtIssuance.address, debtModule.address],
      owner.address,
      "DebtToken",
      "DBT"
    );
  });

  addSnapshotBeforeRestoreAfterEach();

  describe.only("#initialize", async () => {
    let subjectSetToken: Address;
    let subjectManagerIssueFee: BigNumber;
    let subjectManagerRedeemFee: BigNumber;
    let subjectFeeRecipient: Address;
    let subjectManagerIssuanceHook: Address;
    let subjectCaller: Account;

    beforeEach(async () => {
      subjectSetToken = setToken.address;
      subjectManagerIssueFee = ether(0.005);
      subjectManagerRedeemFee = ether(0.004);
      subjectFeeRecipient = feeRecipient.address;
      subjectManagerIssuanceHook = owner.address;
      subjectCaller = owner;
    });

    async function subject(): Promise<ContractTransaction> {
      return debtIssuance.connect(subjectCaller.wallet).initialize(
        subjectSetToken,
        subjectManagerIssueFee,
        subjectManagerRedeemFee,
        subjectFeeRecipient,
        subjectManagerIssuanceHook
      );
    }

    it("should set the correct state", async () => {
      await subject();

      const settings: any = await debtIssuance.issuanceSettings(subjectSetToken);

      expect(settings.managerIssueFee).to.eq(subjectManagerIssueFee);
      expect(settings.managerRedeemFee).to.eq(subjectManagerRedeemFee);
      expect(settings.feeRecipient).to.eq(subjectFeeRecipient);
      expect(settings.managerIssuanceHook).to.eq(subjectManagerIssuanceHook);
    });
  });

  describe("#issue", async () => {
    let subjectSetToken: Address;
    let subjectManagerIssueFee: BigNumber;
    let subjectManagerRedeemFee: BigNumber;
    let subjectFeeRecipient: Address;
    let subjectManagerIssuanceHook: Address;
    let subjectCaller: Account;

    beforeEach(async () => {
      subjectSetToken = setToken.address;
      subjectManagerIssueFee = ether(0.005);
      subjectManagerRedeemFee = ether(0.004);
      subjectFeeRecipient = feeRecipient.address;
      subjectManagerIssuanceHook = owner.address;
      subjectCaller = owner;
    });

    async function subject(): Promise<ContractTransaction> {
      return debtIssuance.connect(subjectCaller.wallet).issue(
        subjectSetToken,
        subjectManagerIssueFee,
        subjectManagerRedeemFee,
        subjectFeeRecipient,
        subjectManagerIssuanceHook
      );
    }

    it("should set the correct state", async () => {
      await subject();

      const settings: any = await debtIssuance.issuanceSettings(subjectSetToken);

      expect(settings.managerIssueFee).to.eq(subjectManagerIssueFee);
      expect(settings.managerRedeemFee).to.eq(subjectManagerRedeemFee);
      expect(settings.feeRecipient).to.eq(subjectFeeRecipient);
      expect(settings.managerIssuanceHook).to.eq(subjectManagerIssuanceHook);
    });
  });
});
