import "module-alias/register";

import { BigNumber } from "ethers";

import { Address } from "@utils/types";
import { Account } from "@utils/test/types";
import { ADDRESS_ZERO } from "@utils/constants";
import { DebtModuleMock, ModuleIssuanceHookMock, SetToken, PerpV2IssuanceModule } from "@utils/contracts";
import DeployHelper from "@utils/deploys";
import {
  ether,
} from "@utils/index";
import {
  getAccounts,
  getSystemFixture,
  getWaffleExpect,
} from "@utils/test/index";
import { SystemFixture } from "@utils/fixtures";

const expect = getWaffleExpect();

describe("PerpV2IssuanceModule", () => {
  let owner: Account;
  let manager: Account;
  let feeRecipient: Account;
  let deployer: DeployHelper;
  let setup: SystemFixture;

  let debtModule: DebtModuleMock;
  let externalPositionModule: ModuleIssuanceHookMock;
  let perpIssuance: PerpV2IssuanceModule;
  let setToken: SetToken;

  let preIssueHook: Address;
  let maxFee: BigNumber;
  let issueFee: BigNumber;
  let redeemFee: BigNumber;

  before(async () => {
    [
      owner,
      manager,
      feeRecipient,
    ] = await getAccounts();

    deployer = new DeployHelper(owner.wallet);
    setup = getSystemFixture(owner.address);

    await setup.initialize();

    debtModule = await deployer.mocks.deployDebtModuleMock(setup.controller.address);
    perpIssuance = await deployer.modules.deployPerpV2IssuanceModule(setup.controller.address, debtModule.address);
    externalPositionModule = await deployer.mocks.deployModuleIssuanceHookMock();

    await setup.controller.addModule(perpIssuance.address);
    await setup.controller.addModule(debtModule.address);
    await setup.controller.addModule(externalPositionModule.address);

    setToken = await setup.createSetToken(
      [setup.weth.address],
      [ether(1)],
      [setup.issuanceModule.address, perpIssuance.address, debtModule.address, externalPositionModule.address],
      manager.address,
      "DebtToken",
      "DBT"
    );

    await externalPositionModule.initialize(setToken.address);

    preIssueHook = ADDRESS_ZERO;
    maxFee = ether(0.02);
    issueFee = ether(0.005);
    redeemFee = ether(0.005);
  });

  describe("#constructor", async () => {
    let subjectController: Address;
    let subjectPerpModule: Address;

    beforeEach(async () => {
      subjectController = setup.controller.address;
      subjectPerpModule = debtModule.address;
    });

    async function subject(): Promise<PerpV2IssuanceModule> {
      return await deployer.modules.deployPerpV2IssuanceModule(
        subjectController,
        subjectPerpModule
      );
    }

    it("should set the correct controller", async () => {
      await subject();

      const actualController = await perpIssuance.controller();

      expect(subjectController).to.eq(actualController);
    });

    it("should set the correct perp module (debt module in this case)", async () => {
      await subject();

      const actualPerpModule = await perpIssuance.perpModule();

      expect(subjectPerpModule).to.eq(actualPerpModule);
    });
  });

  describe("#getMaximumSetTokenIssueAmount", async () => {
    let subjectSetToken: Address;
    let issuanceLimit: BigNumber;

    beforeEach(async () => {
      await perpIssuance.connect(manager.wallet).initialize(
        setToken.address,
        maxFee,
        issueFee,
        redeemFee,
        feeRecipient.address,
        preIssueHook
      );

      issuanceLimit = ether(100);
      subjectSetToken = setToken.address;

      await debtModule.setIssuanceMaximum(subjectSetToken, issuanceLimit);
    });

    async function subject(): Promise<BigNumber> {
      return await perpIssuance.getMaximumSetTokenIssueAmount(subjectSetToken);
    }

    it("should return the issuance limit calculated on the PerpModule (debtModule here)", async () => {
      const actualIssuanceLimit = await subject();

      expect(issuanceLimit).to.eq(actualIssuanceLimit);
    });
  });
});