import "module-alias/register";

import { BigNumber, constants } from "ethers";

import { getRandomAccount, getRandomAddress } from "@utils/test";
import { Account } from "@utils/test/types";
import { Address } from "@utils/types";
import { impersonateAccount } from "@utils/test/testingUtils";
import DeployHelper from "@utils/deploys";
import { cacheBeforeEach, getAccounts, getWaffleExpect } from "@utils/test/index";
import { ether } from "@utils/index";

import {
  AaveV3LeverageModule,
  IPoolAddressesProvider,
  IPoolAddressesProvider__factory,
  Controller,
  Controller__factory,
  DebtIssuanceModuleV2,
  DebtIssuanceModuleV2__factory,
  IntegrationRegistry,
  IntegrationRegistry__factory,
  SetToken,
  SetToken__factory,
  SetTokenCreator,
  SetTokenCreator__factory,
} from "@typechain/index";

const expect = getWaffleExpect();

// https://docs.aave.com/developers/deployed-contracts/v3-mainnet/ethereum-mainnet

const contractAddresses = {
  aaveV3AddressProvider: "0x2f39d218133AFaB8F2B819B1066c7E434Ad94E9e",
  aaveV3ProtocolDataProvider: "0x7B4EB56E7CD4b454BA8ff71E4518426369a138a3",
  controller: "0xD2463675a099101E36D85278494268261a66603A",
  debtIssuanceModule: "0xa0a98EB7Af028BE00d04e46e1316808A62a8fd59",
  setTokenCreator: "0x2758BF6Af0EC63f1710d3d7890e1C263a247B75E",
  integrationRegistry: "0xb9083dee5e8273E54B9DB4c31bA9d4aB7C6B28d3",
};

const tokenAddresses = {
  weth: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
  aWethV3: "0x4d5F47FA6A74757f35C14fD3a6Ef8E3C9BC514E8",
  aWethVariableDebtTokenV3: "0xeA51d7853EEFb32b6ee06b1C12E6dcCA88Be0fFE",
  dai: "0x6B175474E89094C44Da98b954EedeAC495271d0F",
  aDaiV3: "0x018008bfb33d285247A21d44E50697654f754e63",
  aDaiVariableDebtTokenV3: "0xcF8d0c70c850859266f5C338b38F9D663181C314",
};

