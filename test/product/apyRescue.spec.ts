import "module-alias/register";
import { BigNumber } from "ethers";

import { Address } from "@utils/types";
import { Account } from "@utils/test/types";
import { ADDRESS_ZERO, ZERO } from "@utils/constants";
import { BasicIssuanceModule, APYRescue, SetToken } from "@utils/contracts";
import DeployHelper from "@utils/deploys";
import {
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

describe("APYRescue", () => {
  let owner: Account;
  let recipient: Account;
  let deployer: DeployHelper;
  let setup: SystemFixture;

  let issuanceModule: BasicIssuanceModule;
  let apyToken: SetToken;
  let apyRescue: APYRescue;

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

    apyToken = await setup.createSetToken(
      [setup.weth.address],
      [ether(1)],
      [issuanceModule.address]
    );

    apyRescue = await deployer.product.deployAPYRescue(
      apyToken.address,
      setup.weth.address,
      issuanceModule.address
    );

    await issuanceModule.connect(owner.wallet).initialize(apyToken.address, ADDRESS_ZERO);
  });

  addSnapshotBeforeRestoreAfterEach();

  describe("#constructor", async () => {
    let subjectApyToken: Address;
    let subjectPositionToken: Address;
    let subjectBasicIssuanceModule: Address;

    beforeEach(async () => {
      subjectApyToken = apyToken.address;
      subjectPositionToken = setup.weth.address;
      subjectBasicIssuanceModule = issuanceModule.address;
    });

    it("should set the correct state variables", async () => {
      const apyToken = await apyRescue.apyToken();
      const positionToken = await apyRescue.recoveredToken();
      const basicIssuanceModule = await apyRescue.basicIssuanceModule();

      expect(apyToken).to.eq(subjectApyToken);
      expect(positionToken).to.eq(subjectPositionToken);
      expect(basicIssuanceModule).to.eq(subjectBasicIssuanceModule);
    });
  });

  describe("#deposit", async () => {
    let subjectAmount: BigNumber;
    let subjectCaller: Account;

    beforeEach(async () => {
      await setup.weth.connect(owner.wallet).approve(issuanceModule.address, ether(1.5));
      await issuanceModule.connect(owner.wallet).issue(apyToken.address, ether(1.5), owner.address);

      subjectAmount = ether(1);
      await apyToken.approve(apyRescue.address, subjectAmount);

      subjectCaller = owner;
    });

    async function subject(): Promise<any> {
      return apyRescue.connect(subjectCaller.wallet).deposit(subjectAmount);
    }

    it("should deposit the correct amount of tokens", async () => {
      const preBalance = await apyToken.balanceOf(apyRescue.address);

      await subject();

      const postBalance = await apyToken.balanceOf(apyRescue.address);

      expect(postBalance).to.eq(preBalance.add(subjectAmount));
    });

    it("should credit the correct amount of rescued tokens to the caller", async () => {
      const preBalance = await apyRescue.shares(owner.address);

      await subject();

      const postBalance = await apyRescue.shares(owner.address);

      expect(postBalance).to.eq(preBalance.add(subjectAmount));
    });

    describe("when the rescue has already been performed", async () => {
      beforeEach(async () => {
        await apyRescue.connect(subjectCaller.wallet).deposit(subjectAmount);
        await apyRescue.connect(owner.wallet).recoverAssets();
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("APYRescue: redemption already initiated");
      });
    });
  });

  describe("#recoverAssets", async () => {
    let subjectCaller: Account;

    beforeEach(async () => {
      await setup.weth.connect(owner.wallet).approve(issuanceModule.address, ether(1.5));
      await issuanceModule.connect(owner.wallet).issue(apyToken.address, ether(1.5), owner.address);
      await apyToken.connect(owner.wallet).transfer(recipient.address, ether(0.5));

      await apyToken.approve(apyRescue.address, ether(1));
      await apyRescue.connect(owner.wallet).deposit(ether(1));

      await apyToken.connect(recipient.wallet).approve(apyRescue.address, ether(.5));
      await apyRescue.connect(recipient.wallet).deposit(ether(.5));

      subjectCaller = owner;
    });

    async function subject(): Promise<any> {
      return apyRescue.connect(subjectCaller.wallet).recoverAssets();
    }

    it("should redeem all the SetTokens", async () => {
      await subject();

      const postBalance = await apyToken.balanceOf(apyRescue.address);

      expect(postBalance).to.eq(ZERO);
    });

    it("should transfer the correct amount of position tokens to the Rescue contract", async () => {
      const preBalance = await setup.weth.balanceOf(apyRescue.address);

      await subject();

      const postBalance = await setup.weth.balanceOf(apyRescue.address);
      const recoveredTokens = await apyRescue.recoveredTokens();

      expect(postBalance).to.eq(preBalance.add(ether(1.5)));
      expect(recoveredTokens).to.eq(ether(1.5));
    });

    it("should set the recoveryExecuted flag to true", async () => {
      await subject();

      const redemptionInitiated = await apyRescue.recoveryExecuted();

      expect(redemptionInitiated).to.be.true;
    });

    describe("when the rescue has already been performed", async () => {
      beforeEach(async () => {
        await apyRescue.connect(owner.wallet).recoverAssets();
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("APYRescue: redemption already initiated");
      });
    });
  });

  describe("#withdrawRescuedFunds", async () => {
    let subjectCaller: Account;

    beforeEach(async () => {
      await setup.weth.connect(owner.wallet).approve(issuanceModule.address, ether(1.5));
      await issuanceModule.connect(owner.wallet).issue(apyToken.address, ether(1.5), owner.address);
      await apyToken.connect(owner.wallet).transfer(recipient.address, ether(0.5));

      await apyToken.approve(apyRescue.address, ether(1));
      await apyRescue.connect(owner.wallet).deposit(ether(1));

      await apyToken.connect(recipient.wallet).approve(apyRescue.address, ether(.5));
      await apyRescue.connect(recipient.wallet).deposit(ether(.5));

      await apyRescue.connect(owner.wallet).recoverAssets();

      subjectCaller = owner;
    });

    async function subject(): Promise<any> {
      return apyRescue.connect(subjectCaller.wallet).withdrawRecoveredFunds();
    }

    it("should withdraw the correct amount of tokens", async () => {
      const preBalance = await setup.weth.balanceOf(apyRescue.address);

      await subject();

      const postBalance = await setup.weth.balanceOf(apyRescue.address);

      expect(postBalance).to.eq(preBalance.sub(ether(1)));
    });

    it("should transfer the correct amount of tokens to the caller", async () => {
      const preBalance = await setup.weth.balanceOf(subjectCaller.address);

      await subject();

      const postBalance = await setup.weth.balanceOf(subjectCaller.address);

      expect(postBalance).to.eq(preBalance.add(ether(1)));
    });

    it("should set callers apyTokenBalance to 0", async () => {
      await subject();

      const apyTokenBalance = await apyRescue.shares(subjectCaller.address);

      expect(apyTokenBalance).to.eq(ZERO);
    });
  });
});
