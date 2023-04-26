import "module-alias/register";

import { Address } from "@utils/types";
import { Account } from "@utils/test/types";
import { ADDRESS_ZERO } from "@utils/constants";
import { BasicIssuanceModule, SetToken, TokenEnabler } from "@utils/contracts";
import DeployHelper from "@utils/deploys";
import {
  bitcoin,
  ether,
} from "@utils/index";
import {
  addSnapshotBeforeRestoreAfterEach,
  getAccounts,
  getWaffleExpect,
  getSystemFixture,
} from "@utils/test/index";
import { SystemFixture } from "@utils/fixtures";

const expect = getWaffleExpect();

describe("TokenEnabler", () => {
  let owner: Account;
  let recipient: Account;
  let deployer: DeployHelper;
  let setup: SystemFixture;

  let issuanceModule: BasicIssuanceModule;
  let setTokenOne: SetToken;
  let setTokenTwo: SetToken;
  let tokenEnabler: TokenEnabler;

  let tokensToEnable: Address[];

  before(async () => {
    [
      owner,
      recipient,
    ] = await getAccounts();

    deployer = new DeployHelper(owner.wallet);
    setup = getSystemFixture(owner.address);
    await setup.initialize();

    issuanceModule = await deployer.modules.deployBasicIssuanceModule(setup.controller.address);
    await setup.controller.addModule(issuanceModule.address);

    setTokenOne = await setup.createSetToken(
      [setup.weth.address],
      [ether(1)],
      [issuanceModule.address]
    );

    setTokenTwo = await setup.createSetToken(
      [setup.weth.address],
      [bitcoin(1)],
      [issuanceModule.address]
    );

    tokensToEnable = [setTokenOne.address, setTokenTwo.address];
    tokenEnabler = await deployer.product.deployTokenEnabler(
      setup.controller.address,
      tokensToEnable
    );

    await issuanceModule.connect(owner.wallet).initialize(setTokenOne.address, ADDRESS_ZERO);
    await issuanceModule.connect(owner.wallet).initialize(setTokenTwo.address, ADDRESS_ZERO);
  });

  addSnapshotBeforeRestoreAfterEach();

  describe("#constructor", async () => {
    it("should set the correct state variables", async () => {
      const controller = await tokenEnabler.controller();
      const actualTokensToEnable = await tokenEnabler.getTokensToEnable();

      expect(controller).to.eq(setup.controller.address);
      expect(actualTokensToEnable).to.deep.eq(tokensToEnable);
    });
  });

  describe("#enableTokens", async () => {
    let subjectCaller: Account;

    beforeEach(async () => {
      await setup.controller.removeSet(setTokenOne.address);
      await setup.controller.removeSet(setTokenTwo.address);

      await setup.controller.addFactory(tokenEnabler.address);

      subjectCaller = owner;
    });

    async function subject(): Promise<any> {
      return tokenEnabler.connect(subjectCaller.wallet).enableTokens();
    }

    it("should set the tokens to enabled on the Controller", async () => {
      await subject();

      const isSetOne = await setup.controller.isSet(setTokenOne.address);
      const isSetTwo = await setup.controller.isSet(setTokenTwo.address);

      expect(isSetOne).to.be.true;
      expect(isSetTwo).to.be.true;
    });

    describe("when the caller is not the operator", async () => {
      beforeEach(async () => {
        subjectCaller = recipient;
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Ownable: caller is not the owner");
      });
    });
  });
});
