import "module-alias/register";

import { Address } from "@utils/types";
import { Account } from "@utils/test/types";
import {
  PerpV2,
  PerpV2LeverageModule,
  DebtIssuanceMock,
  StandardTokenMock,
  SetToken
} from "@utils/contracts";

import DeployHelper from "@utils/deploys";
import { ether } from "@utils/index";

import {
  cacheBeforeEach,
  getAccounts,
  getWaffleExpect,
  getSystemFixture,
  getPerpV2Fixture,
  getRandomAccount,
  getRandomAddress,
} from "@utils/test/index";

import { PerpV2Fixture, SystemFixture } from "@utils/fixtures";
import { ADDRESS_ZERO  } from "@utils/constants";

const expect = getWaffleExpect();

describe("PerpV2LeverageModule", () => {
  let owner: Account;
  let maker: Account;
  let deployer: DeployHelper;

  let perpLib: PerpV2;
  let perpLeverageModule: PerpV2LeverageModule;
  let debtIssuanceMock: DebtIssuanceMock;
  let setup: SystemFixture;
  let perpSetup: PerpV2Fixture;

  let usdc: StandardTokenMock;

  cacheBeforeEach(async () => {
    [
      owner,
      maker,
    ] = await getAccounts();

    deployer = new DeployHelper(owner.wallet);
    setup = getSystemFixture(owner.address);
    await setup.initialize();

    perpSetup = getPerpV2Fixture(owner.address);
    await perpSetup.initialize();

    usdc = perpSetup.usdc;

    // Create liquidity
    await perpSetup.initializePoolWithLiquidityWide(maker, ether(1000), ether(10_000));

    debtIssuanceMock = await deployer.mocks.deployDebtIssuanceMock();
    await setup.controller.addModule(debtIssuanceMock.address);

    perpLib = await deployer.libraries.deployPerpV2();
    perpLeverageModule = await deployer.modules.deployPerpV2LeverageModule(
      setup.controller.address,
      perpSetup.accountBalance.address,
      perpSetup.clearingHouse.address,
      perpSetup.exchange.address,
      perpSetup.vault.address,
      perpSetup.quoter.address,
      "contracts/protocol/integration/lib/PerpV2.sol:PerpV2",
      perpLib.address,
    );
    await setup.controller.addModule(perpLeverageModule.address);

    await setup.integrationRegistry.addIntegration(
      perpLeverageModule.address,
      "DefaultIssuanceModule",
      debtIssuanceMock.address
    );
  });

  describe("#constructor", async () => {
    let subjectController: Address;
    let subjectAccountBalance: Address;
    let subjectClearingHouse: Address;
    let subjectExchange: Address;
    let subjectVault: Address;
    let subjectQuoter: Address;

    beforeEach(async () => {
      subjectController = setup.controller.address;
      subjectAccountBalance = perpSetup.accountBalance.address;
      subjectClearingHouse = perpSetup.clearingHouse.address;
      subjectExchange = perpSetup.exchange.address;
      subjectVault = perpSetup.vault.address;
      subjectQuoter = perpSetup.quoter.address;
    });

    async function subject(): Promise<PerpV2LeverageModule> {
      return deployer.modules.deployPerpV2LeverageModule(
        subjectController,
        subjectAccountBalance,
        subjectClearingHouse,
        subjectExchange,
        subjectVault,
        subjectQuoter,
        "contracts/protocol/integration/lib/PerpV2.sol:PerpV2",
        perpLib.address,
      );
    }

    it("should set the correct controller", async () => {
      const perpLeverageModule = await subject();

      const controller = await perpLeverageModule.controller();
      expect(controller).to.eq(subjectController);
    });

    it("should set the correct PerpV2 contracts", async () => {
      const perpLeverageModule = await subject();

      const perpAccountBalance = await perpLeverageModule.perpAccountBalance();
      const perpClearingHouse = await perpLeverageModule.perpClearingHouse();
      const perpExchange = await perpLeverageModule.perpExchange();
      const perpVault = await perpLeverageModule.perpVault();
      const perpQuoter = await perpLeverageModule.perpQuoter();

      expect(perpAccountBalance).to.eq(perpSetup.accountBalance.address);
      expect(perpClearingHouse).to.eq(perpSetup.clearingHouse.address);
      expect(perpExchange).to.eq(perpSetup.exchange.address);
      expect(perpVault).to.eq(perpSetup.vault.address);
      expect(perpQuoter).to.eq(perpSetup.quoter.address);
    });
  });

  describe("#initialize", async () => {
    let setToken: SetToken;
    let isAllowListed: boolean;
    let subjectSetToken: Address;
    let subjectCollateralToken: Address;
    let subjectCaller: Account;

    const initializeContracts = async () => {
      setToken = await setup.createSetToken(
        [usdc.address],
        [ether(100)],
        [perpLeverageModule.address, debtIssuanceMock.address]
      );
      await debtIssuanceMock.initialize(setToken.address);

      if (isAllowListed) {
        // Add SetToken to allow list
        await perpLeverageModule.updateAllowedSetToken(setToken.address, true);
      }
    };

    const initializeSubjectVariables = () => {
      subjectSetToken = setToken.address;
      subjectCollateralToken = usdc.address;
      subjectCaller = owner;
    };

    async function subject(): Promise<any> {
      return perpLeverageModule.connect(subjectCaller.wallet).initialize(
        subjectSetToken,
        subjectCollateralToken
      );
    }

    describe("when isAllowListed is true", () => {
      before(async () => {
        isAllowListed = true;
      });

      cacheBeforeEach(initializeContracts);
      beforeEach(initializeSubjectVariables);

      it("should enable the Module on the SetToken", async () => {
        await subject();
        const isModuleEnabled = await setToken.isInitializedModule(perpLeverageModule.address);
        expect(isModuleEnabled).to.eq(true);
      });

      it("should set the collateralToken mapping", async () => {
        const initialCollateralToken = await perpLeverageModule.collateralToken(setToken.address);

        await subject();

        const finalCollateralToken = await perpLeverageModule.collateralToken(setToken.address);

        expect(initialCollateralToken).to.eq(ADDRESS_ZERO);
        expect(finalCollateralToken).to.eq(usdc.address);
      });

      it("should register on the debt issuance module", async () => {
        await subject();
        const isRegistered = await debtIssuanceMock.isRegistered(setToken.address);
        expect(isRegistered).to.be.true;
      });

      describe("when debt issuance module is not added to integration registry", async () => {
        beforeEach(async () => {
          await setup.integrationRegistry.removeIntegration(perpLeverageModule.address, "DefaultIssuanceModule");
        });

        afterEach(async () => {
          // Add debt issuance address to integration
          await setup.integrationRegistry.addIntegration(
            perpLeverageModule.address,
            "DefaultIssuanceModule",
            debtIssuanceMock.address
          );
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("Must be valid adapter");
        });
      });

      describe("when debt issuance module is not initialized on SetToken", async () => {
        beforeEach(async () => {
          await setToken.removeModule(debtIssuanceMock.address);
        });

        afterEach(async () => {
          await setToken.addModule(debtIssuanceMock.address);
          await debtIssuanceMock.initialize(setToken.address);
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("Issuance not initialized");
        });
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

          const perpLeverageModuleNotPendingSetToken = await setup.createSetToken(
            [usdc.address],
            [ether(100)],
            [newModule]
          );

          subjectSetToken = perpLeverageModuleNotPendingSetToken.address;
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
            [perpLeverageModule.address]
          );

          subjectSetToken = nonEnabledSetToken.address;
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("Must be controller-enabled SetToken");
        });
      });
    });

    describe("when isAllowListed is false", async () => {
      before(async () => {
        isAllowListed = false;
      });

      cacheBeforeEach(initializeContracts);
      beforeEach(initializeSubjectVariables);

      describe("when SetToken is not allowlisted", async () => {
        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("Not allowed SetToken");
        });
      });

      describe("when any Set can initialize this module", async () => {
        beforeEach(async () => {
          await perpLeverageModule.updateAnySetAllowed(true);
        });

        it("should enable the Module on the SetToken", async () => {
          await subject();
          const isModuleEnabled = await setToken.isInitializedModule(perpLeverageModule.address);
          expect(isModuleEnabled).to.eq(true);
        });
      });
    });
  });

  describe("#lever", () => {
    // inverse
    // multiple tokens

  });

  describe("#delever", () => {
    // inverse
    // multiple tokens
  });

  describe("#deposit", () => {

  });

  describe("#withdraw", () => {

  });

  describe("#moduleIssueHook", () => {
    // inverse
    // multiple tokens
  });

  describe("#moduleRedeemHook", () => {
    // inverse
    // multiple tokens
  });

  describe("#componentIssueHook", () => {
    // inverse
    // multiple tokens
  });

  describe("#componentRedeemHook", () => {
    // inverse
    // multiple tokens
  });

  describe("#registerToModule", async () => {
    let setToken: SetToken;
    let otherIssuanceModule: DebtIssuanceMock;
    let isInitialized: boolean;
    let subjectSetToken: Address;
    let subjectDebtIssuanceModule: Address;

    const initializeContracts = async function () {
      otherIssuanceModule = await deployer.mocks.deployDebtIssuanceMock();
      await setup.controller.addModule(otherIssuanceModule.address);

      setToken = await setup.createSetToken(
        [usdc.address],
        [ether(100)],
        [perpLeverageModule.address, setup.issuanceModule.address, debtIssuanceMock.address]
      );
      await debtIssuanceMock.initialize(setToken.address);
      // Add SetToken to allow list
      await perpLeverageModule.updateAllowedSetToken(setToken.address, true);
      // Initialize module if set to true
      if (isInitialized) {
        await perpLeverageModule.initialize(
          setToken.address,
          usdc.address
        );
      }
      await setup.issuanceModule.initialize(setToken.address, ADDRESS_ZERO);
      // Add other issuance mock after initializing PerpV2LeverageModule, so register is never called
      await setToken.addModule(otherIssuanceModule.address);
      await otherIssuanceModule.initialize(setToken.address);
    };

    const initializeSubjectVariables = () => {
      subjectSetToken = setToken.address;
      subjectDebtIssuanceModule = otherIssuanceModule.address;
    };

    async function subject(): Promise<any> {
      return perpLeverageModule.registerToModule(subjectSetToken, subjectDebtIssuanceModule);
    }

    describe("when module is initialized", () => {
      beforeEach(() => {
        isInitialized = true;
      });

      cacheBeforeEach(initializeContracts);
      beforeEach(initializeSubjectVariables);

      it("should register on the other issuance module", async () => {
        const previousIsRegistered = await otherIssuanceModule.isRegistered(setToken.address);
        await subject();
        const currentIsRegistered = await otherIssuanceModule.isRegistered(setToken.address);
        expect(previousIsRegistered).to.be.false;
        expect(currentIsRegistered).to.be.true;
      });

      describe("when SetToken is not valid", async () => {
        beforeEach(async () => {
          const nonEnabledSetToken = await setup.createNonControllerEnabledSetToken(
            [usdc.address],
            [ether(1)],
            [perpLeverageModule.address],
            owner.address
          );

          subjectSetToken = nonEnabledSetToken.address;
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("Must be a valid and initialized SetToken");
        });
      });

      describe("when debt issuance module is not initialized on SetToken", async () => {
        beforeEach(async () => {
          await setToken.removeModule(otherIssuanceModule.address);
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("Issuance not initialized");
        });
      });
    });

    describe("when module is not initialized", async () => {
      beforeEach(async () => {
        isInitialized = false;
        await initializeContracts();
        initializeSubjectVariables();
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Must be a valid and initialized SetToken");
      });
    });
  });

  describe("#removeModule", async () => {
    let setToken: SetToken;
    let subjectModule: Address;

    cacheBeforeEach(async () => {
      setToken = await setup.createSetToken(
        [usdc.address],
        [ether(100)],
        [perpLeverageModule.address, debtIssuanceMock.address, setup.issuanceModule.address]
      );
      await debtIssuanceMock.initialize(setToken.address);
      // Add SetToken to allow list
      await perpLeverageModule.updateAllowedSetToken(setToken.address, true);
      await perpLeverageModule.initialize(
        setToken.address,
        usdc.address
      );
      await setup.issuanceModule.initialize(setToken.address, ADDRESS_ZERO);

      // Approve tokens to issuance module and call issue
      await usdc.approve(setup.issuanceModule.address, ether(100));
      await setup.issuanceModule.issue(setToken.address, ether(1), owner.address);
    });

    beforeEach(() => {
      subjectModule = perpLeverageModule.address;
    });

    async function subject(): Promise<any> {
      return setToken.removeModule(subjectModule);
    }

    it("should remove the Module on the SetToken", async () => {
      await subject();
      const isModuleEnabled = await setToken.isInitializedModule(perpLeverageModule.address);
      expect(isModuleEnabled).to.be.false;
    });

    it("should delete the collateralToken mapping", async () => {
      const initialCollateralToken = await perpLeverageModule.collateralToken(setToken.address);

      await subject();

      const finalCollateralToken = await perpLeverageModule.collateralToken(setToken.address);

      expect(initialCollateralToken).to.eq(usdc.address);
      expect(finalCollateralToken).to.eq(ADDRESS_ZERO);
    });

    it("should unregister on the debt issuance module", async () => {
      await subject();
      const isRegistered = await debtIssuanceMock.isRegistered(setToken.address);
      expect(isRegistered).to.be.false;
    });

    describe("when collateral balance exists", async () => {
      beforeEach(async () => {
        await perpLeverageModule.deposit(setToken.address, ether(10));
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Collateral balance remaining");
      });
    });
  });

  describe("#updateAllowedSetToken", async () => {
    let setToken: SetToken;

    let subjectSetToken: Address;
    let subjectStatus: boolean;
    let subjectCaller: Account;

    beforeEach(async () => {
      setToken = setToken = await setup.createSetToken(
        [usdc.address],
        [ether(2)],
        [perpLeverageModule.address, debtIssuanceMock.address]
      );

      subjectSetToken = setToken.address;
      subjectStatus = true;
      subjectCaller = owner;
    });

    async function subject(): Promise<any> {
      return perpLeverageModule.connect(subjectCaller.wallet).updateAllowedSetToken(
        subjectSetToken,
        subjectStatus
      );
    }

    it("should add Set to allow list", async () => {
      await subject();

      const isAllowed = await perpLeverageModule.allowedSetTokens(subjectSetToken);

      expect(isAllowed).to.be.true;
    });

    it("should emit the correct SetTokenStatusUpdated event", async () => {
      await expect(subject()).to.emit(perpLeverageModule, "SetTokenStatusUpdated").withArgs(
        subjectSetToken,
        subjectStatus
      );
    });

    describe("when disabling a Set", async () => {
      beforeEach(async () => {
        await subject();
        subjectStatus = false;
      });

      it("should remove Set from allow list", async () => {
        await subject();

        const isAllowed = await perpLeverageModule.allowedSetTokens(subjectSetToken);

        expect(isAllowed).to.be.false;
      });

      it("should emit the correct SetTokenStatusUpdated event", async () => {
        await expect(subject()).to.emit(perpLeverageModule, "SetTokenStatusUpdated").withArgs(
          subjectSetToken,
          subjectStatus
        );
      });

      describe("when Set Token is removed on controller", async () => {
        beforeEach(async () => {
          await setup.controller.removeSet(setToken.address);
        });

        it("should remove the Set from allow list", async () => {
          await subject();

          const isAllowed = await perpLeverageModule.allowedSetTokens(subjectSetToken);

          expect(isAllowed).to.be.false;
        });
      });
    });

    describe("when Set is removed on controller", async () => {
      beforeEach(async () => {
        await setup.controller.removeSet(setToken.address);
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Invalid SetToken");
      });
    });

    describe("when not called by owner", async () => {
      beforeEach(async () => {
        subjectCaller = await getRandomAccount();
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Ownable: caller is not the owner");
      });
    });
  });

  describe("#updateAnySetAllowed", async () => {
    let subjectAnySetAllowed: boolean;
    let subjectCaller: Account;

    beforeEach(async () => {
      subjectAnySetAllowed = true;
      subjectCaller = owner;
    });

    async function subject(): Promise<any> {
      return perpLeverageModule.connect(subjectCaller.wallet).updateAnySetAllowed(subjectAnySetAllowed);
    }

    it("should remove Set from allow list", async () => {
      await subject();

      const anySetAllowed = await perpLeverageModule.anySetAllowed();

      expect(anySetAllowed).to.be.true;
    });

    it("should emit the correct AnySetAllowedUpdated event", async () => {
      await expect(subject()).to.emit(perpLeverageModule, "AnySetAllowedUpdated").withArgs(
        subjectAnySetAllowed
      );
    });

    describe("when not called by owner", async () => {
      beforeEach(async () => {
        subjectCaller = await getRandomAccount();
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Ownable: caller is not the owner");
      });
    });
  });

  describe("#getPositionInfo", () => {

  });

  describe("#getAccountInfo", () => {

  });

  describe("#getSpotPrice", () => {

  });
});
