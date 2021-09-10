import "module-alias/register";

import { BigNumber } from "ethers";

import { Address, NAVIssuanceSettings } from "@utils/types";
import { Account } from "@utils/test/types";
import { ZERO, ADDRESS_ZERO } from "@utils/constants";
import { NAVIssuanceCaller, NavIssuanceModule, SetToken, UniswapYieldHook } from "@utils/contracts";
import DeployHelper from "@utils/deploys";
import {
  bitcoin,
  ether,
  usdc,
} from "@utils/index";
import {
  addSnapshotBeforeRestoreAfterEach,
  getAccounts,
  getWaffleExpect,
  getSystemFixture,
  getRandomAccount,
} from "@utils/test/index";

import { SystemFixture } from "@utils/fixtures";

const expect = getWaffleExpect();

describe("UniswapYieldHook", () => {
  let owner: Account;
  let feeRecipient: Account;
  let recipient: Account;
  let deployer: DeployHelper;

  let setup: SystemFixture;
  let navIssuanceModule: NavIssuanceModule;
  let setToken: SetToken;

  let hook: UniswapYieldHook;
  let navIssuanceCaller: NAVIssuanceCaller;

  const setRedeemLimit: BigNumber = ether(435);
  const usdcIssueLimit: BigNumber = usdc(100000);
  const ethIssueLimit: BigNumber = ether(435);

  before(async () => {
    [
      owner,
      feeRecipient,
      recipient,
    ] = await getAccounts();

    deployer = new DeployHelper(owner.wallet);
    setup = getSystemFixture(owner.address);
    await setup.initialize();

    navIssuanceModule = await deployer.modules.deployNavIssuanceModule(setup.controller.address, setup.weth.address);
    await setup.controller.addModule(navIssuanceModule.address);

    setToken = await setup.createSetToken(
      [setup.weth.address],
      [ether(1)],
      [navIssuanceModule.address, setup.issuanceModule.address]
    );

    hook = await deployer.product.deployUniswapYieldHook(
      [setToken.address, setup.usdc.address, setup.weth.address],
      [setRedeemLimit, usdcIssueLimit, ethIssueLimit],
    );

    navIssuanceCaller = await deployer.mocks.deployNAVIssuanceCaller(navIssuanceModule.address);

    const navIssuanceSettings = {
      managerIssuanceHook: hook.address,
      managerRedemptionHook: hook.address,
      reserveAssets: [setup.usdc.address, setup.weth.address],
      feeRecipient: feeRecipient.address,
      managerFees: [ether(0.001), ether(0.002)],
      maxManagerFee: ether(0.02),
      premiumPercentage: ether(0.01),
      maxPremiumPercentage: ether(0.1),
      minSetTokenSupply: ether(100),
    } as NAVIssuanceSettings;

    await navIssuanceModule.initialize(
      setToken.address,
      navIssuanceSettings
    );

    // Approve tokens to the controller
    await setup.weth.approve(setup.controller.address, ether(100));
    await setup.usdc.approve(setup.controller.address, usdc(1000000));
    await setup.wbtc.approve(setup.controller.address, bitcoin(1000000));
    await setup.dai.approve(setup.controller.address, ether(1000000));

    // Seed with 100 supply
    await setup.issuanceModule.initialize(setToken.address, ADDRESS_ZERO);
    await setup.issuanceModule.issue(setToken.address, ether(100), owner.address);
  });

  addSnapshotBeforeRestoreAfterEach();

  describe("#constructor", async () => {
    let subjectAssets: Address[];
    let subjectLimits: BigNumber[];

    beforeEach(async () => {
      subjectAssets = [setup.weth.address, setup.usdc.address];
      subjectLimits = [ether(400), usdc(100000)];
    });

    async function subject(): Promise<UniswapYieldHook> {
      return await deployer.product.deployUniswapYieldHook(subjectAssets, subjectLimits);
    }

    it("should set the correct limits", async () => {
      const hook = await subject();

      const wethLimit = await hook.assetLimits(subjectAssets[0]);
      const usdcLimit = await hook.assetLimits(subjectAssets[1]);
      expect(wethLimit).to.eq(subjectLimits[0]);
      expect(usdcLimit).to.eq(subjectLimits[1]);
    });

    it("should set the correct assets", async () => {
      const hook = await subject();

      const assets = await hook.getAssets();
      expect(JSON.stringify(assets)).to.eq(JSON.stringify(subjectAssets));
    });

    describe("when asset is duplicated", async () => {
      beforeEach(async () => {
        subjectAssets = [setup.weth.address, setup.weth.address];
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Asset already added");
      });
    });

    describe("when array lengths don't match", async () => {
      beforeEach(async () => {
        subjectAssets = [setup.weth.address];
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Arrays must be equal");
      });
    });

    describe("when arrays are empty", async () => {
      beforeEach(async () => {
        subjectAssets = [];
        subjectLimits = [];
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Array must not be empty");
      });
    });
  });

  describe("#issue", async () => {
    let subjectSetToken: Address;
    let subjectReserveAsset: Address;
    let subjectReserveQuantity: BigNumber;
    let subjectMinSetTokenReceived: BigNumber;
    let subjectTo: Account;
    let subjectCallFromContract: boolean;

    beforeEach(async () => {
      subjectSetToken = setToken.address;
      subjectReserveAsset = setup.usdc.address;
      subjectReserveQuantity = usdc(150000);
      subjectMinSetTokenReceived = ZERO;
      subjectTo = recipient;
      subjectCallFromContract = false;

      await setup.usdc.approve(navIssuanceModule.address, subjectReserveQuantity);
    });

    async function subject(): Promise<any> {
      if (subjectCallFromContract) {
        await setup.usdc.connect(owner.wallet).transfer(navIssuanceCaller.address, subjectReserveQuantity);
        return navIssuanceCaller.issue(
          subjectSetToken,
          subjectReserveAsset,
          subjectReserveQuantity,
          subjectMinSetTokenReceived,
          subjectTo.address
        );
      } else {
        return navIssuanceModule.issue(
          subjectSetToken,
          subjectReserveAsset,
          subjectReserveQuantity,
          subjectMinSetTokenReceived,
          subjectTo.address
        );
      }
    }

    it("should not revert", async () => {
      await expect(subject()).to.not.be.reverted;
    });

    describe("when call is from contract but less than redeem limit", async () => {
      beforeEach(async () => {
        subjectCallFromContract = true;
        subjectReserveQuantity = usdc(90000);
      });

      it("should not revert", async () => {
        await expect(subject()).to.not.be.reverted;
      });
    });

    describe("when call is from contract but greater than redeem limit", async () => {
      beforeEach(async () => {
        subjectCallFromContract = true;
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Issue size too large for call from contract.");
      });
    });
  });

  describe("#redeem", async () => {
    let subjectSetToken: Address;
    let subjectReserveAsset: Address;
    let subjectSetTokenQuantity: BigNumber;
    let subjectMinReserveQuantityReceived: BigNumber;
    let subjectTo: Account;
    let subjectCallFromContract: boolean;

    beforeEach(async () => {
      await setup.usdc.approve(navIssuanceModule.address, usdc(150000));
      await navIssuanceModule.issue(
        setToken.address,
        setup.usdc.address,
        usdc(150000),
        ZERO,
        owner.address
      );

      subjectSetToken = setToken.address;
      subjectReserveAsset = setup.usdc.address;
      subjectSetTokenQuantity = ether(500);
      subjectMinReserveQuantityReceived = ZERO;
      subjectTo = recipient;
      subjectCallFromContract = false;
    });

    async function subject(): Promise<any> {
      if (subjectCallFromContract) {
        await setToken.connect(owner.wallet).transfer(navIssuanceCaller.address, subjectSetTokenQuantity);
        return navIssuanceCaller.redeem(
          subjectSetToken,
          subjectReserveAsset,
          subjectSetTokenQuantity,
          subjectMinReserveQuantityReceived,
          subjectTo.address
        );
      } else {
        return navIssuanceModule.redeem(
          subjectSetToken,
          subjectReserveAsset,
          subjectSetTokenQuantity,
          subjectMinReserveQuantityReceived,
          subjectTo.address
        );
      }
    }

    it("should not revert", async () => {
      await expect(subject()).to.not.be.reverted;
    });

    describe("when call is from contract but less than redeem limit", async () => {
      beforeEach(async () => {
        subjectCallFromContract = true;
        subjectSetTokenQuantity = ether(400);
      });

      it("should not revert", async () => {
        await expect(subject()).to.not.be.reverted;
      });
    });

    describe("when call is from contract but greater than redeem limit", async () => {
      beforeEach(async () => {
        subjectCallFromContract = true;
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Redeem size too large for call from contract.");
      });
    });
  });

  describe("#addAssetLimit", async () => {
    let subjectAsset: Address;
    let subjectLimit: BigNumber;
    let subjectCaller: Account;

    beforeEach(async () => {
      subjectAsset = setup.wbtc.address;
      subjectLimit = bitcoin(10);
      subjectCaller = owner;
    });

    async function subject(): Promise<any> {
      return await hook.connect(subjectCaller.wallet).addAssetLimit(subjectAsset, subjectLimit);
    }

    it("should set the correct limits", async () => {
      await subject();

      const wbtcLimit = await hook.assetLimits(subjectAsset);
      expect(wbtcLimit).to.eq(subjectLimit);
    });

    it("should add wbtc to assets array", async () => {
      await subject();

      const assets = await hook.getAssets();
      expect(assets).to.contain(subjectAsset);
    });

    describe("when asset is duplicated", async () => {
      beforeEach(async () => {
        subjectAsset = setup.weth.address;
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Asset already added");
      });
    });

    describe("when caller is not owner", async () => {
      beforeEach(async () => {
        subjectCaller = await getRandomAccount();
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Ownable: caller is not the owner");
      });
    });
  });

  describe("#editAssetLimit", async () => {
    let subjectAsset: Address;
    let subjectLimit: BigNumber;
    let subjectCaller: Account;

    beforeEach(async () => {
      subjectAsset = setup.weth.address;
      subjectLimit = ether(100);
      subjectCaller = owner;
    });

    async function subject(): Promise<any> {
      return await hook.connect(subjectCaller.wallet).editAssetLimit(subjectAsset, subjectLimit);
    }

    it("should set the correct limits", async () => {
      await subject();

      const wethLimit = await hook.assetLimits(subjectAsset);
      expect(wethLimit).to.eq(subjectLimit);
    });

    describe("when asset is not already added", async () => {
      beforeEach(async () => {
        subjectAsset = setup.wbtc.address;
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Asset not added");
      });
    });

    describe("when caller is not owner", async () => {
      beforeEach(async () => {
        subjectCaller = await getRandomAccount();
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Ownable: caller is not the owner");
      });
    });
  });

  describe("#removeAssetLimit", async () => {
    let subjectAsset: Address;
    let subjectCaller: Account;

    beforeEach(async () => {
      subjectAsset = setup.weth.address;
      subjectCaller = owner;
    });

    async function subject(): Promise<any> {
      return await hook.connect(subjectCaller.wallet).removeAssetLimit(subjectAsset);
    }

    it("should set the correct limits", async () => {
      await subject();

      const wethLimit = await hook.assetLimits(subjectAsset);
      expect(wethLimit).to.eq(ZERO);
    });

    it("should remove weth from assets array", async () => {
      await subject();

      const assets = await hook.getAssets();
      expect(assets).to.not.contain(subjectAsset);
    });

    describe("when asset is not already added", async () => {
      beforeEach(async () => {
        subjectAsset = setup.wbtc.address;
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Asset not added");
      });
    });

    describe("when caller is not owner", async () => {
      beforeEach(async () => {
        subjectCaller = await getRandomAccount();
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Ownable: caller is not the owner");
      });
    });
  });
});
