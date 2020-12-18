import "module-alias/register";

import { BigNumber } from "ethers/utils";

import { Address, Account, NAVIssuanceSettings } from "@utils/types";
import { ONE, TWO, THREE, ZERO, ADDRESS_ZERO } from "@utils/constants";
import { ManagerIssuanceHookMock, NavIssuanceHookMock, NavIssuanceModule, SetToken } from "@utils/contracts";
import DeployHelper from "@utils/deploys";
import {
  addSnapshotBeforeRestoreAfterEach,
  bitcoin,
  ether,
  getAccounts,
  getExpectedIssuePositionMultiplier,
  getExpectedIssuePositionUnit,
  getExpectedPostFeeQuantity,
  getExpectedSetTokenIssueQuantity,
  getExpectedReserveRedeemQuantity,
  getExpectedRedeemPositionMultiplier,
  getExpectedRedeemPositionUnit,
  getProvider,
  getRandomAddress,
  getRandomAccount,
  getWaffleExpect,
  getSystemFixture,
  preciseMul,
  usdc,
} from "@utils/index";
import { SystemFixture } from "@utils/fixtures";
import { Erc20Factory } from "../../../typechain/Erc20Factory";

const expect = getWaffleExpect();

describe("NavIssuanceModule", () => {
  let owner: Account;
  let feeRecipient: Account;
  let recipient: Account;
  let deployer: DeployHelper;

  let setup: SystemFixture;
  let navIssuanceModule: NavIssuanceModule;

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
  });

  addSnapshotBeforeRestoreAfterEach();

  describe("#constructor", async () => {
    let subjectController: Address;
    let subjectWETH: Address;

    beforeEach(async () => {
      subjectController = setup.controller.address;
      subjectWETH = setup.weth.address;
    });

    async function subject(): Promise<NavIssuanceModule> {
      return deployer.modules.deployNavIssuanceModule(subjectController, subjectWETH);
    }

    it("should set the correct controller", async () => {
      const navIssuanceModule = await subject();

      const controller = await navIssuanceModule.controller();
      expect(controller).to.eq(subjectController);
    });

    it("should set the correct weth contract", async () => {
      const navIssuanceModule = await subject();

      const weth = await navIssuanceModule.weth();
      expect(weth).to.eq(subjectWETH);
    });
  });

  describe("#initialize", async () => {
    let setToken: SetToken;
    let managerIssuanceHook: Address;
    let managerRedemptionHook: Address;
    let reserveAssets: Address[];
    let managerFeeRecipient: Address;
    let managerFees: BigNumber[];
    let maxManagerFee: BigNumber;
    let premiumPercentage: BigNumber;
    let maxPremiumPercentage: BigNumber;
    let minSetTokenSupply: BigNumber;

    let subjectNAVIssuanceSettings: NAVIssuanceSettings;
    let subjectSetToken: Address;
    let subjectCaller: Account;

    beforeEach(async () => {
      setToken = await setup.createSetToken(
        [setup.weth.address],
        [ether(1)],
        [navIssuanceModule.address]
      );
      managerIssuanceHook = await getRandomAddress();
      managerRedemptionHook = await getRandomAddress();
      reserveAssets = [setup.usdc.address, setup.weth.address];
      managerFeeRecipient = feeRecipient.address;
      // Set manager issue fee to 0.1% and redeem to 0.2%
      managerFees = [ether(0.001), ether(0.002)];
      // Set max managerFee to 2%
      maxManagerFee = ether(0.02);
      // Set premium to 1%
      premiumPercentage = ether(0.01);
      // Set max premium to 10%
      maxPremiumPercentage = ether(0.1);
      // Set min SetToken supply to 100 units
      minSetTokenSupply = ether(100);

      subjectSetToken = setToken.address;
      subjectNAVIssuanceSettings = {
        managerIssuanceHook,
        managerRedemptionHook,
        reserveAssets,
        feeRecipient: managerFeeRecipient,
        managerFees,
        maxManagerFee,
        premiumPercentage,
        maxPremiumPercentage,
        minSetTokenSupply,
      } as NAVIssuanceSettings;
      subjectCaller = owner;
    });

    async function subject(): Promise<any> {
      return navIssuanceModule.connect(subjectCaller.wallet).initialize(
        subjectSetToken,
        subjectNAVIssuanceSettings
      );
    }

    it("should set the correct NAV issuance settings", async () => {
      await subject();

      const navIssuanceSettings: any = await navIssuanceModule.navIssuanceSettings(subjectSetToken);
      const retrievedReserveAssets = await navIssuanceModule.getReserveAssets(subjectSetToken);
      const managerIssueFee = await navIssuanceModule.getManagerFee(subjectSetToken, ZERO);
      const managerRedeemFee = await navIssuanceModule.getManagerFee(subjectSetToken, ONE);

      expect(JSON.stringify(retrievedReserveAssets)).to.eq(JSON.stringify(reserveAssets));
      expect(navIssuanceSettings.managerIssuanceHook).to.eq(managerIssuanceHook);
      expect(navIssuanceSettings.managerRedemptionHook).to.eq(managerRedemptionHook);
      expect(navIssuanceSettings.feeRecipient).to.eq(managerFeeRecipient);
      expect(managerIssueFee).to.eq(managerFees[0]);
      expect(managerRedeemFee).to.eq(managerFees[1]);
      expect(navIssuanceSettings.maxManagerFee).to.eq(maxManagerFee);
      expect(navIssuanceSettings.premiumPercentage).to.eq(premiumPercentage);
      expect(navIssuanceSettings.maxPremiumPercentage).to.eq(maxPremiumPercentage);
      expect(navIssuanceSettings.minSetTokenSupply).to.eq(minSetTokenSupply);
    });

    it("should enable the Module on the SetToken", async () => {
      await subject();
      const isModuleEnabled = await setToken.isInitializedModule(navIssuanceModule.address);
      expect(isModuleEnabled).to.eq(true);
    });

    it("should properly set reserve assets mapping", async () => {
      await subject();
      const isUsdcReserveAsset = await navIssuanceModule.isReserveAsset(subjectSetToken, setup.usdc.address);
      const isWethReserveAsset = await navIssuanceModule.isReserveAsset(subjectSetToken, setup.weth.address);
      expect(isUsdcReserveAsset).to.eq(true);
      expect(isWethReserveAsset).to.eq(true);
    });

    describe("when the caller is not the SetToken manager", async () => {
      beforeEach(async () => {
        subjectCaller = await getRandomAccount();
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Must be the SetToken manager");
      });
    });

    describe("when SetToken is not in pending state", async () => {
      beforeEach(async () => {
        const newModule = await getRandomAddress();
        await setup.controller.addModule(newModule);

        const navIssuanceModuleNotPendingSetToken = await setup.createSetToken(
          [setup.weth.address],
          [ether(1)],
          [newModule]
        );

        subjectSetToken = navIssuanceModuleNotPendingSetToken.address;
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Must be pending initialization");
      });
    });

    describe("when the SetToken is not enabled on the controller", async () => {
      beforeEach(async () => {
        const nonEnabledSetToken = await setup.createNonControllerEnabledSetToken(
          [setup.weth.address],
          [ether(1)],
          [navIssuanceModule.address]
        );

        subjectSetToken = nonEnabledSetToken.address;
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Must be controller-enabled SetToken");
      });
    });

    describe("when no reserve assets are specified", async () => {
      beforeEach(async () => {
        subjectNAVIssuanceSettings.reserveAssets = [];
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Reserve assets must be greater than 0");
      });
    });

    describe("when reserve asset is duplicated", async () => {
      beforeEach(async () => {
        subjectNAVIssuanceSettings.reserveAssets = [setup.weth.address, setup.weth.address];
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Reserve assets must be unique");
      });
    });

    describe("when manager issue fee is greater than max", async () => {
      beforeEach(async () => {
        // Set to 100%
        subjectNAVIssuanceSettings.managerFees = [ether(1), ether(0.002)];
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Manager issue fee must be less than max");
      });
    });

    describe("when manager redeem fee is greater than max", async () => {
      beforeEach(async () => {
        // Set to 100%
        subjectNAVIssuanceSettings.managerFees = [ether(0.001), ether(1)];
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Manager redeem fee must be less than max");
      });
    });

    describe("when max manager fee is greater than 100%", async () => {
      beforeEach(async () => {
        // Set to 200%
        subjectNAVIssuanceSettings.maxManagerFee = ether(2);
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Max manager fee must be less than 100%");
      });
    });

    describe("when premium is greater than max", async () => {
      beforeEach(async () => {
        // Set to 100%
        subjectNAVIssuanceSettings.premiumPercentage = ether(1);
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Premium must be less than max");
      });
    });

    describe("when premium is greater than 100%", async () => {
      beforeEach(async () => {
        // Set to 100%
        subjectNAVIssuanceSettings.maxPremiumPercentage = ether(2);
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Max premium percentage must be less than 100%");
      });
    });

    describe("when feeRecipient is zero address", async () => {
      beforeEach(async () => {
        subjectNAVIssuanceSettings.feeRecipient = ADDRESS_ZERO;
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Fee Recipient must be non-zero address.");
      });
    });

    describe("when min SetToken supply is 0", async () => {
      beforeEach(async () => {
        subjectNAVIssuanceSettings.minSetTokenSupply = ZERO;
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Min SetToken supply must be greater than 0");
      });
    });
  });

  describe("#removeModule", async () => {
    let setToken: SetToken;

    let subjectSetToken: Address;
    let subjectModule: Address;

    beforeEach(async () => {
      setToken = await setup.createSetToken(
        [setup.weth.address],
        [ether(1)],
        [navIssuanceModule.address]
      );
      // Set premium to 1%
      const managerIssuanceHook = await getRandomAddress();
      const managerRedemptionHook = await getRandomAddress();
      const reserveAssets = [setup.usdc.address, setup.weth.address];
      const managerFeeRecipient = feeRecipient.address;
      // Set manager issue fee to 0.1% and redeem to 0.2%
      const managerFees = [ether(0.001), ether(0.002)];
      // Set max managerFee to 2%
      const maxManagerFee = ether(0.02);
      // Set premium to 1%
      const premiumPercentage = ether(0.01);
      // Set max premium to 10%
      const maxPremiumPercentage = ether(0.1);
      // Set min SetToken supply required
      const minSetTokenSupply = ether(1);

      subjectSetToken = setToken.address;
      await navIssuanceModule.connect(owner.wallet).initialize(
        setToken.address,
        {
          managerIssuanceHook,
          managerRedemptionHook,
          reserveAssets,
          feeRecipient: managerFeeRecipient,
          managerFees,
          maxManagerFee,
          premiumPercentage,
          maxPremiumPercentage,
          minSetTokenSupply,
        }
      );

      subjectModule = navIssuanceModule.address;
    });

    async function subject(): Promise<any> {
      return setToken.removeModule(subjectModule);
    }

    it("should delete reserve assets state", async () => {
      await subject();
      const isUsdcReserveAsset = await navIssuanceModule.isReserveAsset(setToken.address, setup.usdc.address);
      const isWethReserveAsset = await navIssuanceModule.isReserveAsset(setToken.address, setup.weth.address);
      expect(isUsdcReserveAsset).to.be.false;
      expect(isWethReserveAsset).to.be.false;
    });

    it("should delete the NAV issuance settings", async () => {
      await subject();

      const navIssuanceSettings: any = await navIssuanceModule.navIssuanceSettings(subjectSetToken);
      const retrievedReserveAssets = await navIssuanceModule.getReserveAssets(subjectSetToken);
      const managerIssueFee = await navIssuanceModule.getManagerFee(subjectSetToken, ZERO);
      const managerRedeemFee = await navIssuanceModule.getManagerFee(subjectSetToken, ONE);

      expect(retrievedReserveAssets).to.be.empty;
      expect(navIssuanceSettings.managerIssuanceHook).to.eq(ADDRESS_ZERO);
      expect(navIssuanceSettings.managerRedemptionHook).to.eq(ADDRESS_ZERO);
      expect(navIssuanceSettings.feeRecipient).to.eq(ADDRESS_ZERO);
      expect(managerIssueFee).to.eq(ZERO);
      expect(managerRedeemFee).to.eq(ZERO);
      expect(navIssuanceSettings.maxManagerFee).to.eq(ZERO);
      expect(navIssuanceSettings.premiumPercentage).to.eq(ZERO);
      expect(navIssuanceSettings.maxPremiumPercentage).to.eq(ZERO);
      expect(navIssuanceSettings.minSetTokenSupply).to.eq(ZERO);
    });
  });

  describe("#getReserveAssets", async () => {
    let reserveAssets: Address[];
    let subjectSetToken: Address;

    beforeEach(async () => {
      const setToken = await setup.createSetToken(
        [setup.weth.address],
        [ether(1)],
        [navIssuanceModule.address]
      );
      const managerIssuanceHook = await getRandomAddress();
      const managerRedemptionHook = await getRandomAddress();
      reserveAssets = [setup.usdc.address, setup.weth.address];
      const managerFeeRecipient = feeRecipient.address;
      // Set manager issue fee to 0.1% and redeem to 0.2%
      const managerFees = [ether(0.001), ether(0.002)];
      // Set max managerFee to 2%
      const maxManagerFee = ether(0.02);
      // Set premium to 1%
      const premiumPercentage = ether(0.01);
      // Set max premium to 10%
      const maxPremiumPercentage = ether(0.1);
      // Set min SetToken supply to 100 units
      const minSetTokenSupply = ether(100);

      const navIssuanceSettings = {
        managerIssuanceHook,
        managerRedemptionHook,
        reserveAssets,
        feeRecipient: managerFeeRecipient,
        managerFees,
        maxManagerFee,
        premiumPercentage,
        maxPremiumPercentage,
        minSetTokenSupply,
      } as NAVIssuanceSettings;

      await navIssuanceModule.initialize(
        setToken.address,
        navIssuanceSettings
      );

      subjectSetToken = setToken.address;
    });

    async function subject(): Promise<any> {
      return navIssuanceModule.getReserveAssets(subjectSetToken);
    }

    it("should return the valid reserve assets", async () => {
      const returnedReserveAssets = await subject();

      expect(JSON.stringify(returnedReserveAssets)).to.eq(JSON.stringify(reserveAssets));
    });
  });

  describe("#getIssuePremium", async () => {
    let premiumPercentage: BigNumber;
    let subjectSetToken: Address;
    let subjectReserveAsset: Address;
    let subjectReserveQuantity: BigNumber;

    beforeEach(async () => {
      const setToken = await setup.createSetToken(
        [setup.weth.address],
        [ether(1)],
        [navIssuanceModule.address]
      );
      const managerIssuanceHook = await getRandomAddress();
      const managerRedemptionHook = await getRandomAddress();
      const reserveAssets = [setup.usdc.address, setup.weth.address];
      const managerFeeRecipient = feeRecipient.address;
      // Set manager issue fee to 0.1% and redeem to 0.2%
      const managerFees = [ether(0.001), ether(0.002)];
      // Set max managerFee to 2%
      const maxManagerFee = ether(0.02);
      // Set premium to 1%
      premiumPercentage = ether(0.01);
      // Set max premium to 10%
      const maxPremiumPercentage = ether(0.1);
      // Set min SetToken supply to 100 units
      const minSetTokenSupply = ether(100);

      const navIssuanceSettings = {
        managerIssuanceHook,
        managerRedemptionHook,
        reserveAssets,
        feeRecipient: managerFeeRecipient,
        managerFees,
        maxManagerFee,
        premiumPercentage,
        maxPremiumPercentage,
        minSetTokenSupply,
      } as NAVIssuanceSettings;

      await navIssuanceModule.initialize(
        setToken.address,
        navIssuanceSettings
      );

      subjectSetToken = setToken.address;
      subjectReserveAsset = await getRandomAddress(); // Unused in NavIssuanceModule V1
      subjectReserveQuantity = ether(1); // Unused in NAVIssuanceModule V1
    });

    async function subject(): Promise<any> {
      return navIssuanceModule.getIssuePremium(subjectSetToken, subjectReserveAsset, subjectReserveQuantity);
    }

    it("should return the correct premium", async () => {
      const returnedPremiumPercentage = await subject();

      expect(returnedPremiumPercentage).to.eq(premiumPercentage);
    });
  });

  describe("#getRedeemPremium", async () => {
    let premiumPercentage: BigNumber;
    let subjectSetToken: Address;
    let subjectReserveAsset: Address;
    let subjectSetTokenQuantity: BigNumber;

    beforeEach(async () => {
      const setToken = await setup.createSetToken(
        [setup.weth.address],
        [ether(1)],
        [navIssuanceModule.address]
      );
      const managerIssuanceHook = await getRandomAddress();
      const managerRedemptionHook = await getRandomAddress();
      const reserveAssets = [setup.usdc.address, setup.weth.address];
      const managerFeeRecipient = feeRecipient.address;
      // Set manager issue fee to 0.1% and redeem to 0.2%
      const managerFees = [ether(0.001), ether(0.002)];
      // Set max managerFee to 2%
      const maxManagerFee = ether(0.02);
      // Set premium to 1%
      premiumPercentage = ether(0.01);
      // Set max premium to 10%
      const maxPremiumPercentage = ether(0.1);
      // Set min SetToken supply to 100 units
      const minSetTokenSupply = ether(100);

      const navIssuanceSettings = {
        managerIssuanceHook,
        managerRedemptionHook,
        reserveAssets,
        feeRecipient: managerFeeRecipient,
        managerFees,
        maxManagerFee,
        premiumPercentage,
        maxPremiumPercentage,
        minSetTokenSupply,
      } as NAVIssuanceSettings;

      await navIssuanceModule.initialize(
        setToken.address,
        navIssuanceSettings
      );

      subjectSetToken = setToken.address;
      subjectReserveAsset = await getRandomAddress(); // Unused in NavIssuanceModule V1
      subjectSetTokenQuantity = ether(1); // Unused in NAVIssuanceModule V1
    });

    async function subject(): Promise<any> {
      return navIssuanceModule.getRedeemPremium(subjectSetToken, subjectReserveAsset, subjectSetTokenQuantity);
    }

    it("should return the correct premium", async () => {
      const returnedPremiumPercentage = await subject();

      expect(returnedPremiumPercentage).to.eq(premiumPercentage);
    });
  });

  describe("#getManagerFee", async () => {
    let managerFees: BigNumber[];
    let subjectSetToken: Address;
    let subjectFeeIndex: BigNumber;

    beforeEach(async () => {
      const setToken = await setup.createSetToken(
        [setup.weth.address],
        [ether(1)],
        [navIssuanceModule.address]
      );
      const managerIssuanceHook = await getRandomAddress();
      const managerRedemptionHook = await getRandomAddress();
      const reserveAssets = [setup.usdc.address, setup.weth.address];
      const managerFeeRecipient = feeRecipient.address;
      // Set manager issue fee to 0.1% and redeem to 0.2%
      managerFees = [ether(0.001), ether(0.002)];
      // Set max managerFee to 2%
      const maxManagerFee = ether(0.02);
      // Set premium to 1%
      const premiumPercentage = ether(0.01);
      // Set max premium to 10%
      const maxPremiumPercentage = ether(0.1);
      // Set min SetToken supply to 100 units
      const minSetTokenSupply = ether(100);

      const navIssuanceSettings = {
        managerIssuanceHook,
        managerRedemptionHook,
        reserveAssets,
        feeRecipient: managerFeeRecipient,
        managerFees,
        maxManagerFee,
        premiumPercentage,
        maxPremiumPercentage,
        minSetTokenSupply,
      } as NAVIssuanceSettings;

      await navIssuanceModule.initialize(
        setToken.address,
        navIssuanceSettings
      );

      subjectSetToken = setToken.address;
      subjectFeeIndex = ZERO;
    });

    async function subject(): Promise<any> {
      return navIssuanceModule.getManagerFee(subjectSetToken, subjectFeeIndex);
    }

    it("should return the manager fee", async () => {
      const returnedManagerFee = await subject();

      expect(returnedManagerFee).to.eq(managerFees[0]);
    });
  });

  describe("#getExpectedSetTokenIssueQuantity", async () => {
    let subjectSetToken: Address;
    let subjectReserveAsset: Address;
    let subjectReserveQuantity: BigNumber;

    let setToken: SetToken;
    let managerFees: BigNumber[];
    let protocolDirectFee: BigNumber;
    let premiumPercentage: BigNumber;

    beforeEach(async () => {
      setToken = await setup.createSetToken(
        [setup.weth.address],
        [ether(1)],
        [navIssuanceModule.address]
      );
      const managerIssuanceHook = await getRandomAddress();
      const managerRedemptionHook = await getRandomAddress();
      const reserveAssets = [setup.usdc.address, setup.weth.address];
      const managerFeeRecipient = feeRecipient.address;
      // Set manager issue fee to 0.1% and redeem to 0.2%
      managerFees = [ether(0.001), ether(0.002)];
      // Set max managerFee to 2%
      const maxManagerFee = ether(0.02);
      // Set premium to 1%
      premiumPercentage = ether(0.01);
      // Set max premium to 10%
      const maxPremiumPercentage = ether(0.1);
      // Set min SetToken supply to 100 units
      const minSetTokenSupply = ether(100);

      const navIssuanceSettings = {
        managerIssuanceHook,
        managerRedemptionHook,
        reserveAssets,
        feeRecipient: managerFeeRecipient,
        managerFees,
        maxManagerFee,
        premiumPercentage,
        maxPremiumPercentage,
        minSetTokenSupply,
      } as NAVIssuanceSettings;

      await navIssuanceModule.initialize(
        setToken.address,
        navIssuanceSettings
      );

      protocolDirectFee = ether(.02);
      await setup.controller.addFee(navIssuanceModule.address, TWO, protocolDirectFee);

      const protocolManagerFee = ether(.3);
      await setup.controller.addFee(navIssuanceModule.address, ZERO, protocolManagerFee);

      subjectSetToken = setToken.address;
      subjectReserveAsset = setup.usdc.address;
      subjectReserveQuantity = ether(1);
    });

    async function subject(): Promise<any> {
      return navIssuanceModule.getExpectedSetTokenIssueQuantity(subjectSetToken, subjectReserveAsset, subjectReserveQuantity);
    }

    it("should return the correct expected Set issue quantity", async () => {
      const expectedSetTokenIssueQuantity = await getExpectedSetTokenIssueQuantity(
        setToken,
        setup.setValuer,
        subjectReserveAsset,
        usdc(1),
        subjectReserveQuantity,
        managerFees[0],
        protocolDirectFee,
        premiumPercentage
      );
      const returnedSetTokenIssueQuantity = await subject();
      expect(expectedSetTokenIssueQuantity).to.eq(returnedSetTokenIssueQuantity);
    });
  });

  describe("#getExpectedReserveRedeemQuantity", async () => {
    let subjectSetToken: Address;
    let subjectReserveAsset: Address;
    let subjectSetTokenQuantity: BigNumber;

    let setToken: SetToken;
    let managerFees: BigNumber[];
    let protocolDirectFee: BigNumber;
    let premiumPercentage: BigNumber;

    beforeEach(async () => {
      setToken = await setup.createSetToken(
        [setup.weth.address, setup.usdc.address, setup.wbtc.address, setup.dai.address],
        [ether(1), usdc(270), bitcoin(1).div(10), ether(600)],
        [setup.issuanceModule.address, navIssuanceModule.address]
      );
      const managerIssuanceHook = await getRandomAddress();
      const managerRedemptionHook = await getRandomAddress();
      const reserveAssets = [setup.usdc.address, setup.weth.address];
      const managerFeeRecipient = feeRecipient.address;
      // Set manager issue fee to 0.1% and redeem to 0.2%
      managerFees = [ether(0.001), ether(0.002)];
      // Set max managerFee to 2%
      const maxManagerFee = ether(0.02);
      // Set premium to 1%
      premiumPercentage = ether(0.01);
      // Set max premium to 10%
      const maxPremiumPercentage = ether(0.1);
      // Set min SetToken supply to 1 unit
      const minSetTokenSupply = ether(1);

      const navIssuanceSettings = {
        managerIssuanceHook,
        managerRedemptionHook,
        reserveAssets,
        feeRecipient: managerFeeRecipient,
        managerFees,
        maxManagerFee,
        premiumPercentage,
        maxPremiumPercentage,
        minSetTokenSupply,
      } as NAVIssuanceSettings;

      await navIssuanceModule.initialize(setToken.address, navIssuanceSettings);
      // Approve tokens to the controller
      await setup.weth.approve(setup.controller.address, ether(100));
      await setup.usdc.approve(setup.controller.address, usdc(1000000));
      await setup.wbtc.approve(setup.controller.address, bitcoin(1000000));
      await setup.dai.approve(setup.controller.address, ether(1000000));

      // Seed with 10 supply
      await setup.issuanceModule.connect(owner.wallet).initialize(setToken.address, ADDRESS_ZERO);
      await setup.issuanceModule.connect(owner.wallet).issue(setToken.address, ether(10), owner.address);

      protocolDirectFee = ether(.02);
      await setup.controller.addFee(navIssuanceModule.address, THREE, protocolDirectFee);

      const protocolManagerFee = ether(.3);
      await setup.controller.addFee(navIssuanceModule.address, ONE, protocolManagerFee);

      subjectSetToken = setToken.address;
      subjectReserveAsset = setup.usdc.address;
      subjectSetTokenQuantity = ether(1);
    });

    async function subject(): Promise<any> {
      return navIssuanceModule.getExpectedReserveRedeemQuantity(subjectSetToken, subjectReserveAsset, subjectSetTokenQuantity);
    }

    it("should return the correct expected reserve asset redeem quantity", async () => {
      const setTokenValuation = await setup.setValuer.calculateSetTokenValuation(
        subjectSetToken,
        subjectReserveAsset
      );
      const expectedRedeemQuantity = getExpectedReserveRedeemQuantity(
        subjectSetTokenQuantity,
        setTokenValuation,
        usdc(1), // USDC base units
        managerFees[1],
        protocolDirectFee, // Protocol fee percentage
        premiumPercentage
      );
      const returnedRedeemQuantity = await subject();
      expect(expectedRedeemQuantity).to.eq(returnedRedeemQuantity);
    });
  });

  describe("#isIssueValid", async () => {
    let subjectSetToken: Address;
    let subjectReserveAsset: Address;
    let subjectReserveQuantity: BigNumber;

    let setToken: SetToken;

    beforeEach(async () => {
      setToken = await setup.createSetToken(
        [setup.weth.address, setup.usdc.address, setup.wbtc.address, setup.dai.address],
        [ether(1), usdc(270), bitcoin(1).div(10), ether(600)],
        [setup.issuanceModule.address, navIssuanceModule.address]
      );
      const managerIssuanceHook = await getRandomAddress();
      const managerRedemptionHook = await getRandomAddress();
      const reserveAssets = [setup.usdc.address, setup.weth.address];
      const managerFeeRecipient = feeRecipient.address;
      // Set manager issue fee to 0.1% and redeem to 0.2%
      const managerFees = [ether(0.001), ether(0.002)];
      // Set max managerFee to 2%
      const maxManagerFee = ether(0.02);
      // Set premium to 1%
      const premiumPercentage = ether(0.01);
      // Set max premium to 10%
      const maxPremiumPercentage = ether(0.1);
      // Set min SetToken supply to 100 units
      const minSetTokenSupply = ether(1);

      const navIssuanceSettings = {
        managerIssuanceHook,
        managerRedemptionHook,
        reserveAssets,
        feeRecipient: managerFeeRecipient,
        managerFees,
        maxManagerFee,
        premiumPercentage,
        maxPremiumPercentage,
        minSetTokenSupply,
      } as NAVIssuanceSettings;

      await navIssuanceModule.initialize(setToken.address, navIssuanceSettings);
      // Approve tokens to the controller
      await setup.weth.approve(setup.controller.address, ether(100));
      await setup.usdc.approve(setup.controller.address, usdc(1000000));
      await setup.wbtc.approve(setup.controller.address, bitcoin(1000000));
      await setup.dai.approve(setup.controller.address, ether(1000000));

      // Seed with 10 supply
      await setup.issuanceModule.connect(owner.wallet).initialize(setToken.address, ADDRESS_ZERO);
      await setup.issuanceModule.connect(owner.wallet).issue(setToken.address, ether(10), owner.address);

      const protocolDirectFee = ether(.02);
      await setup.controller.addFee(navIssuanceModule.address, TWO, protocolDirectFee);

      const protocolManagerFee = ether(.3);
      await setup.controller.addFee(navIssuanceModule.address, ZERO, protocolManagerFee);

      subjectSetToken = setToken.address;
      subjectReserveAsset = setup.usdc.address;
      subjectReserveQuantity = usdc(100);
    });

    async function subject(): Promise<any> {
      return navIssuanceModule.isIssueValid(subjectSetToken, subjectReserveAsset, subjectReserveQuantity);
    }

    it("should return true", async () => {
      const returnedValue = await subject();
      expect(returnedValue).to.eq(true);
    });

    describe("when total supply is less than min required for NAV issuance", async () => {
      beforeEach(async () => {
        // Redeem below required
        await setup.issuanceModule.connect(owner.wallet).redeem(setToken.address, ether(9.5), owner.address);
      });

      it("returns false", async () => {
        const returnedValue = await subject();
        expect(returnedValue).to.eq(false);
      });
    });

    describe("when the issue quantity is 0", async () => {
      beforeEach(async () => {
        subjectReserveQuantity = ZERO;
      });

      it("returns false", async () => {
        const returnedValue = await subject();
        expect(returnedValue).to.eq(false);
      });
    });

    describe("when the reserve asset is not valid", async () => {
      beforeEach(async () => {
        subjectReserveAsset = setup.wbtc.address;
      });

      it("returns false", async () => {
        const returnedValue = await subject();
        expect(returnedValue).to.eq(false);
      });
    });
  });

  describe("#isRedeemValid", async () => {
    let subjectSetToken: Address;
    let subjectReserveAsset: Address;
    let subjectSetTokenQuantity: BigNumber;

    let setToken: SetToken;

    beforeEach(async () => {
      setToken = await setup.createSetToken(
        [setup.weth.address, setup.usdc.address, setup.wbtc.address, setup.dai.address],
        [ether(1), usdc(270), bitcoin(1).div(10), ether(600)],
        [setup.issuanceModule.address, navIssuanceModule.address]
      );
      const managerIssuanceHook = await getRandomAddress();
      const managerRedemptionHook = await getRandomAddress();
      const reserveAssets = [setup.usdc.address, setup.weth.address];
      const managerFeeRecipient = feeRecipient.address;
      // Set manager issue fee to 0.1% and redeem to 0.2%
      const managerFees = [ether(0.001), ether(0.002)];
      // Set max managerFee to 2%
      const maxManagerFee = ether(0.02);
      // Set premium to 1%
      const premiumPercentage = ether(0.01);
      // Set max premium to 10%
      const maxPremiumPercentage = ether(0.1);
      // Set min SetToken supply to 1 unit
      const minSetTokenSupply = ether(1);

      const navIssuanceSettings = {
        managerIssuanceHook,
        managerRedemptionHook,
        reserveAssets,
        feeRecipient: managerFeeRecipient,
        managerFees,
        maxManagerFee,
        premiumPercentage,
        maxPremiumPercentage,
        minSetTokenSupply,
      } as NAVIssuanceSettings;

      await navIssuanceModule.initialize(setToken.address, navIssuanceSettings);
      // Approve tokens to the controller
      await setup.weth.approve(setup.controller.address, ether(100));
      await setup.usdc.approve(setup.controller.address, usdc(1000000));
      await setup.wbtc.approve(setup.controller.address, bitcoin(1000000));
      await setup.dai.approve(setup.controller.address, ether(1000000));

      // Seed with 10 supply
      await setup.issuanceModule.connect(owner.wallet).initialize(setToken.address, ADDRESS_ZERO);
      await setup.issuanceModule.connect(owner.wallet).issue(setToken.address, ether(10), owner.address);

      const protocolDirectFee = ether(.02);
      await setup.controller.addFee(navIssuanceModule.address, THREE, protocolDirectFee);

      const protocolManagerFee = ether(.3);
      await setup.controller.addFee(navIssuanceModule.address, ONE, protocolManagerFee);

      subjectSetToken = setToken.address;
      subjectReserveAsset = setup.usdc.address;
      subjectSetTokenQuantity = ether(1);
    });

    async function subject(): Promise<any> {
      return navIssuanceModule.isRedeemValid(subjectSetToken, subjectReserveAsset, subjectSetTokenQuantity);
    }

    it("should return true", async () => {
      const returnedValue = await subject();
      expect(returnedValue).to.eq(true);
    });

    describe("when total supply is less than min required for NAV issuance", async () => {
      beforeEach(async () => {
        // Redeem below required
        await setup.issuanceModule.connect(owner.wallet).redeem(setToken.address, ether(9), owner.address);
        subjectSetTokenQuantity = ether(0.01);
      });

      it("returns false", async () => {
        const returnedValue = await subject();
        expect(returnedValue).to.eq(false);
      });
    });

    describe("when there isn't sufficient reserve asset for withdraw", async () => {
      beforeEach(async () => {
        // Add self as module and update the position state
        await setup.controller.addModule(owner.address);
        setToken = setToken.connect(owner.wallet);
        await setToken.addModule(owner.address);
        await setToken.initializeModule();

        // Remove USDC position
        await setToken.editDefaultPositionUnit(setup.usdc.address, ZERO);

        subjectSetTokenQuantity = ether(1);
      });

      it("returns false", async () => {
        const returnedValue = await subject();
        expect(returnedValue).to.eq(false);
      });
    });

    describe("when the redeem quantity is 0", async () => {
      beforeEach(async () => {
        subjectSetTokenQuantity = ZERO;
      });

      it("returns false", async () => {
        const returnedValue = await subject();
        expect(returnedValue).to.eq(false);
      });
    });

    describe("when the reserve asset is not valid", async () => {
      beforeEach(async () => {
        await setup.wbtc.approve(setup.controller.address, bitcoin(1000000));
        subjectReserveAsset = setup.wbtc.address;
      });

      it("returns false", async () => {
        const returnedValue = await subject();
        expect(returnedValue).to.eq(false);
      });
    });
  });

  describe("#issue", async () => {
    let setToken: SetToken;

    let subjectSetToken: Address;
    let subjectReserveAsset: Address;
    let subjectReserveQuantity: BigNumber;
    let subjectMinSetTokenReceived: BigNumber;
    let subjectTo: Account;
    let subjectCaller: Account;

    let navIssuanceSettings: NAVIssuanceSettings;
    let managerIssuanceHook: Address;
    let managerFees: BigNumber[];
    let premiumPercentage: BigNumber;
    let units: BigNumber[];
    let issueQuantity: BigNumber;

    context("when there are 4 components and reserve asset is USDC", async () => {
      beforeEach(async () => {
        // Valued at 2000 USDC
        units = [ether(1), usdc(270), bitcoin(1).div(10), ether(600)];
        setToken = await setup.createSetToken(
          [setup.weth.address, setup.usdc.address, setup.wbtc.address, setup.dai.address],
          units, // Set is valued at 2000 USDC
          [setup.issuanceModule.address, navIssuanceModule.address]
        );
        const managerRedemptionHook = await getRandomAddress();
        const reserveAssets = [setup.usdc.address, setup.weth.address];
        const managerFeeRecipient = feeRecipient.address;
        // Set max managerFee to 20%
        const maxManagerFee = ether(0.2);
        // Set max premium to 10%
        const maxPremiumPercentage = ether(0.1);
        // Set min SetToken supply required
        const minSetTokenSupply = ether(1);

        navIssuanceSettings = {
          managerIssuanceHook,
          managerRedemptionHook,
          reserveAssets,
          feeRecipient: managerFeeRecipient,
          managerFees,
          maxManagerFee,
          premiumPercentage,
          maxPremiumPercentage,
          minSetTokenSupply,
        } as NAVIssuanceSettings;

        await navIssuanceModule.initialize(setToken.address, navIssuanceSettings);
        // Approve tokens to the controller
        await setup.weth.approve(setup.controller.address, ether(100));
        await setup.usdc.approve(setup.controller.address, usdc(1000000));
        await setup.wbtc.approve(setup.controller.address, bitcoin(1000000));
        await setup.dai.approve(setup.controller.address, ether(1000000));

        // Seed with 2 supply
        await setup.issuanceModule.connect(owner.wallet).initialize(setToken.address, ADDRESS_ZERO);
        await setup.issuanceModule.connect(owner.wallet).issue(setToken.address, ether(2), owner.address);

        // Issue with 1k USDC
        issueQuantity = usdc(1000);

        await setup.usdc.approve(navIssuanceModule.address, issueQuantity);

        subjectSetToken = setToken.address;
        subjectReserveAsset = setup.usdc.address;
        subjectReserveQuantity = issueQuantity;
        subjectMinSetTokenReceived = ether(0);
        subjectTo = recipient;
        subjectCaller = owner;
      });

      context("when there are no fees and no issuance hooks", async () => {
        before(async () => {
          managerIssuanceHook = ADDRESS_ZERO;
          // Set fees to 0
          managerFees = [ether(0), ether(0)];
          // Set premium percentage to 50 bps
          premiumPercentage = ether(0.005);
        });

        async function subject(): Promise<any> {
          return navIssuanceModule.connect(subjectCaller.wallet).issue(
            subjectSetToken,
            subjectReserveAsset,
            subjectReserveQuantity,
            subjectMinSetTokenReceived,
            subjectTo.address
          );
        }

        it("should issue the Set to the recipient", async () => {
          const expectedSetTokenIssueQuantity = await getExpectedSetTokenIssueQuantity(
            setToken,
            setup.setValuer,
            subjectReserveAsset,
            usdc(1), // USDC base units 10^6
            subjectReserveQuantity,
            managerFees[0],
            ZERO, // Protocol direct fee
            premiumPercentage
          );
          await subject();

          const issuedBalance = await setToken.balanceOf(recipient.address);
          expect(issuedBalance).to.eq(expectedSetTokenIssueQuantity);
        });

        it("should have deposited the reserve asset into the SetToken", async () => {
          const preIssueUSDCBalance = await setup.usdc.balanceOf(setToken.address);
          await subject();
          const postIssueUSDCBalance = await setup.usdc.balanceOf(setToken.address);
          const expectedUSDCBalance = preIssueUSDCBalance.add(issueQuantity);
          expect(postIssueUSDCBalance).to.eq(expectedUSDCBalance);
        });

        it("should have updated the reserve asset position correctly", async () => {
          const previousSetTokenSupply = await setToken.totalSupply();
          await subject();
          const currentSetTokenSupply = await setToken.totalSupply();
          const defaultPositionUnit = await setToken.getDefaultPositionRealUnit(subjectReserveAsset);

          // (Previous supply * previous units + current units) / current supply
          const newPositionMultiplier = await setToken.positionMultiplier();
          const expectedPositionUnit = getExpectedIssuePositionUnit(
            units[1],
            issueQuantity,
            previousSetTokenSupply,
            currentSetTokenSupply,
            newPositionMultiplier,
            managerFees[0],
            ZERO // Protocol fee percentage
          );

          expect(defaultPositionUnit).to.eq(expectedPositionUnit);
        });

        it("should have updated the position multiplier correctly", async () => {
          const previousSetTokenSupply = await setToken.totalSupply();
          const preIssuePositionMultiplier = await setToken.positionMultiplier();
          await subject();
          const currentSetTokenSupply = await setToken.totalSupply();
          const postIssuePositionMultiplier = await setToken.positionMultiplier();

          const expectedPositionMultiplier = getExpectedIssuePositionMultiplier(
            preIssuePositionMultiplier,
            previousSetTokenSupply,
            currentSetTokenSupply
          );
          expect(postIssuePositionMultiplier).to.eq(expectedPositionMultiplier);
        });

        it("should emit the SetTokenNAVIssued event", async () => {
          const expectedSetTokenIssued = await navIssuanceModule.getExpectedSetTokenIssueQuantity(
            subjectSetToken,
            subjectReserveAsset,
            subjectReserveQuantity
          );
          await expect(subject()).to.emit(navIssuanceModule, "SetTokenNAVIssued").withArgs(
            subjectSetToken,
            subjectCaller.address,
            subjectTo.address,
            subjectReserveAsset,
            ADDRESS_ZERO,
            expectedSetTokenIssued,
            ZERO,
            ZERO
          );
        });

        it("should reconcile balances", async () => {
          await reconcileBalances(setToken, subject, owner);
        });

        describe("when the issue quantity is extremely small", async () => {
          beforeEach(async () => {
            subjectReserveQuantity = ONE;
          });

          it("should issue the Set to the recipient", async () => {
            const expectedSetTokenIssueQuantity = await getExpectedSetTokenIssueQuantity(
              setToken,
              setup.setValuer,
              subjectReserveAsset,
              usdc(1), // USDC base units 10^6
              subjectReserveQuantity,
              managerFees[0],
              ZERO, // Protocol direct fee
              premiumPercentage
            );
            await subject();

            const issuedBalance = await setToken.balanceOf(recipient.address);

            expect(issuedBalance).to.eq(expectedSetTokenIssueQuantity);
          });

          it("should have deposited the reserve asset into the SetToken", async () => {
            const preIssueUSDCBalance = await setup.usdc.balanceOf(setToken.address);
            await subject();
            const postIssueUSDCBalance = await setup.usdc.balanceOf(setToken.address);
            const expectedUSDCBalance = preIssueUSDCBalance.add(subjectReserveQuantity);

            expect(postIssueUSDCBalance).to.eq(expectedUSDCBalance);
          });

          it("should have updated the reserve asset position correctly", async () => {
            const previousSetTokenSupply = await setToken.totalSupply();
            await subject();
            const currentSetTokenSupply = await setToken.totalSupply();
            const usdcPositionUnit = await setToken.getDefaultPositionRealUnit(subjectReserveAsset);

            // (Previous supply * previous units + current units) / current supply
            const newPositionMultiplier = await setToken.positionMultiplier();
            const expectedPositionUnit = getExpectedIssuePositionUnit(
              units[1],
              subjectReserveQuantity,
              previousSetTokenSupply,
              currentSetTokenSupply,
              newPositionMultiplier,
              managerFees[0],
              ZERO // Protocol fee percentage
            );

            expect(usdcPositionUnit).to.eq(expectedPositionUnit);
          });

          it("should have updated the position multiplier correctly", async () => {
            const previousSetTokenSupply = await setToken.totalSupply();
            const preIssuePositionMultiplier = await setToken.positionMultiplier();
            await subject();
            const currentSetTokenSupply = await setToken.totalSupply();
            const postIssuePositionMultiplier = await setToken.positionMultiplier();

            const expectedPositionMultiplier = getExpectedIssuePositionMultiplier(
              preIssuePositionMultiplier,
              previousSetTokenSupply,
              currentSetTokenSupply
            );

            expect(postIssuePositionMultiplier).to.eq(expectedPositionMultiplier);
          });

          it("should reconcile balances", async () => {
            await reconcileBalances(setToken, subject, owner);
          });
        });

        describe("when a SetToken position is not in default state", async () => {
          beforeEach(async () => {
            // Add self as module and update the position state
            await setup.controller.addModule(owner.address);
            setToken = setToken.connect(owner.wallet);
            await setToken.addModule(owner.address);
            await setToken.initializeModule();

            await setToken.addExternalPositionModule(setup.usdc.address, ADDRESS_ZERO);

            // Move default USDC to external position
            await setToken.editDefaultPositionUnit(setup.usdc.address, ZERO);
            await setToken.editExternalPositionUnit(setup.usdc.address, ADDRESS_ZERO, units[1]);
          });

          it("should have updated the reserve asset position correctly", async () => {
            const previousSetTokenSupply = await setToken.totalSupply();
            await subject();
            const currentSetTokenSupply = await setToken.totalSupply();
            const defaultUnit = await setToken.getDefaultPositionRealUnit(subjectReserveAsset);

            // (Previous supply * previous units + current units) / current supply
            const newPositionMultiplier = await setToken.positionMultiplier();
            const expectedPositionUnit = getExpectedIssuePositionUnit(
              ZERO, // Previous units are 0
              subjectReserveQuantity,
              previousSetTokenSupply,
              currentSetTokenSupply,
              newPositionMultiplier,
              managerFees[0],
              ZERO // Protocol fee percentage
            );

            expect(defaultUnit).to.eq(expectedPositionUnit);
          });

          it("should have updated the position multiplier correctly", async () => {
            const previousSetTokenSupply = await setToken.totalSupply();
            const preIssuePositionMultiplier = await setToken.positionMultiplier();
            await subject();
            const currentSetTokenSupply = await setToken.totalSupply();
            const postIssuePositionMultiplier = await setToken.positionMultiplier();

            const expectedPositionMultiplier = getExpectedIssuePositionMultiplier(
              preIssuePositionMultiplier,
              previousSetTokenSupply,
              currentSetTokenSupply
            );
            expect(postIssuePositionMultiplier).to.eq(expectedPositionMultiplier);
          });

          it("should reconcile balances", async () => {
            await reconcileBalances(setToken, subject, owner);
          });
        });

        describe("when total supply is less than min required for NAV issuance", async () => {
          beforeEach(async () => {
            // Redeem below required
            await setup.issuanceModule.connect(owner.wallet).redeem(setToken.address, ether(1.5), owner.address);
          });

          it("should revert", async () => {
            await expect(subject()).to.be.revertedWith("Supply must be greater than minimum to enable issuance");
          });
        });

        describe("when the issue quantity is 0", async () => {
          beforeEach(async () => {
            subjectReserveQuantity = ZERO;
          });

          it("should revert", async () => {
            await expect(subject()).to.be.revertedWith("Quantity must be > 0");
          });
        });

        describe("when the reserve asset is not valid", async () => {
          beforeEach(async () => {
            await setup.wbtc.approve(setup.controller.address, bitcoin(1000000));
            subjectReserveAsset = setup.wbtc.address;
          });

          it("should revert", async () => {
            await expect(subject()).to.be.revertedWith("Must be valid reserve asset");
          });
        });

        describe("when SetToken received is less than min required", async () => {
          beforeEach(async () => {
            subjectMinSetTokenReceived = ether(100);
          });

          it("should revert", async () => {
            await expect(subject()).to.be.revertedWith("Must be greater than min SetToken");
          });
        });

        describe("when the SetToken is not enabled on the controller", async () => {
          beforeEach(async () => {
            const nonEnabledSetToken = await setup.createNonControllerEnabledSetToken(
              [setup.weth.address],
              [ether(1)],
              [navIssuanceModule.address]
            );

            subjectSetToken = nonEnabledSetToken.address;
          });

          it("should revert", async () => {
            await expect(subject()).to.be.revertedWith("Must be a valid and initialized SetToken");
          });
        });
      });

      context("when there are fees enabled and no issuance hooks", async () => {
        let protocolDirectFee: BigNumber;
        let protocolManagerFee: BigNumber;

        before(async () => {
          managerIssuanceHook = ADDRESS_ZERO;
          managerFees = [ether(0.1), ether(0.1)];
          premiumPercentage = ether(0.005);
        });

        beforeEach(async () => {
          protocolDirectFee = ether(.02);
          await setup.controller.addFee(navIssuanceModule.address, TWO, protocolDirectFee);

          protocolManagerFee = ether(.3);
          await setup.controller.addFee(navIssuanceModule.address, ZERO, protocolManagerFee);
        });

        async function subject(): Promise<any> {
          return navIssuanceModule.connect(subjectCaller.wallet).issue(
            subjectSetToken,
            subjectReserveAsset,
            subjectReserveQuantity,
            subjectMinSetTokenReceived,
            subjectTo.address
          );
        }

        it("should issue the Set to the recipient", async () => {
          const expectedSetTokenIssueQuantity = await getExpectedSetTokenIssueQuantity(
            setToken,
            setup.setValuer,
            subjectReserveAsset,
            usdc(1), // USDC base units 10^6
            subjectReserveQuantity,
            managerFees[0],
            protocolDirectFee, // Protocol direct fee
            premiumPercentage
          );
          await subject();

          const issuedBalance = await setToken.balanceOf(recipient.address);
          expect(issuedBalance).to.eq(expectedSetTokenIssueQuantity);
        });

        it("should have deposited the reserve asset into the SetToken", async () => {
          const preIssueUSDCBalance = await setup.usdc.balanceOf(setToken.address);
          await subject();
          const postIssueUSDCBalance = await setup.usdc.balanceOf(setToken.address);

          const postFeeQuantity = getExpectedPostFeeQuantity(
            issueQuantity,
            managerFees[0],
            protocolDirectFee
          );
          const expectedUSDCBalance = preIssueUSDCBalance.add(postFeeQuantity);
          expect(postIssueUSDCBalance).to.eq(expectedUSDCBalance);
        });

        it("should have updated the reserve asset position correctly", async () => {
          const previousSetTokenSupply = await setToken.totalSupply();
          await subject();
          const currentSetTokenSupply = await setToken.totalSupply();
          const usdcPositionUnit = await setToken.getDefaultPositionRealUnit(subjectReserveAsset);

          // (Previous supply * previous units + current units) / current supply
          const newPositionMultiplier = await setToken.positionMultiplier();
          const expectedPositionUnit = getExpectedIssuePositionUnit(
            units[1],
            issueQuantity,
            previousSetTokenSupply,
            currentSetTokenSupply,
            newPositionMultiplier,
            managerFees[0],
            protocolDirectFee
          );

          expect(usdcPositionUnit).to.eq(expectedPositionUnit);
        });

        it("should have updated the position multiplier correctly", async () => {
          const previousSetTokenSupply = await setToken.totalSupply();
          const preIssuePositionMultiplier = await setToken.positionMultiplier();
          await subject();
          const currentSetTokenSupply = await setToken.totalSupply();
          const postIssuePositionMultiplier = await setToken.positionMultiplier();

          const expectedPositionMultiplier = getExpectedIssuePositionMultiplier(
            preIssuePositionMultiplier,
            previousSetTokenSupply,
            currentSetTokenSupply
          );
          expect(postIssuePositionMultiplier).to.eq(expectedPositionMultiplier);
        });

        it("should reconcile balances", async () => {
          await reconcileBalances(setToken, subject, owner);
        });
      });

      context("when there are fees, premiums and an issuance hooks", async () => {
        let issuanceHookContract: NavIssuanceHookMock;

        before(async () => {
          issuanceHookContract = await deployer.mocks.deployNavIssuanceHookMock();

          managerIssuanceHook = issuanceHookContract.address;
        });

        async function subject(): Promise<any> {
          return navIssuanceModule.issue(
            subjectSetToken,
            subjectReserveAsset,
            subjectReserveQuantity,
            subjectMinSetTokenReceived,
            subjectTo.address
          );
        }

        it("should properly call the pre-issue hooks", async () => {
          await subject();
          const retrievedSetToken = await issuanceHookContract.retrievedSetToken();
          const retrievedReserveAsset = await issuanceHookContract.retrievedReserveAsset();
          const retrievedReserveAssetQuantity = await issuanceHookContract.retrievedReserveAssetQuantity();
          const retrievedSender = await issuanceHookContract.retrievedSender();
          const retrievedTo = await issuanceHookContract.retrievedTo();

          expect(retrievedSetToken).to.eq(subjectSetToken);
          expect(retrievedReserveAsset).to.eq(subjectReserveAsset);
          expect(retrievedReserveAssetQuantity).to.eq(subjectReserveQuantity);
          expect(retrievedSender).to.eq(owner.address);
          expect(retrievedTo).to.eq(subjectTo.address);
        });
      });
    });
  });

  describe("#issueWithEther", async () => {
    let setToken: SetToken;

    let subjectSetToken: Address;
    let subjectMinSetTokenReceived: BigNumber;
    let subjectTo: Account;
    let subjectCaller: Account;
    let subjectValue: BigNumber;

    let navIssuanceSettings: NAVIssuanceSettings;
    let managerIssuanceHook: Address;
    let managerFees: BigNumber[];
    let premiumPercentage: BigNumber;
    let units: BigNumber[];
    let issueQuantity: BigNumber;

    context("when there are 4 components and reserve asset is ETH", async () => {
      beforeEach(async () => {
        // Valued at 2000 USDC
        units = [ether(1), usdc(270), bitcoin(1).div(10), ether(600)];
        setToken = await setup.createSetToken(
          [setup.weth.address, setup.usdc.address, setup.wbtc.address, setup.dai.address],
          units, // Set is valued at 2000 USDC
          [setup.issuanceModule.address, navIssuanceModule.address]
        );
        const managerRedemptionHook = await getRandomAddress();
        const reserveAssets = [setup.usdc.address, setup.weth.address];
        const managerFeeRecipient = feeRecipient.address;
        // Set max managerFee to 20%
        const maxManagerFee = ether(0.2);
        // Set max premium to 10%
        const maxPremiumPercentage = ether(0.1);
        // Set min SetToken supply required
        const minSetTokenSupply = ether(1);

        navIssuanceSettings = {
          managerIssuanceHook,
          managerRedemptionHook,
          reserveAssets,
          feeRecipient: managerFeeRecipient,
          managerFees,
          maxManagerFee,
          premiumPercentage,
          maxPremiumPercentage,
          minSetTokenSupply,
        } as NAVIssuanceSettings;

        await navIssuanceModule.initialize(setToken.address, navIssuanceSettings);
        // Approve tokens to the controller
        await setup.weth.approve(setup.controller.address, ether(100));
        await setup.usdc.approve(setup.controller.address, usdc(1000000));
        await setup.wbtc.approve(setup.controller.address, bitcoin(1000000));
        await setup.dai.approve(setup.controller.address, ether(1000000));

        // Seed with 2 supply
        await setup.issuanceModule.connect(owner.wallet).initialize(setToken.address, ADDRESS_ZERO);
        await setup.issuanceModule.connect(owner.wallet).issue(setToken.address, ether(2), owner.address);

        // Issue with 1 ETH
        issueQuantity = ether(0.1);

        subjectSetToken = setToken.address;
        subjectMinSetTokenReceived = ether(0);
        subjectTo = recipient;
        subjectValue = issueQuantity;
        subjectCaller = owner;
      });

      context("when there are no fees and no issuance hooks", async () => {
        before(async () => {
          managerIssuanceHook = ADDRESS_ZERO;
          // Set fees to 0
          managerFees = [ether(0), ether(0)];
          premiumPercentage = ether(0.005);
        });

        async function subject(): Promise<any> {
          return navIssuanceModule.connect(subjectCaller.wallet).issueWithEther(
            subjectSetToken,
            subjectMinSetTokenReceived,
            subjectTo.address,
            {
              value: subjectValue,
            }
          );
        }

        it("should issue the Set to the recipient", async () => {
          const expectedSetTokenIssueQuantity = await getExpectedSetTokenIssueQuantity(
            setToken,
            setup.setValuer,
            setup.weth.address,
            ether(1), // ETH base units 10^18
            subjectValue,
            managerFees[0],
            ZERO, // Protocol direct fee
            premiumPercentage
          );
          await subject();

          const issuedBalance = await setToken.balanceOf(recipient.address);
          expect(issuedBalance).to.eq(expectedSetTokenIssueQuantity);
        });

        it("should have deposited WETH into the SetToken", async () => {
          const preIssueWETHBalance = await setup.weth.balanceOf(setToken.address);
          await subject();
          const postIssueWETHBalance = await setup.weth.balanceOf(setToken.address);
          const expectedWETHBalance = preIssueWETHBalance.add(issueQuantity);
          expect(postIssueWETHBalance).to.eq(expectedWETHBalance);
        });

        it("should have updated the reserve asset position correctly", async () => {
          const previousSetTokenSupply = await setToken.totalSupply();
          await subject();
          const currentSetTokenSupply = await setToken.totalSupply();
          const defaultPositionUnit = await setToken.getDefaultPositionRealUnit(setup.weth.address);

          const newPositionMultiplier = await setToken.positionMultiplier();
          const expectedPositionUnit = getExpectedIssuePositionUnit(
            units[0],
            issueQuantity,
            previousSetTokenSupply,
            currentSetTokenSupply,
            newPositionMultiplier,
            managerFees[0],
            ZERO // Protocol fee percentage
          );

          expect(defaultPositionUnit).to.eq(expectedPositionUnit);
        });

        it("should have updated the position multiplier correctly", async () => {
          const previousSetTokenSupply = await setToken.totalSupply();
          const preIssuePositionMultiplier = await setToken.positionMultiplier();
          await subject();
          const currentSetTokenSupply = await setToken.totalSupply();
          const postIssuePositionMultiplier = await setToken.positionMultiplier();

          const expectedPositionMultiplier = getExpectedIssuePositionMultiplier(
            preIssuePositionMultiplier,
            previousSetTokenSupply,
            currentSetTokenSupply
          );
          expect(postIssuePositionMultiplier).to.eq(expectedPositionMultiplier);
        });

        it("should emit the SetTokenNAVIssued event", async () => {
          const expectedSetTokenIssued = await navIssuanceModule.getExpectedSetTokenIssueQuantity(
            subjectSetToken,
            setup.weth.address,
            subjectValue
          );
          await expect(subject()).to.emit(navIssuanceModule, "SetTokenNAVIssued").withArgs(
            subjectSetToken,
            subjectCaller.address,
            subjectTo.address,
            setup.weth.address,
            ADDRESS_ZERO,
            expectedSetTokenIssued,
            ZERO,
            ZERO
          );
        });

        it("should reconcile balances", async () => {
          await reconcileBalances(setToken, subject, owner);
        });

        describe("when a SetToken position is not in default state", async () => {
          beforeEach(async () => {
            // Add self as module and update the position state
            await setup.controller.addModule(owner.address);
            setToken = setToken.connect(owner.wallet);
            await setToken.addModule(owner.address);
            await setToken.initializeModule();

            await setToken.addExternalPositionModule(setup.weth.address, ADDRESS_ZERO);

            // Move default WETH to external position
            await setToken.editDefaultPositionUnit(setup.weth.address, ZERO);
            await setToken.editExternalPositionUnit(setup.weth.address, ADDRESS_ZERO, units[0]);
          });

          it("should have updated the reserve asset position correctly", async () => {
            const previousSetTokenSupply = await setToken.totalSupply();
            await subject();
            const currentSetTokenSupply = await setToken.totalSupply();
            const defaultUnit = await setToken.getDefaultPositionRealUnit(setup.weth.address);

            // (Previous supply * previous units + current units) / current supply
            const newPositionMultiplier = await setToken.positionMultiplier();
            const expectedPositionUnit = getExpectedIssuePositionUnit(
              ZERO, // Previous units are 0
              subjectValue,
              previousSetTokenSupply,
              currentSetTokenSupply,
              newPositionMultiplier,
              managerFees[0],
              ZERO // Protocol fee percentage
            );

            expect(defaultUnit).to.eq(expectedPositionUnit);
          });

          it("should have updated the position multiplier correctly", async () => {
            const previousSetTokenSupply = await setToken.totalSupply();
            const preIssuePositionMultiplier = await setToken.positionMultiplier();
            await subject();
            const currentSetTokenSupply = await setToken.totalSupply();
            const postIssuePositionMultiplier = await setToken.positionMultiplier();

            const expectedPositionMultiplier = getExpectedIssuePositionMultiplier(
              preIssuePositionMultiplier,
              previousSetTokenSupply,
              currentSetTokenSupply
            );
            expect(postIssuePositionMultiplier).to.eq(expectedPositionMultiplier);
          });

          it("should reconcile balances", async () => {
            await reconcileBalances(setToken, subject, owner);
          });
        });

        describe("when total supply is less than min required for NAV issuance", async () => {
          beforeEach(async () => {
            // Redeem below required
            await setup.issuanceModule.connect(owner.wallet).redeem(setToken.address, ether(1.5), owner.address);
          });

          it("should revert", async () => {
            await expect(subject()).to.be.revertedWith("Supply must be greater than minimum to enable issuance");
          });
        });

        describe("when the value is 0", async () => {
          beforeEach(async () => {
            subjectValue = ZERO;
          });

          it("should revert", async () => {
            await expect(subject()).to.be.revertedWith("Quantity must be > 0");
          });
        });

        describe("when SetToken received is less than minimum", async () => {
          beforeEach(async () => {
            subjectMinSetTokenReceived = ether(100);
          });

          it("should revert", async () => {
            await expect(subject()).to.be.revertedWith("Must be greater than min SetToken");
          });
        });

        describe("when the SetToken is not enabled on the controller", async () => {
          beforeEach(async () => {
            const nonEnabledSetToken = await setup.createNonControllerEnabledSetToken(
              [setup.weth.address],
              [ether(1)],
              [navIssuanceModule.address]
            );

            subjectSetToken = nonEnabledSetToken.address;
          });

          it("should revert", async () => {
            await expect(subject()).to.be.revertedWith("Must be a valid and initialized SetToken");
          });
        });
      });

      context("when there are fees enabled and no issuance hooks", async () => {
        let protocolDirectFee: BigNumber;
        let protocolManagerFee: BigNumber;

        before(async () => {
          managerIssuanceHook = ADDRESS_ZERO;
          managerFees = [ether(0.1), ether(0.1)];
          premiumPercentage = ether(0.1);
        });

        beforeEach(async () => {
          protocolDirectFee = ether(.02);
          await setup.controller.addFee(navIssuanceModule.address, TWO, protocolDirectFee);

          protocolManagerFee = ether(.3);
          await setup.controller.addFee(navIssuanceModule.address, ZERO, protocolManagerFee);
        });

        async function subject(): Promise<any> {
          return navIssuanceModule.connect(subjectCaller.wallet).issueWithEther(
            subjectSetToken,
            subjectMinSetTokenReceived,
            subjectTo.address,
            {
              value: subjectValue,
            }
          );
        }

        it("should issue the Set to the recipient", async () => {
          const expectedSetTokenIssueQuantity = await getExpectedSetTokenIssueQuantity(
            setToken,
            setup.setValuer,
            setup.weth.address,
            ether(1), // ETH base units 10^18
            subjectValue,
            managerFees[0],
            protocolDirectFee, // Protocol direct fee
            premiumPercentage
          );
          await subject();

          const issuedBalance = await setToken.balanceOf(recipient.address);
          expect(issuedBalance).to.eq(expectedSetTokenIssueQuantity);
        });

        it("should have deposited the reserve asset into the SetToken", async () => {
          const preIssueWETHBalance = await setup.weth.balanceOf(setToken.address);
          await subject();
          const postIssueWETHBalance = await setup.weth.balanceOf(setToken.address);

          const postFeeQuantity = getExpectedPostFeeQuantity(
            issueQuantity,
            managerFees[0],
            protocolDirectFee
          );
          const expectedWETHBalance = preIssueWETHBalance.add(postFeeQuantity);
          expect(postIssueWETHBalance).to.eq(expectedWETHBalance);
        });

        it("should have updated the reserve asset position correctly", async () => {
          const previousSetTokenSupply = await setToken.totalSupply();
          await subject();
          const currentSetTokenSupply = await setToken.totalSupply();
          const wethPositionUnit = await setToken.getDefaultPositionRealUnit(setup.weth.address);

          // (Previous supply * previous units + current units) / current supply
          const newPositionMultiplier = await setToken.positionMultiplier();
          const expectedPositionUnit = getExpectedIssuePositionUnit(
            units[0],
            issueQuantity,
            previousSetTokenSupply,
            currentSetTokenSupply,
            newPositionMultiplier,
            managerFees[0],
            protocolDirectFee
          );

          expect(wethPositionUnit).to.eq(expectedPositionUnit);
        });

        it("should have updated the position multiplier correctly", async () => {
          const previousSetTokenSupply = await setToken.totalSupply();
          const preIssuePositionMultiplier = await setToken.positionMultiplier();
          await subject();
          const currentSetTokenSupply = await setToken.totalSupply();
          const postIssuePositionMultiplier = await setToken.positionMultiplier();

          const expectedPositionMultiplier = getExpectedIssuePositionMultiplier(
            preIssuePositionMultiplier,
            previousSetTokenSupply,
            currentSetTokenSupply
          );
          expect(postIssuePositionMultiplier).to.eq(expectedPositionMultiplier);
        });

        it("should reconcile balances", async () => {
          await reconcileBalances(setToken, subject, owner);
        });
      });
    });
  });

  describe("#redeem", async () => {
    let setToken: SetToken;

    let subjectSetToken: Address;
    let subjectReserveAsset: Address;
    let subjectSetTokenQuantity: BigNumber;
    let subjectMinReserveQuantityReceived: BigNumber;
    let subjectTo: Account;
    let subjectCaller: Account;

    let navIssuanceSettings: NAVIssuanceSettings;
    let managerRedemptionHook: Address;
    let managerFees: BigNumber[];
    let premiumPercentage: BigNumber;
    let units: BigNumber[];
    let redeemQuantity: BigNumber;

    context("when there are 4 components and reserve asset is USDC", async () => {
      beforeEach(async () => {
        // Valued at 2000 USDC
        units = [ether(1), usdc(570), bitcoin(1).div(10), ether(300)];
        setToken = await setup.createSetToken(
          [setup.weth.address, setup.usdc.address, setup.wbtc.address, setup.dai.address],
          units, // Set is valued at 2000 USDC
          [setup.issuanceModule.address, navIssuanceModule.address]
        );
        const managerIssuanceHook = await getRandomAddress();
        const reserveAssets = [setup.usdc.address, setup.weth.address];
        const managerFeeRecipient = feeRecipient.address;
        // Set max managerFee to 20%
        const maxManagerFee = ether(0.2);
        // Set max premium to 10%
        const maxPremiumPercentage = ether(0.1);
        // Set min SetToken supply required
        const minSetTokenSupply = ether(1);

        navIssuanceSettings = {
          managerIssuanceHook,
          managerRedemptionHook,
          reserveAssets,
          feeRecipient: managerFeeRecipient,
          managerFees,
          maxManagerFee,
          premiumPercentage,
          maxPremiumPercentage,
          minSetTokenSupply,
        } as NAVIssuanceSettings;

        await navIssuanceModule.initialize(setToken.address, navIssuanceSettings);
        // Approve tokens to the controller
        await setup.weth.approve(setup.controller.address, ether(100));
        await setup.usdc.approve(setup.controller.address, usdc(1000000));
        await setup.wbtc.approve(setup.controller.address, bitcoin(1000000));
        await setup.dai.approve(setup.controller.address, ether(1000000));

        // Seed with 10 supply
        await setup.issuanceModule.connect(owner.wallet).initialize(setToken.address, ADDRESS_ZERO);
        await setup.issuanceModule.connect(owner.wallet).issue(setToken.address, ether(10), owner.address);

        // Redeem 1 SetToken
        redeemQuantity = ether(2.8);

        subjectSetToken = setToken.address;
        subjectReserveAsset = setup.usdc.address;
        subjectSetTokenQuantity = redeemQuantity;
        subjectMinReserveQuantityReceived = ether(0);
        subjectTo = recipient;
        subjectCaller = owner;
      });

      context("when there are no fees and no redemption hooks", async () => {
        before(async () => {
          managerRedemptionHook = ADDRESS_ZERO;
          // Set fees to 0
          managerFees = [ether(0), ether(0)];
          // Set premium percentage to 50 bps
          premiumPercentage = ether(0.005);
        });

        async function subject(): Promise<any> {
          return navIssuanceModule.connect(subjectCaller.wallet).redeem(
            subjectSetToken,
            subjectReserveAsset,
            subjectSetTokenQuantity,
            subjectMinReserveQuantityReceived,
            subjectTo.address
          );
        }

        it("should reduce the SetToken supply", async () => {
          const previousSupply = await setToken.totalSupply();
          const preRedeemBalance = await setToken.balanceOf(owner.address);
          await subject();
          const currentSupply = await setToken.totalSupply();
          const postRedeemBalance = await setToken.balanceOf(owner.address);

          expect(preRedeemBalance.sub(postRedeemBalance)).to.eq(previousSupply.sub(currentSupply));
        });

        it("should have redeemed the reserve asset to the recipient", async () => {
          const setTokenValuation = await setup.setValuer.calculateSetTokenValuation(
            subjectSetToken,
            subjectReserveAsset
          );
          await subject();
          const postIssueUSDCBalance = await setup.usdc.balanceOf(recipient.address);
          const expectedUSDCBalance = getExpectedReserveRedeemQuantity(
            subjectSetTokenQuantity,
            setTokenValuation,
            usdc(1), // USDC base units
            managerFees[1],
            ZERO, // Protocol fee percentage
            premiumPercentage
          );
          expect(postIssueUSDCBalance).to.eq(expectedUSDCBalance);
        });

        it("should have updated the reserve asset position correctly", async () => {
          const previousSetTokenSupply = await setToken.totalSupply();
          const setTokenValuation = await setup.setValuer.calculateSetTokenValuation(
            subjectSetToken,
            subjectReserveAsset
          );
          await subject();
          const currentSetTokenSupply = await setToken.totalSupply();
          const defaultPositionUnit = await setToken.getDefaultPositionRealUnit(subjectReserveAsset);

          // (Previous supply * previous units + current units) / current supply
          const newPositionMultiplier = await setToken.positionMultiplier();
          const expectedPositionUnit = getExpectedRedeemPositionUnit(
            units[1],
            redeemQuantity,
            setTokenValuation,
            usdc(1), // USDC base units
            previousSetTokenSupply,
            currentSetTokenSupply,
            newPositionMultiplier,
            managerFees[1],
            ZERO, // Protocol fee percentage
            premiumPercentage,
          );

          expect(defaultPositionUnit).to.eq(expectedPositionUnit);
        });

        it("should have updated the position multiplier correctly", async () => {
          const previousSetTokenSupply = await setToken.totalSupply();
          const preIssuePositionMultiplier = await setToken.positionMultiplier();
          await subject();
          const currentSetTokenSupply = await setToken.totalSupply();
          const postIssuePositionMultiplier = await setToken.positionMultiplier();

          const expectedPositionMultiplier = getExpectedRedeemPositionMultiplier(
            preIssuePositionMultiplier,
            previousSetTokenSupply,
            currentSetTokenSupply
          );
          expect(postIssuePositionMultiplier).to.eq(expectedPositionMultiplier);
        });

        it("should emit the SetTokenNAVRedeemed event", async () => {
          await expect(subject()).to.emit(navIssuanceModule, "SetTokenNAVRedeemed").withArgs(
            subjectSetToken,
            subjectCaller.address,
            subjectTo.address,
            subjectReserveAsset,
            ADDRESS_ZERO,
            subjectSetTokenQuantity,
            ZERO,
            ZERO
          );
        });

        it("should reconcile balances", async () => {
          await reconcileBalances(setToken, subject, owner);
        });

        describe("when the redeem quantity is extremely small", async () => {
          beforeEach(async () => {
            subjectSetTokenQuantity = ONE;
          });

          it("should reduce the SetToken supply", async () => {
            const previousSupply = await setToken.totalSupply();
            const preRedeemBalance = await setToken.balanceOf(owner.address);
            await subject();
            const currentSupply = await setToken.totalSupply();
            const postRedeemBalance = await setToken.balanceOf(owner.address);

            expect(preRedeemBalance.sub(postRedeemBalance)).to.eq(previousSupply.sub(currentSupply));
          });

          it("should have redeemed the reserve asset to the recipient", async () => {
            const setTokenValuation = await setup.setValuer.calculateSetTokenValuation(
              subjectSetToken,
              subjectReserveAsset
            );
            await subject();
            const postIssueUSDCBalance = await setup.usdc.balanceOf(recipient.address);
            const expectedUSDCBalance = getExpectedReserveRedeemQuantity(
              subjectSetTokenQuantity,
              setTokenValuation,
              usdc(1), // USDC base units
              managerFees[1],
              ZERO, // Protocol fee percentage
              premiumPercentage
            );
            expect(postIssueUSDCBalance).to.eq(expectedUSDCBalance);
          });

          it("should have updated the reserve asset position correctly", async () => {
            const previousSetTokenSupply = await setToken.totalSupply();
            const setTokenValuation = await setup.setValuer.calculateSetTokenValuation(
              subjectSetToken,
              subjectReserveAsset
            );
            await subject();
            const currentSetTokenSupply = await setToken.totalSupply();
            const defaultPositionUnit = await setToken.getDefaultPositionRealUnit(subjectReserveAsset);

            // (Previous supply * previous units + current units) / current supply
            const newPositionMultiplier = await setToken.positionMultiplier();
            const expectedPositionUnit = getExpectedRedeemPositionUnit(
              units[1],
              subjectSetTokenQuantity,
              setTokenValuation,
              usdc(1), // USDC base units
              previousSetTokenSupply,
              currentSetTokenSupply,
              newPositionMultiplier,
              managerFees[1],
              ZERO, // Protocol fee percentage
              premiumPercentage,
            );
            expect(defaultPositionUnit).to.eq(expectedPositionUnit);
          });

          it("should have updated the position multiplier correctly", async () => {
            const previousSetTokenSupply = await setToken.totalSupply();
            const preIssuePositionMultiplier = await setToken.positionMultiplier();
            await subject();
            const currentSetTokenSupply = await setToken.totalSupply();
            const postIssuePositionMultiplier = await setToken.positionMultiplier();

            const expectedPositionMultiplier = getExpectedRedeemPositionMultiplier(
              preIssuePositionMultiplier,
              previousSetTokenSupply,
              currentSetTokenSupply
            );
            expect(postIssuePositionMultiplier).to.eq(expectedPositionMultiplier);
          });

          it("should reconcile balances", async () => {
            await reconcileBalances(setToken, subject, owner);
          });
        });

        describe("when a SetToken position is not in default state", async () => {
          beforeEach(async () => {
            // Add self as module and update the position state
            await setup.controller.addModule(owner.address);
            setToken = setToken.connect(owner.wallet);
            await setToken.addModule(owner.address);
            await setToken.initializeModule();

            await setToken.addExternalPositionModule(setup.usdc.address, ADDRESS_ZERO);

            // Convert half of default position to external position
            await setToken.editDefaultPositionUnit(setup.usdc.address, units[1].div(2));
            await setToken.editExternalPositionUnit(setup.usdc.address, ADDRESS_ZERO, units[1].div(2));

            subjectSetTokenQuantity = ether(0.1);
          });

          it("should have updated the reserve asset position correctly", async () => {
            const previousSetTokenSupply = await setToken.totalSupply();
            const setTokenValuation = await setup.setValuer.calculateSetTokenValuation(
              subjectSetToken,
              subjectReserveAsset
            );
            await subject();
            const currentSetTokenSupply = await setToken.totalSupply();
            const defaultPositionUnit = await setToken.getDefaultPositionRealUnit(subjectReserveAsset);

            // (Previous supply * previous units + current units) / current supply
            const newPositionMultiplier = await setToken.positionMultiplier();
            const expectedPositionUnit = getExpectedRedeemPositionUnit(
              units[1].div(2),
              subjectSetTokenQuantity,
              setTokenValuation,
              usdc(1), // USDC base units
              previousSetTokenSupply,
              currentSetTokenSupply,
              newPositionMultiplier,
              managerFees[1],
              ZERO, // Protocol fee percentage
              premiumPercentage,
            );

            expect(defaultPositionUnit).to.eq(expectedPositionUnit);
          });

          it("should have updated the position multiplier correctly", async () => {
            const previousSetTokenSupply = await setToken.totalSupply();
            const preIssuePositionMultiplier = await setToken.positionMultiplier();
            await subject();
            const currentSetTokenSupply = await setToken.totalSupply();
            const postIssuePositionMultiplier = await setToken.positionMultiplier();

            const expectedPositionMultiplier = getExpectedRedeemPositionMultiplier(
              preIssuePositionMultiplier,
              previousSetTokenSupply,
              currentSetTokenSupply
            );
            expect(postIssuePositionMultiplier).to.eq(expectedPositionMultiplier);
          });

          it("should reconcile balances", async () => {
            await reconcileBalances(setToken, subject, owner);
          });
        });

        describe("when total supply is less than min required for NAV issuance", async () => {
          beforeEach(async () => {
            // Redeem below required
            await setup.issuanceModule.connect(owner.wallet).redeem(setToken.address, ether(9), owner.address);
            subjectSetTokenQuantity = ether(0.01);
          });

          it("should revert", async () => {
            await expect(subject()).to.be.revertedWith("Supply must be greater than minimum to enable redemption");
          });
        });

        describe("when there isn't sufficient reserve asset for withdraw", async () => {
          beforeEach(async () => {
            // Add self as module and update the position state
            await setup.controller.addModule(owner.address);
            setToken = setToken.connect(owner.wallet);
            await setToken.addModule(owner.address);
            await setToken.initializeModule();

            // Remove USDC position
            await setToken.editDefaultPositionUnit(setup.usdc.address, ZERO);

            subjectSetTokenQuantity = ether(1);
          });

          it("should revert", async () => {
            await expect(subject()).to.be.revertedWith("Must be greater than total available collateral");
          });
        });

        describe("when the redeem quantity is 0", async () => {
          beforeEach(async () => {
            subjectSetTokenQuantity = ZERO;
          });

          it("should revert", async () => {
            await expect(subject()).to.be.revertedWith("Quantity must be > 0");
          });
        });

        describe("when the reserve asset is not valid", async () => {
          beforeEach(async () => {
            await setup.wbtc.approve(setup.controller.address, bitcoin(1000000));
            subjectReserveAsset = setup.wbtc.address;
          });

          it("should revert", async () => {
            await expect(subject()).to.be.revertedWith("Must be valid reserve asset");
          });
        });

        describe("when reserve asset received is less than min required", async () => {
          beforeEach(async () => {
            subjectMinReserveQuantityReceived = ether(100);
          });

          it("should revert", async () => {
            await expect(subject()).to.be.revertedWith("Must be greater than min receive reserve quantity");
          });
        });

        describe("when the SetToken is not enabled on the controller", async () => {
          beforeEach(async () => {
            const nonEnabledSetToken = await setup.createNonControllerEnabledSetToken(
              [setup.weth.address],
              [ether(1)],
              [navIssuanceModule.address]
            );

            subjectSetToken = nonEnabledSetToken.address;
          });

          it("should revert", async () => {
            await expect(subject()).to.be.revertedWith("Must be a valid and initialized SetToken");
          });
        });
      });

      context("when there are fees enabled and no redemption hooks", async () => {
        let protocolDirectFee: BigNumber;
        let protocolManagerFee: BigNumber;

        before(async () => {
          managerRedemptionHook = ADDRESS_ZERO;
          managerFees = [ether(0.1), ether(0.1)];
          premiumPercentage = ether(0.005);
        });

        beforeEach(async () => {
          protocolDirectFee = ether(.02);
          await setup.controller.addFee(navIssuanceModule.address, THREE, protocolDirectFee);

          protocolManagerFee = ether(.3);
          await setup.controller.addFee(navIssuanceModule.address, ONE, protocolManagerFee);
        });

        async function subject(): Promise<any> {
          return navIssuanceModule.connect(subjectCaller.wallet).redeem(
            subjectSetToken,
            subjectReserveAsset,
            subjectSetTokenQuantity,
            subjectMinReserveQuantityReceived,
            subjectTo.address
          );
        }

        it("should reduce the SetToken supply", async () => {
          const previousSupply = await setToken.totalSupply();
          const preRedeemBalance = await setToken.balanceOf(owner.address);
          await subject();
          const currentSupply = await setToken.totalSupply();
          const postRedeemBalance = await setToken.balanceOf(owner.address);

          expect(preRedeemBalance.sub(postRedeemBalance)).to.eq(previousSupply.sub(currentSupply));
        });

        it("should have redeemed the reserve asset to the recipient", async () => {
          const setTokenValuation = await setup.setValuer.calculateSetTokenValuation(
            subjectSetToken,
            subjectReserveAsset
          );
          await subject();
          const postIssueUSDCBalance = await setup.usdc.balanceOf(recipient.address);
          const expectedUSDCBalance = getExpectedReserveRedeemQuantity(
            subjectSetTokenQuantity,
            setTokenValuation,
            usdc(1), // USDC base units
            managerFees[1],
            protocolDirectFee, // Protocol fee percentage
            premiumPercentage
          );
          expect(postIssueUSDCBalance).to.eq(expectedUSDCBalance);
        });

        it("should have updated the reserve asset position correctly", async () => {
          const previousSetTokenSupply = await setToken.totalSupply();
          const setTokenValuation = await setup.setValuer.calculateSetTokenValuation(
            subjectSetToken,
            subjectReserveAsset
          );
          await subject();
          const currentSetTokenSupply = await setToken.totalSupply();
          const defaultPositionUnit = await setToken.getDefaultPositionRealUnit(subjectReserveAsset);

          // (Previous supply * previous units + current units) / current supply
          const newPositionMultiplier = await setToken.positionMultiplier();
          const expectedPositionUnit = getExpectedRedeemPositionUnit(
            units[1],
            redeemQuantity,
            setTokenValuation,
            usdc(1), // USDC base units
            previousSetTokenSupply,
            currentSetTokenSupply,
            newPositionMultiplier,
            managerFees[1],
            protocolDirectFee, // Protocol fee percentage
            premiumPercentage,
          );

          expect(defaultPositionUnit).to.eq(expectedPositionUnit);
        });

        it("should have updated the position multiplier correctly", async () => {
          const previousSetTokenSupply = await setToken.totalSupply();
          const preIssuePositionMultiplier = await setToken.positionMultiplier();
          await subject();
          const currentSetTokenSupply = await setToken.totalSupply();
          const postIssuePositionMultiplier = await setToken.positionMultiplier();

          const expectedPositionMultiplier = getExpectedRedeemPositionMultiplier(
            preIssuePositionMultiplier,
            previousSetTokenSupply,
            currentSetTokenSupply
          );
          expect(postIssuePositionMultiplier).to.eq(expectedPositionMultiplier);
        });

        it("should reconcile balances", async () => {
          await reconcileBalances(setToken, subject, owner);
        });
      });

      context("when there are fees, premiums and an redemption hook", async () => {
        let issuanceHookContract: ManagerIssuanceHookMock;

        before(async () => {
          issuanceHookContract = await deployer.mocks.deployManagerIssuanceHookMock();

          managerRedemptionHook = issuanceHookContract.address;
        });

        async function subject(): Promise<any> {
          return navIssuanceModule.connect(subjectCaller.wallet).redeem(
            subjectSetToken,
            subjectReserveAsset,
            subjectSetTokenQuantity,
            subjectMinReserveQuantityReceived,
            subjectTo.address
          );
        }

        it("should properly call the pre-issue hooks", async () => {
          await subject();
          const retrievedSetToken = await issuanceHookContract.retrievedSetToken();
          const retrievedIssueQuantity = await issuanceHookContract.retrievedIssueQuantity();
          const retrievedSender = await issuanceHookContract.retrievedSender();
          const retrievedTo = await issuanceHookContract.retrievedTo();

          expect(retrievedSetToken).to.eq(subjectSetToken);
          expect(retrievedIssueQuantity).to.eq(subjectSetTokenQuantity);
          expect(retrievedSender).to.eq(owner.address);
          expect(retrievedTo).to.eq(subjectTo.address);
        });
      });
    });
  });

  describe("#redeemIntoEther", async () => {
    let setToken: SetToken;

    let subjectSetToken: Address;
    let subjectSetTokenQuantity: BigNumber;
    let subjectMinReserveQuantityReceived: BigNumber;
    let subjectTo: Account;
    let subjectCaller: Account;

    let navIssuanceSettings: NAVIssuanceSettings;
    let managerRedemptionHook: Address;
    let managerFees: BigNumber[];
    let premiumPercentage: BigNumber;
    let units: BigNumber[];
    let redeemQuantity: BigNumber;

    context("when there are 4 components and reserve asset is USDC", async () => {
      beforeEach(async () => {
        // Valued at 2000 USDC
        units = [ether(1), usdc(270), bitcoin(1).div(10), ether(600)];
        setToken = await setup.createSetToken(
          [setup.weth.address, setup.usdc.address, setup.wbtc.address, setup.dai.address],
          units, // Set is valued at 2000 USDC
          [setup.issuanceModule.address, navIssuanceModule.address]
        );
        const managerIssuanceHook = await getRandomAddress();
        const reserveAssets = [setup.usdc.address, setup.weth.address];
        const managerFeeRecipient = feeRecipient.address;
        // Set max managerFee to 20%
        const maxManagerFee = ether(0.2);
        // Set max premium to 10%
        const maxPremiumPercentage = ether(0.1);
        // Set min SetToken supply required
        const minSetTokenSupply = ether(1);

        navIssuanceSettings = {
          managerIssuanceHook,
          managerRedemptionHook,
          reserveAssets,
          feeRecipient: managerFeeRecipient,
          managerFees,
          maxManagerFee,
          premiumPercentage,
          maxPremiumPercentage,
          minSetTokenSupply,
        } as NAVIssuanceSettings;

        await navIssuanceModule.initialize(setToken.address, navIssuanceSettings);
        // Approve tokens to the controller
        await setup.weth.approve(setup.controller.address, ether(100));
        await setup.usdc.approve(setup.controller.address, usdc(1000000));
        await setup.wbtc.approve(setup.controller.address, bitcoin(1000000));
        await setup.dai.approve(setup.controller.address, ether(1000000));

        // Seed with 10 supply
        await setup.issuanceModule.connect(owner.wallet).initialize(setToken.address, ADDRESS_ZERO);
        await setup.issuanceModule.connect(owner.wallet).issue(setToken.address, ether(10), owner.address);

        // Redeem 1 SetToken
        redeemQuantity = ether(1);

        subjectSetToken = setToken.address;
        subjectSetTokenQuantity = redeemQuantity;
        subjectMinReserveQuantityReceived = ether(0);
        subjectTo = recipient;
        subjectCaller = owner;
      });

      context("when there are no fees and no redemption hooks", async () => {
        before(async () => {
          managerRedemptionHook = ADDRESS_ZERO;
          // Set fees to 0
          managerFees = [ether(0), ether(0)];
          // Set premium percentage to 50 bps
          premiumPercentage = ether(0.005);
        });

        async function subject(): Promise<any> {
          return navIssuanceModule.connect(subjectCaller.wallet).redeemIntoEther(
            subjectSetToken,
            subjectSetTokenQuantity,
            subjectMinReserveQuantityReceived,
            subjectTo.address,
          );
        }

        it("should reduce the SetToken supply", async () => {
          const previousSupply = await setToken.totalSupply();
          const preRedeemBalance = await setToken.balanceOf(owner.address);
          await subject();
          const currentSupply = await setToken.totalSupply();
          const postRedeemBalance = await setToken.balanceOf(owner.address);

          expect(preRedeemBalance.sub(postRedeemBalance)).to.eq(previousSupply.sub(currentSupply));
        });

        it("should have redeemed the reserve asset to the recipient", async () => {
          const provider = getProvider();
          const setTokenValuation = await setup.setValuer.calculateSetTokenValuation(
            subjectSetToken,
            setup.weth.address
          );
          const preIssueETHBalance = await provider.getBalance(recipient.address);
          await subject();
          const postIssueETHBalance = await provider.getBalance(recipient.address);
          const expectedETHBalance = getExpectedReserveRedeemQuantity(
            subjectSetTokenQuantity,
            setTokenValuation,
            ether(1), // ETH base units
            managerFees[1],
            ZERO, // Protocol fee percentage
            premiumPercentage
          );
          expect(postIssueETHBalance.sub(preIssueETHBalance)).to.eq(expectedETHBalance);
        });

        it("should have updated the reserve asset position correctly", async () => {
          const previousSetTokenSupply = await setToken.totalSupply();
          const setTokenValuation = await setup.setValuer.calculateSetTokenValuation(
            subjectSetToken,
            setup.weth.address
          );
          await subject();
          const currentSetTokenSupply = await setToken.totalSupply();
          const defaultPositionUnit = await setToken.getDefaultPositionRealUnit(setup.weth.address);

          const newPositionMultiplier = await setToken.positionMultiplier();
          const expectedPositionUnit = getExpectedRedeemPositionUnit(
            units[0],
            redeemQuantity,
            setTokenValuation,
            ether(1), // ETH base units
            previousSetTokenSupply,
            currentSetTokenSupply,
            newPositionMultiplier,
            managerFees[1],
            ZERO, // Protocol fee percentage
            premiumPercentage,
          );

          expect(defaultPositionUnit).to.eq(expectedPositionUnit);
        });

        it("should have updated the position multiplier correctly", async () => {
          const previousSetTokenSupply = await setToken.totalSupply();
          const preIssuePositionMultiplier = await setToken.positionMultiplier();
          await subject();
          const currentSetTokenSupply = await setToken.totalSupply();
          const postIssuePositionMultiplier = await setToken.positionMultiplier();

          const expectedPositionMultiplier = getExpectedRedeemPositionMultiplier(
            preIssuePositionMultiplier,
            previousSetTokenSupply,
            currentSetTokenSupply
          );
          expect(postIssuePositionMultiplier).to.eq(expectedPositionMultiplier);
        });

        it("should emit the SetTokenNAVRedeemed event", async () => {
          await expect(subject()).to.emit(navIssuanceModule, "SetTokenNAVRedeemed").withArgs(
            subjectSetToken,
            subjectCaller.address,
            subjectTo.address,
            setup.weth.address,
            ADDRESS_ZERO,
            subjectSetTokenQuantity,
            ZERO,
            ZERO
          );
        });

        it("should reconcile balances", async () => {
          await reconcileBalances(setToken, subject, owner);
        });

        describe("when total supply is less than min required for NAV issuance", async () => {
          beforeEach(async () => {
            // Redeem below required
            await setup.issuanceModule.connect(owner.wallet).redeem(setToken.address, ether(9), owner.address);
            subjectSetTokenQuantity = ether(0.01);
          });

          it("should revert", async () => {
            await expect(subject()).to.be.revertedWith("Supply must be greater than minimum to enable redemption");
          });
        });

        describe("when there isn't sufficient reserve asset for withdraw", async () => {
          beforeEach(async () => {
            // Add self as module and update the position state
            await setup.controller.addModule(owner.address);
            setToken = setToken.connect(owner.wallet);
            await setToken.addModule(owner.address);
            await setToken.initializeModule();

            // Remove WETH position
            await setToken.editDefaultPositionUnit(setup.weth.address, ZERO);

            subjectSetTokenQuantity = ether(1);
          });

          it("should revert", async () => {
            await expect(subject()).to.be.revertedWith("Must be greater than total available collateral");
          });
        });

        describe("when the redeem quantity is 0", async () => {
          beforeEach(async () => {
            subjectSetTokenQuantity = ZERO;
          });

          it("should revert", async () => {
            await expect(subject()).to.be.revertedWith("Quantity must be > 0");
          });
        });

        describe("when reserve asset received is less than min required", async () => {
          beforeEach(async () => {
            subjectMinReserveQuantityReceived = ether(100);
          });

          it("should revert", async () => {
            await expect(subject()).to.be.revertedWith("Must be greater than min receive reserve quantity");
          });
        });

        describe("when the SetToken is not enabled on the controller", async () => {
          beforeEach(async () => {
            const nonEnabledSetToken = await setup.createNonControllerEnabledSetToken(
              [setup.weth.address],
              [ether(1)],
              [navIssuanceModule.address]
            );

            subjectSetToken = nonEnabledSetToken.address;
          });

          it("should revert", async () => {
            await expect(subject()).to.be.revertedWith("Must be a valid and initialized SetToken");
          });
        });
      });

      context("when there are fees enabled and no redemption hooks", async () => {
        let protocolDirectFee: BigNumber;
        let protocolManagerFee: BigNumber;

        before(async () => {
          managerRedemptionHook = ADDRESS_ZERO;
          managerFees = [ether(0.1), ether(0.1)];
          premiumPercentage = ether(0.005);
        });

        beforeEach(async () => {
          protocolDirectFee = ether(.02);
          await setup.controller.addFee(navIssuanceModule.address, THREE, protocolDirectFee);

          protocolManagerFee = ether(.3);
          await setup.controller.addFee(navIssuanceModule.address, ONE, protocolManagerFee);
        });

        async function subject(): Promise<any> {
          return navIssuanceModule.connect(subjectCaller.wallet).redeemIntoEther(
            subjectSetToken,
            subjectSetTokenQuantity,
            subjectMinReserveQuantityReceived,
            subjectTo.address,
          );
        }

        it("should reduce the SetToken supply", async () => {
          const previousSupply = await setToken.totalSupply();
          const preRedeemBalance = await setToken.balanceOf(owner.address);
          await subject();
          const currentSupply = await setToken.totalSupply();
          const postRedeemBalance = await setToken.balanceOf(owner.address);

          expect(preRedeemBalance.sub(postRedeemBalance)).to.eq(previousSupply.sub(currentSupply));
        });

        it("should have redeemed the reserve asset to the recipient", async () => {
          const provider = getProvider();
          const setTokenValuation = await setup.setValuer.calculateSetTokenValuation(
            subjectSetToken,
            setup.weth.address
          );
          const preIssueETHBalance = await provider.getBalance(recipient.address);
          await subject();
          const postIssueETHBalance = await provider.getBalance(recipient.address);
          const expectedETHBalance = getExpectedReserveRedeemQuantity(
            subjectSetTokenQuantity,
            setTokenValuation,
            ether(1), // ETH base units
            managerFees[1],
            protocolDirectFee, // Protocol direct fee percentage
            premiumPercentage
          );
          expect(postIssueETHBalance.sub(preIssueETHBalance)).to.eq(expectedETHBalance);
        });

        it("should have updated the reserve asset position correctly", async () => {
          const previousSetTokenSupply = await setToken.totalSupply();
          const setTokenValuation = await setup.setValuer.calculateSetTokenValuation(
            subjectSetToken,
            setup.weth.address
          );
          await subject();
          const currentSetTokenSupply = await setToken.totalSupply();
          const defaultPositionUnit = await setToken.getDefaultPositionRealUnit(setup.weth.address);

          const newPositionMultiplier = await setToken.positionMultiplier();
          const expectedPositionUnit = getExpectedRedeemPositionUnit(
            units[0],
            redeemQuantity,
            setTokenValuation,
            ether(1), // ETH base units
            previousSetTokenSupply,
            currentSetTokenSupply,
            newPositionMultiplier,
            managerFees[1],
            protocolDirectFee, // Protocol direct fee percentage
            premiumPercentage,
          );

          expect(defaultPositionUnit).to.eq(expectedPositionUnit);
        });

        it("should have updated the position multiplier correctly", async () => {
          const previousSetTokenSupply = await setToken.totalSupply();
          const preIssuePositionMultiplier = await setToken.positionMultiplier();
          await subject();
          const currentSetTokenSupply = await setToken.totalSupply();
          const postIssuePositionMultiplier = await setToken.positionMultiplier();

          const expectedPositionMultiplier = getExpectedRedeemPositionMultiplier(
            preIssuePositionMultiplier,
            previousSetTokenSupply,
            currentSetTokenSupply
          );
          expect(postIssuePositionMultiplier).to.eq(expectedPositionMultiplier);
        });

        it("should reconcile balances", async () => {
          await reconcileBalances(setToken, subject, owner);
        });
      });
    });
  });

  context("Manager admin functions", async () => {
    let subjectSetToken: Address;
    let subjectCaller: Account;

    let setToken: SetToken;

    before(async () => {
      // Deploy a standard SetToken
      setToken = await setup.createSetToken(
        [setup.weth.address],
        [ether(1)],
        [navIssuanceModule.address]
      );

      const managerIssuanceHook = await getRandomAddress();
      const managerRedemptionHook = await getRandomAddress();
      const reserveAssets = [setup.weth.address, setup.usdc.address];
      const managerFeeRecipient = feeRecipient.address;
      // Set manager issue fee to 0.1% and redeem to 0.2%
      const managerFees = [ether(0.001), ether(0.002)];
      // Set max managerFee to 2%
      const maxManagerFee = ether(0.02);
      // Set premium to 1%
      const premiumPercentage = ether(0.01);
      // Set max premium to 10%
      const maxPremiumPercentage = ether(0.1);
      // Set min SetToken supply to 100 units
      const minSetTokenSupply = ether(100);

      const navIssuanceSettings = {
        managerIssuanceHook,
        managerRedemptionHook,
        reserveAssets,
        feeRecipient: managerFeeRecipient,
        managerFees,
        maxManagerFee,
        premiumPercentage,
        maxPremiumPercentage,
        minSetTokenSupply,
      } as NAVIssuanceSettings;

      await navIssuanceModule.initialize(
        setToken.address,
        navIssuanceSettings
      );

      const protocolDirectFee = ether(.02);
      await setup.controller.addFee(navIssuanceModule.address, TWO, protocolDirectFee);

      const protocolManagerFee = ether(.3);
      await setup.controller.addFee(navIssuanceModule.address, ZERO, protocolManagerFee);
    });

    describe("#addReserveAsset", async () => {
      let subjectReserveAsset: Address;

      beforeEach(async () => {
        subjectSetToken = setToken.address;
        subjectReserveAsset = setup.dai.address;
        subjectCaller = owner;
      });

      async function subject(): Promise<any> {
        return navIssuanceModule.connect(subjectCaller.wallet).addReserveAsset(subjectSetToken, subjectReserveAsset);
      }

      it("should add the reserve asset", async () => {
        await subject();
        const isReserveAssetAdded = await navIssuanceModule.isReserveAsset(subjectSetToken, subjectReserveAsset);
        const reserveAssets = await navIssuanceModule.getReserveAssets(subjectSetToken);
        expect(isReserveAssetAdded).to.eq(true);
        expect(reserveAssets.length).to.eq(3);
      });

      it("should emit correct ReserveAssetAdded event", async () => {
        await expect(subject()).to.emit(navIssuanceModule, "ReserveAssetAdded").withArgs(
          subjectSetToken,
          subjectReserveAsset
        );
      });

      shouldRevertIfTheCallerIsNotTheManager(subject);
      shouldRevertIfSetTokenIsInvalid(subject);
      shouldRevertIfModuleDisabled(subject);

      describe("when the reserve asset exists", async () => {
        beforeEach(async () => {
          subjectReserveAsset = setup.weth.address;
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("Reserve asset already exists");
        });
      });
    });

    describe("#removeReserveAsset", async () => {
      let subjectReserveAsset: Address;

      beforeEach(async () => {
        subjectSetToken = setToken.address;
        subjectReserveAsset = setup.usdc.address;
        subjectCaller = owner;
      });

      async function subject(): Promise<any> {
        return navIssuanceModule.connect(subjectCaller.wallet).removeReserveAsset(subjectSetToken, subjectReserveAsset);
      }

      it("should remove the reserve asset", async () => {
        await subject();
        const isReserveAsset = await navIssuanceModule.isReserveAsset(subjectSetToken, subjectReserveAsset);
        const reserveAssets = await navIssuanceModule.getReserveAssets(subjectSetToken);

        expect(isReserveAsset).to.eq(false);
        expect(JSON.stringify(reserveAssets)).to.eq(JSON.stringify([setup.weth.address]));
      });

      it("should emit correct ReserveAssetRemoved event", async () => {
        await expect(subject()).to.emit(navIssuanceModule, "ReserveAssetRemoved").withArgs(
          subjectSetToken,
          subjectReserveAsset
        );
      });

      shouldRevertIfTheCallerIsNotTheManager(subject);
      shouldRevertIfSetTokenIsInvalid(subject);
      shouldRevertIfModuleDisabled(subject);

      describe("when the reserve asset does not exist", async () => {
        beforeEach(async () => {
          subjectReserveAsset = setup.wbtc.address;
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("Reserve asset does not exist");
        });
      });
    });

    describe("#editPremium", async () => {
      let subjectPremium: BigNumber;

      beforeEach(async () => {
        subjectSetToken = setToken.address;
        subjectPremium = ether(0.02);
        subjectCaller = owner;
      });

      async function subject(): Promise<any> {
        return navIssuanceModule.connect(subjectCaller.wallet).editPremium(subjectSetToken, subjectPremium);
      }

      it("should edit the premium", async () => {
        await subject();
        const retrievedPremium = await navIssuanceModule.getIssuePremium(subjectSetToken, ADDRESS_ZERO, ZERO);
        expect(retrievedPremium).to.eq(subjectPremium);
      });

      it("should emit correct PremiumEdited event", async () => {
        await expect(subject()).to.emit(navIssuanceModule, "PremiumEdited").withArgs(
          subjectSetToken,
          subjectPremium
        );
      });

      shouldRevertIfTheCallerIsNotTheManager(subject);
      shouldRevertIfSetTokenIsInvalid(subject);
      shouldRevertIfModuleDisabled(subject);

      describe("when the premium is greater than maximum allowed", async () => {
        beforeEach(async () => {
          subjectPremium = ether(1);
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("Premium must be less than maximum allowed");
        });
      });
    });

    describe("#editManagerFee", async () => {
      let subjectManagerFee: BigNumber;
      let subjectFeeIndex: BigNumber;

      beforeEach(async () => {
        subjectSetToken = setToken.address;
        subjectManagerFee = ether(0.01);
        subjectFeeIndex = ZERO;
        subjectCaller = owner;
      });

      async function subject(): Promise<any> {
        return navIssuanceModule.connect(subjectCaller.wallet).editManagerFee(subjectSetToken, subjectManagerFee, subjectFeeIndex);
      }

      it("should edit the manager issue fee", async () => {
        await subject();
        const managerIssueFee = await navIssuanceModule.getManagerFee(subjectSetToken, subjectFeeIndex);

        expect(managerIssueFee).to.eq(subjectManagerFee);
      });

      it("should emit correct ManagerFeeEdited event", async () => {
        await expect(subject()).to.emit(navIssuanceModule, "ManagerFeeEdited").withArgs(
          subjectSetToken,
          subjectManagerFee,
          subjectFeeIndex
        );
      });

      describe("when editing the redeem fee", async () => {
        beforeEach(async () => {
          subjectManagerFee = ether(0.002);
          subjectFeeIndex = ONE;
        });

        it("should edit the manager redeem fee", async () => {
          await subject();
          const managerRedeemFee = await navIssuanceModule.getManagerFee(subjectSetToken, subjectFeeIndex);

          expect(managerRedeemFee).to.eq(subjectManagerFee);
        });
      });

      shouldRevertIfTheCallerIsNotTheManager(subject);
      shouldRevertIfSetTokenIsInvalid(subject);
      shouldRevertIfModuleDisabled(subject);

      describe("when the manager fee is greater than maximum allowed", async () => {
        beforeEach(async () => {
          subjectManagerFee = ether(1);
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("Manager fee must be less than maximum allowed");
        });
      });
    });

    describe("#editFeeRecipient", async () => {
      let subjectFeeRecipient: Address;

      beforeEach(async () => {
        subjectSetToken = setToken.address;
        subjectFeeRecipient = feeRecipient.address;
        subjectCaller = owner;
      });

      async function subject(): Promise<any> {
        return navIssuanceModule.connect(subjectCaller.wallet).editFeeRecipient(subjectSetToken, subjectFeeRecipient);
      }

      it("should edit the manager fee recipient", async () => {
        await subject();
        const navIssuanceSettings = await navIssuanceModule.navIssuanceSettings(subjectSetToken);
        expect(navIssuanceSettings.feeRecipient).to.eq(subjectFeeRecipient);
      });

      it("should emit correct FeeRecipientEdited event", async () => {
        await expect(subject()).to.emit(navIssuanceModule, "FeeRecipientEdited").withArgs(
          subjectSetToken,
          subjectFeeRecipient
        );
      });

      shouldRevertIfTheCallerIsNotTheManager(subject);
      shouldRevertIfSetTokenIsInvalid(subject);
      shouldRevertIfModuleDisabled(subject);

      describe("when the manager fee is greater than maximum allowed", async () => {
        beforeEach(async () => {
          subjectFeeRecipient = ADDRESS_ZERO;
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("Fee recipient must not be 0 address");
        });
      });
    });

    function shouldRevertIfTheCallerIsNotTheManager(subject: any) {
      describe("when the caller is not the manager", async () => {
        beforeEach(async () => {
          subjectCaller = await getRandomAccount();
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("Must be the SetToken manager");
        });
      });
    }

    function shouldRevertIfSetTokenIsInvalid(subject: any) {
      describe("when the SetToken is not enabled on the controller", async () => {
        beforeEach(async () => {
          const nonEnabledSetToken = await setup.createNonControllerEnabledSetToken(
            [setup.weth.address],
            [ether(1)],
            [navIssuanceModule.address]
          );

          subjectSetToken = nonEnabledSetToken.address;
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("Must be a valid and initialized SetToken");
        });
      });
    }

    function shouldRevertIfModuleDisabled(subject: any) {
      describe("when the module is disabled", async () => {
        beforeEach(async () => {
          await setToken.removeModule(navIssuanceModule.address);
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("Must be a valid and initialized SetToken");
        });
      });
    }
  });
});

async function reconcileBalances(setToken: SetToken, subject: any, signer: Account): Promise<void> {
  await subject();

  const currentSetTokenSupply = await setToken.totalSupply();
  const components = await setToken.getComponents();
  for (let i = 0; i < components.length; i++) {
    const component = Erc20Factory.connect(components[i], signer.wallet);
    const defaultPositionUnit = await setToken.getDefaultPositionRealUnit(component.address);

    const expectedBalance = preciseMul(defaultPositionUnit, currentSetTokenSupply);
    const actualBalance = await component.balanceOf(setToken.address);

    expect(actualBalance).to.be.gte(expectedBalance);
  }
}