describe("AaveV3LeverageModule integration [ @forked-mainnet ]", () => {
  let owner: Account;
  let deployer: DeployHelper;
  let aaveLeverageModule: AaveV3LeverageModule;
  let poolAddressesProvider: IPoolAddressesProvider;
  let debtIssuanceModule: DebtIssuanceModuleV2;
  let integrationRegistry: IntegrationRegistry;
  let setTokenCreator: SetTokenCreator;
  let controller: Controller;

  let manager: Address;
  const maxManagerFee = ether(0.05);
  const managerIssueFee = ether(0);
  const managerRedeemFee = ether(0);
  let managerFeeRecipient: Address;
  let managerIssuanceHook: Address;
  before(async () => {
    [owner] = await getAccounts();

    poolAddressesProvider = IPoolAddressesProvider__factory.connect(
      contractAddresses.aaveV3AddressProvider,
      owner.wallet,
    );

    manager = owner.address;
    managerFeeRecipient = owner.address;
    managerIssuanceHook = constants.AddressZero;

    controller = Controller__factory.connect(contractAddresses.controller, owner.wallet);

    const controllerOwner = await controller.owner();
    const controllerOwnerSigner = await impersonateAccount(controllerOwner);
    controller = controller.connect(controllerOwnerSigner);

    deployer = new DeployHelper(owner.wallet);
    const aaveV2Library = await deployer.libraries.deployAaveV2();

    aaveLeverageModule = await deployer.modules.deployAaveV3LeverageModule(
      controller.address,
      poolAddressesProvider.address,
      "contracts/protocol/integration/lib/AaveV2.sol:AaveV2",
      aaveV2Library.address,
    );
    await controller.addModule(aaveLeverageModule.address);

    debtIssuanceModule = DebtIssuanceModuleV2__factory.connect(
      contractAddresses.debtIssuanceModule,
      owner.wallet,
    );
    setTokenCreator = SetTokenCreator__factory.connect(
      contractAddresses.setTokenCreator,
      owner.wallet,
    );
    integrationRegistry = IntegrationRegistry__factory.connect(
      contractAddresses.integrationRegistry,
      owner.wallet,
    );
    const integrationRegistryOwner = await integrationRegistry.owner();
    integrationRegistry = integrationRegistry.connect(
      await impersonateAccount(integrationRegistryOwner),
    );
  });

  describe("#constructor", () => {
    it("Should set the correct aave contracts", async () => {
      expect(await aaveLeverageModule.protocolDataProvider()).to.eq(
        contractAddresses.aaveV3ProtocolDataProvider,
      );
      expect(await aaveLeverageModule.lendingPoolAddressesProvider()).to.eq(
        contractAddresses.aaveV3AddressProvider,
      );
    });

    it("should set the correct controller", async () => {
      const returnController = await aaveLeverageModule.controller();
      expect(returnController).to.eq(contractAddresses.controller);
    });

    it("should set the correct underlying to reserve tokens mappings for weth", async () => {
      const wethReserveTokens = await aaveLeverageModule.underlyingToReserveTokens(
        tokenAddresses.weth,
      );
      expect(wethReserveTokens.aToken).to.eq(tokenAddresses.aWethV3);
      expect(wethReserveTokens.variableDebtToken).to.eq(tokenAddresses.aWethVariableDebtTokenV3);
    });

    it("should set the correct underlying to reserve tokens mappings for dai", async () => {
      const daiReserveTokens = await aaveLeverageModule.underlyingToReserveTokens(
        tokenAddresses.dai,
      );
      expect(daiReserveTokens.aToken).to.eq(tokenAddresses.aDaiV3);
      expect(daiReserveTokens.variableDebtToken).to.eq(tokenAddresses.aDaiVariableDebtTokenV3);
    });
  });

  describe("#initialize", async () => {
    let setToken: SetToken;
    let isAllowListed: boolean;
    let subjectSetToken: Address;
    let subjectCollateralAssets: Address[];
    let subjectBorrowAssets: Address[];
    let subjectCaller: Account;

    async function createSetToken(
      components: Address[],
      positions: BigNumber[],
      modules: Address[],
    ): Promise<SetToken> {
      const setTokenAddress = await setTokenCreator.callStatic.create(
        components,
        positions,
        modules,
        manager,
        "TestSetToken",
        "TEST",
      );

      await setTokenCreator.create(components, positions, modules, manager, "TestSetToken", "TEST");
      return SetToken__factory.connect(setTokenAddress, owner.wallet);
    }

    const initializeContracts = async () => {
      manager = owner.address;
      setToken = await createSetToken(
        [tokenAddresses.weth, tokenAddresses.dai],
        [ether(1), ether(100)],
        [aaveLeverageModule.address, debtIssuanceModule.address],
      );

      await debtIssuanceModule.initialize(
        setToken.address,
        maxManagerFee,
        managerIssueFee,
        managerRedeemFee,
        managerFeeRecipient,
        managerIssuanceHook,
      );

      if (isAllowListed) {
        // Add SetToken to allow list
        await aaveLeverageModule.updateAllowedSetToken(setToken.address, true);
      }
    };

    const initializeSubjectVariables = () => {
      subjectSetToken = setToken.address;
      subjectCollateralAssets = [tokenAddresses.weth, tokenAddresses.dai];
      subjectBorrowAssets = [tokenAddresses.dai, tokenAddresses.weth];
      subjectCaller = owner;
    };

    async function subject(): Promise<any> {
      return aaveLeverageModule
        .connect(subjectCaller.wallet)
        .initialize(subjectSetToken, subjectCollateralAssets, subjectBorrowAssets);
    }

    describe("when isAllowListed is true", () => {
      before(async () => {
        isAllowListed = true;
      });

      cacheBeforeEach(initializeContracts);
      beforeEach(initializeSubjectVariables);

      describe("when module is registered as integration", () => {
        beforeEach(async () => {
          await integrationRegistry.addIntegration(
            aaveLeverageModule.address,
            "DefaultIssuanceModule",
            debtIssuanceModule.address,
          );
          await integrationRegistry.addIntegration(
            debtIssuanceModule.address,
            "AaveLeverageModuleV3",
            aaveLeverageModule.address,
          );
        });
        it("should enable the Module on the SetToken", async () => {
          await subject();
          const isModuleEnabled = await setToken.isInitializedModule(aaveLeverageModule.address);
          expect(isModuleEnabled).to.eq(true);
        });

        it("should set the Aave settings and mappings", async () => {
          await subject();

          const enabledAssets = await aaveLeverageModule.getEnabledAssets(setToken.address);
          const [collateralAssets, borrowAssets] = enabledAssets;

          const isWethCollateral = await aaveLeverageModule.collateralAssetEnabled(
            setToken.address,
            tokenAddresses.weth,
          );
          const isDaiCollateral = await aaveLeverageModule.collateralAssetEnabled(
            setToken.address,
            tokenAddresses.dai,
          );
          const isDaiBorrow = await aaveLeverageModule.borrowAssetEnabled(
            setToken.address,
            tokenAddresses.dai,
          );
          const isWethBorrow = await aaveLeverageModule.borrowAssetEnabled(
            setToken.address,
            tokenAddresses.weth,
          );

          expect(collateralAssets).to.deep.eq(subjectCollateralAssets);
          expect(borrowAssets).to.deep.eq(subjectBorrowAssets);
          expect(isWethCollateral).to.be.true;
          expect(isDaiCollateral).to.be.true;
          expect(isDaiBorrow).to.be.true;
          expect(isWethBorrow).to.be.true;
        });

        // it("should register on the debt issuance module", async () => {
        //   await subject();
        //   const isRegistered = await debtIssuanceModule.isRegistered(setToken.address);
        //   expect(isRegistered).to.be.true;
        // });

        describe("when debt issuance module is not added to integration registry", async () => {
          beforeEach(async () => {
            await integrationRegistry.removeIntegration(
              aaveLeverageModule.address,
              "DefaultIssuanceModule",
            );
          });

          afterEach(async () => {
            // Add debt issuance address to integration
            await integrationRegistry.addIntegration(
              aaveLeverageModule.address,
              "DefaultIssuanceModule",
              debtIssuanceModule.address,
            );
          });

          it("should revert", async () => {
            await expect(subject()).to.be.revertedWith("Must be valid adapter");
          });
        });

        describe("when debt issuance module is not initialized on SetToken", async () => {
          beforeEach(async () => {
            await setToken.removeModule(debtIssuanceModule.address);
          });

          afterEach(async () => {
            await setToken.addModule(debtIssuanceModule.address);
            await debtIssuanceModule.initialize(
              setToken.address,
              maxManagerFee,
              managerIssueFee,
              managerRedeemFee,
              managerFeeRecipient,
              managerIssuanceHook,
            );
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
            await controller.addModule(newModule);

            const aaveLeverageModuleNotPendingSetToken = await createSetToken(
              [tokenAddresses.weth],
              [ether(1)],
              [newModule],
            );

            subjectSetToken = aaveLeverageModuleNotPendingSetToken.address;
          });

          it("should revert", async () => {
            await expect(subject()).to.be.revertedWith("Must be pending initialization");
          });
        });

        describe("when the SetToken is not enabled on the controller", async () => {
          async function createNonControllerEnabledSetToken(
            components: Address[],
            positions: BigNumber[],
            modules: Address[],
          ): Promise<SetToken> {
            return new SetToken__factory(owner.wallet).deploy(
              components,
              positions,
              modules,
              controller.address,
              manager,
              "TestSetToken",
              "TEST",
            );
          }
          beforeEach(async () => {
            const nonEnabledSetToken = await createNonControllerEnabledSetToken(
              [tokenAddresses.weth],
              [ether(1)],
              [aaveLeverageModule.address],
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
            await aaveLeverageModule.updateAnySetAllowed(true);
          });

          describe("when module is registered as integration", () => {
            beforeEach(async () => {
              await integrationRegistry.addIntegration(
                aaveLeverageModule.address,
                "DefaultIssuanceModule",
                debtIssuanceModule.address,
              );
              await integrationRegistry.addIntegration(
                debtIssuanceModule.address,
                "AaveLeverageModuleV3",
                aaveLeverageModule.address,
              );
            });
            it("should enable the Module on the SetToken", async () => {
              await subject();
              const isModuleEnabled = await setToken.isInitializedModule(
                aaveLeverageModule.address,
              );
              expect(isModuleEnabled).to.eq(true);
            });
          });
        });
      });
    });
  });
});
