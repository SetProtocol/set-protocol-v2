import "module-alias/register";

import Web3 from "web3";
import { BigNumber } from "@ethersproject/bignumber";

import { Address, Position } from "@utils/types";
import { Account } from "@utils/test/types";
import {
  ADDRESS_ZERO,
  ZERO,
  ONE,
  EMPTY_BYTES,
  MODULE_STATE,
  POSITION_STATE,
  PRECISE_UNIT,
} from "@utils/constants";
import {
  Controller,
  SetToken,
  StandardTokenMock,
  ModuleBaseMock,
  SetTokenInternalUtils,
  SetTokenDataUtils
} from "@utils/contracts";
import DeployHelper from "@utils/deploys";
import {
  ether,
  preciseMul,
  divDown,
} from "@utils/index";
import {
  getOptimismAccounts,
  getWethBalance,
  getRandomAccount,
  getRandomAddress,
  getWaffleExpect,
  transferWeth,
  assertRevertOVM,
  provider
} from "@utils/test/index";

const web3 = new Web3();
const expect = getWaffleExpect();

describe("SetToken [ @ovm ]", () => {
  let owner: Account;
  let manager: Account;
  let mockBasicIssuanceModule: Account;
  let mockLockedModule: Account;
  let unaddedModule: Account;
  let pendingModule: Account;
  let testAccount: Account;
  let deployer: DeployHelper;
  let setTokenInternalUtils: SetTokenInternalUtils;
  let setTokenDataUtils: SetTokenDataUtils;

  beforeEach(async () => {
    [
      owner,
      manager,
      mockBasicIssuanceModule,
      mockLockedModule,
    ] = await getOptimismAccounts();

    deployer = new DeployHelper(owner.wallet);

    setTokenInternalUtils = await deployer.core.deploySetTokenInternalUtils();
    setTokenDataUtils = await deployer.core.deploySetTokenDataUtils();
  });

  describe("constructor", async () => {
    let firstComponent: StandardTokenMock;
    let firstComponentUnits: BigNumber;
    let secondComponent: StandardTokenMock;
    let secondComponentUnits: BigNumber;
    let controller: Controller;

    let subjectComponentAddresses: Address[];
    let subjectUnits: BigNumber[];
    let subjectModuleAddresses: Address[];
    let subjectControllerAddress: Address;
    let subjectManagerAddress: Address;
    let subjectName: string;
    let subjectSymbol: string;

    beforeEach(async () => {
      firstComponent = await deployer.mocks.deployTokenMock(manager.address);
      firstComponentUnits = ether(1);
      secondComponent = await deployer.mocks.deployTokenMock(manager.address);
      secondComponentUnits = ether(2);
      controller = await deployer.core.deployController(owner.address);

      subjectComponentAddresses = [firstComponent.address, secondComponent.address];
      subjectUnits = [firstComponentUnits, secondComponentUnits];
      subjectModuleAddresses = [mockBasicIssuanceModule.address, mockLockedModule.address];
      subjectControllerAddress = controller.address;
      subjectManagerAddress = manager.address;
      subjectName = "TestSetToken";
      subjectSymbol = "SET";
    });

    async function subject(): Promise<any> {
      return await deployer.core.deploySetToken(
        subjectComponentAddresses,
        subjectUnits,
        subjectModuleAddresses,
        subjectControllerAddress,
        subjectManagerAddress,
        subjectName,
        subjectSymbol,
        setTokenInternalUtils.address
      );
    }

    it("should have the correct name, symbol, controller, multiplier, and manager", async () => {
      const setToken = await subject();

      const name = await setToken.name();
      const symbol = await setToken.symbol();
      const controllerAddress = await setToken.controller();
      const managerAddress = await setToken.manager();
      const positionMultiplier = await setToken.positionMultiplier();
      expect(name).to.eq(subjectName);
      expect(symbol).to.eq(subjectSymbol);
      expect(controllerAddress).to.eq(subjectControllerAddress);
      expect(managerAddress).to.eq(subjectManagerAddress);
      expect(positionMultiplier).to.eq(PRECISE_UNIT);
    });

    it("should have the correct components and componentPositions", async () => {
      const setToken = await subject();

      const firstComponent = await setToken.components(0);
      const secondComponent = await setToken.components(1);

      const firstComponentVirtualUnit =
        await setTokenDataUtils["getDefaultPositionRealUnit(address,address)"](setToken.address, firstComponent);
      const secondComponentVirtualUnit =
        await setTokenDataUtils["getDefaultPositionRealUnit(address,address)"](setToken.address, secondComponent);

      const firstComponentExternalModules = await setToken.getExternalPositionModules(firstComponent);
      const secondComponentExternalModules = await setToken.getExternalPositionModules(secondComponent);

      expect(firstComponentVirtualUnit).to.eq(firstComponentUnits);
      expect(firstComponentExternalModules.length).to.eq(ZERO);
      expect(secondComponentVirtualUnit).to.eq(secondComponentUnits);
      expect(secondComponentExternalModules.length).to.eq(ZERO);
    });

    it("should have the 0 modules initialized", async () => {
      const setToken = await subject();

      const modules = await setToken.getModules();
      expect(modules.length).to.eq(0);
    });

    it("should have the correct modules in pending state", async () => {
      const setToken = await subject();

      const mockBasicIssuanceModuleState = await setToken.moduleStates(mockBasicIssuanceModule.address);
      const mockLockedModuleState = await setToken.moduleStates(mockLockedModule.address);
      expect(mockBasicIssuanceModuleState).to.eq(MODULE_STATE["PENDING"]);
      expect(mockLockedModuleState).to.eq(MODULE_STATE["PENDING"]);
    });
  });

  context("when there is a deployed SetToken", async () => {
    let setToken: SetToken;

    let controller: Controller;
    let firstComponent: StandardTokenMock;
    let firstComponentUnits: BigNumber;
    let secondComponent: StandardTokenMock;
    let secondComponentUnits: BigNumber;

    let subjectCaller: Account;

    let components: Address[];
    let units: BigNumber[];
    let modules: Address[];
    let name: string;
    let symbol: string;

    beforeEach(async () => {
      [
        owner,
        manager,
        mockBasicIssuanceModule,
        mockLockedModule,
        unaddedModule,
        pendingModule,
        testAccount,
      ] = await getOptimismAccounts();

      deployer = new DeployHelper(owner.wallet);

      firstComponent = await deployer.mocks.deployTokenMock(manager.address);
      firstComponentUnits = ether(1);
      secondComponent = await deployer.mocks.deployTokenMock(manager.address);
      secondComponentUnits = ether(2);

      controller = await deployer.core.deployController(owner.address);
      components = [firstComponent.address, secondComponent.address];
      units = [firstComponentUnits, secondComponentUnits];
      modules = [mockBasicIssuanceModule.address, mockLockedModule.address];
      name = "TestSetToken";
      symbol = "SET";

      await controller.initialize([], modules, [], []);

      setToken = await deployer.core.deploySetToken(
        components,
        units,
        modules,
        controller.address,
        manager.address,
        name,
        symbol,
        setTokenInternalUtils.address
      );

      setToken = setToken.connect(mockBasicIssuanceModule.wallet);
      await setToken.initializeModule();

      setToken = setToken.connect(mockLockedModule.wallet);
      await setToken.initializeModule();
    });

    describe("#invoke", async () => {
      let testSpender: Address;
      let testQuantity: string;

      let subjectTargetAddress: Address;
      let subjectValue: BigNumber;
      let subjectCallData: string;

      beforeEach(async () => {
        testSpender = owner.address;
        testQuantity = "100";
        const approveTransferCallData = web3.eth.abi.encodeFunctionCall({
          name: "approve",
          type: "function",
          inputs: [
            { type: "address", name: "spender" },
            { type: "uint256", name: "amount" },
          ],
        }, [testSpender, testQuantity]);

        subjectCallData = approveTransferCallData;
        subjectValue = ether(0);
        subjectTargetAddress = firstComponent.address;
        subjectCaller = mockBasicIssuanceModule;
      });

      async function subject(): Promise<any> {
        setToken = setToken.connect(subjectCaller.wallet);
        return setToken.invoke(
          subjectTargetAddress,
          subjectValue,
          subjectCallData
        );
      }

      // Skipped tests check the ETH balance of the caller and this is aliased to a WETH precompile on the OVM
      // On the evm this reverts with: "function call to a non-contract account"
      it("should set the SetTokens approval balance to the spender [ @hardhat-evm-skip ]", async function() {
        await subject();

        const allowance = await firstComponent.allowance(setToken.address, testSpender);
        expect(allowance).to.eq(testQuantity);
      });

      it("should emit the Invoked event [ @hardhat-evm-skip ]", async function() {
        // Success return value
        const expectedReturnValue = "0x0000000000000000000000000000000000000000000000000000000000000001";

        await expect(subject()).to.emit(setToken, "Invoked").withArgs(
          subjectTargetAddress,
          subjectValue,
          subjectCallData,
          expectedReturnValue
        );
      });

      describe("when the module is locked", async () => {
        beforeEach(async () => {
          await setToken.connect(mockLockedModule.wallet).lock();

          subjectCaller = mockLockedModule;
        });

        // Skipped tests check the ETH balance of the caller and this is aliased to a WETH precompile on the OVM
        // On the evm this reverts with: "function call to a non-contract account"
        it("should set the SetTokens approval balance to the spender [ @hardhat-evm-skip ]", async function() {
          await subject();

          const allowance = await firstComponent.allowance(setToken.address, testSpender);
          expect(allowance).to.eq(testQuantity);
        });
      });

      describe("when sending ETH to a SetToken contract", async () => {
        let transferBalance: BigNumber;
        let setTokenReceivingETH: SetToken;

        beforeEach(async () => {
          setTokenReceivingETH = await deployer.core.deploySetToken(
            components,
            units,
            modules,
            controller.address,
            manager.address,
            name,
            symbol,
            setTokenInternalUtils.address
          );

          transferBalance = ether(2);

          await transferWeth(manager.wallet, setToken.address, transferBalance);

          subjectCallData = EMPTY_BYTES;
          subjectTargetAddress = setTokenReceivingETH.address;
          subjectValue = transferBalance;
        });

        // Skipped tests check the ETH balance of the caller and this is aliased to a WETH precompile on the OVM
        // On the evm this reverts with: "function call to a non-contract account"
        it("should properly receive and send ETH [ @hardhat-evm-skip ]", async function() {
          const startingTokenBalance = await getWethBalance(owner.wallet, subjectTargetAddress);

          await subject();

          const endingTokenBalance = await getWethBalance(owner.wallet, subjectTargetAddress);
          const expectedEndingTokenBalance = startingTokenBalance.add(subjectValue);
          expect(endingTokenBalance).to.eq(expectedEndingTokenBalance);
        });
      });

      describe("when the caller is not a module", async () => {
        beforeEach(async () => {
          subjectCaller = testAccount;
        });

        it("should revert", async () => {
          await assertRevertOVM(subject(), "Only the module can call", provider);
        });
      });

      describe("when the module is locked [ @optimism-client-skip ]", async () => {
        beforeEach(async () => {
          setToken = setToken.connect(mockLockedModule.wallet);

          await setToken.lock();
        });

        it("should revert", async () => {
          await assertRevertOVM(subject(), "Locked: only locker can call", provider);
        });
      });

      // shouldRevertIfModuleDisabled(subject);
    });

    describe("#addComponent [ @optimism-client-skip ]", async () => {
      let subjectComponent: Address;

      beforeEach(async () => {
        subjectComponent = testAccount.address;

        subjectCaller = mockBasicIssuanceModule;
      });

      async function subject(): Promise<any> {
        return setToken.connect(subjectCaller.wallet).addComponent(subjectComponent);
      }

      it("should add to the component array", async () => {
        const prevComponents = await setToken.getComponents();

        await subject();

        const components = await setToken.getComponents();

        const expectedComponent = await setToken.components(components.length - 1);
        expect(expectedComponent).to.eq(subjectComponent);

        expect(components.length).to.eq(prevComponents.length + 1);
      });

      // Event commented out to reduce contract size
      it.skip("should emit the ComponentAdded event", async () => {
        await expect(subject()).to.emit(setToken, "ComponentAdded").withArgs(subjectComponent);
      });

      describe("when there is a an already existing component", async () => {
        beforeEach(async () => {
          await setToken.addComponent(subjectComponent);
        });

        it("should revert", async () => {
          await assertRevertOVM(subject(), "Must not be component", provider);
        });
      });

      shouldRevertIfModuleDisabled(subject);
      shouldRevertIfCallerIsNotModule(subject);
      shouldRevertIfSetTokenIsLocked(subject);
    });

    describe("#removeComponent [ @optimism-client-skip ]", async () => {
      let subjectComponent: Address;

      beforeEach(async () => {
        subjectComponent = firstComponent.address;
        subjectCaller = mockBasicIssuanceModule;
      });

      async function subject(): Promise<any> {
        return setToken.connect(subjectCaller.wallet).removeComponent(subjectComponent);
      }

      it("should remove from the component array", async () => {
        const prevComponents = await setToken.getComponents();

        await subject();

        const components = await setToken.getComponents();
        expect(components.length).to.eq(prevComponents.length - 1);
      });

      // Event commented out to reduce contract size
      it.skip("should emit the ComponentRemoved event", async () => {
        await expect(subject()).to.emit(setToken, "ComponentRemoved").withArgs(subjectComponent);
      });

      shouldRevertIfModuleDisabled(subject);
      shouldRevertIfCallerIsNotModule(subject);
      shouldRevertIfSetTokenIsLocked(subject);
    });

    describe("#editDefaultPositionUnit [ @optimism-client-skip ]", async () => {
      let subjectComponent: Address;
      let subjectNewUnit: BigNumber;

      const multiplier = ether(2);

      beforeEach(async () => {
        subjectComponent = firstComponent.address;
        subjectNewUnit = ether(4);

        subjectCaller = mockBasicIssuanceModule;

        await setToken.connect(subjectCaller.wallet).editPositionMultiplier(multiplier);
      });

      async function subject(): Promise<any> {
        return setToken.connect(subjectCaller.wallet).editDefaultPositionUnit(subjectComponent, subjectNewUnit);
      }

      it("should properly edit the default position unit", async () => {
        await subject();

        const retrievedUnit =
          await setTokenDataUtils["getDefaultPositionRealUnit(address,address)"](setToken.address, subjectComponent);
        expect(retrievedUnit).to.eq(subjectNewUnit);
      });

      it("should emit the DefaultPositionUnitEdited event", async () => {
        await expect(subject()).to.emit(setToken, "DefaultPositionUnitEdited").withArgs(
          subjectComponent,
          subjectNewUnit
        );
      });

      describe("when the value is 0", async () => {
        beforeEach(async () => {
          subjectNewUnit = ZERO;
        });

        it("should properly edit the default position unit", async () => {
          await subject();

          const retrievedUnit =
            await setTokenDataUtils["getDefaultPositionRealUnit(address,address)"](setToken.address, subjectComponent);
          expect(retrievedUnit).to.eq(subjectNewUnit);
        });
      });

      describe("when the conversion results in a virtual unit of 0", async () => {
        beforeEach(async () => {
          subjectNewUnit = BigNumber.from(10 ** 2);
          const hugePositionMultiplier = ether(1000000);
          await setToken.connect(subjectCaller.wallet).editPositionMultiplier(hugePositionMultiplier);
        });

        it("should revert", async () => {
          await assertRevertOVM(subject(), "Virtual unit conversion invalid", provider);
        });
      });

      shouldRevertIfModuleDisabled(subject);
      shouldRevertIfCallerIsNotModule(subject);
      shouldRevertIfSetTokenIsLocked(subject);
    });

    describe("#addExternalPositionModule [ @optimism-client-skip ]", async () => {
      let subjectComponent: Address;
      let subjectExternalModule: Address;

      beforeEach(async () => {
        subjectComponent = firstComponent.address;
        subjectExternalModule = mockBasicIssuanceModule.address;

        subjectCaller = mockBasicIssuanceModule;
      });

      async function subject(): Promise<any> {
        return setToken.connect(subjectCaller.wallet).addExternalPositionModule(subjectComponent, subjectExternalModule);
      }

      it("should properly add the module", async () => {
        const prevModules = await setToken.getExternalPositionModules(subjectComponent);

        await subject();

        const retrievedExternalModules = await setToken.getExternalPositionModules(subjectComponent);

        const expectedModule = retrievedExternalModules[retrievedExternalModules.length - 1];
        expect(expectedModule).to.eq(subjectExternalModule);
        expect(retrievedExternalModules.length).to.eq(prevModules.length + 1);
      });

      // Event commented out to reduce contract size
      it.skip("should emit the PositionModuleAdded event", async () => {
        await expect(subject()).to.emit(setToken, "PositionModuleAdded").withArgs(subjectComponent, subjectExternalModule);
      });

      describe("when there is a an already existing component", async () => {
        beforeEach(async () => {
          await setToken.addExternalPositionModule(subjectComponent, subjectExternalModule);
        });

        it("should revert", async () => {
          await assertRevertOVM(subject(), "Module already added", provider);
        });
      });

      shouldRevertIfModuleDisabled(subject);
      shouldRevertIfCallerIsNotModule(subject);
      shouldRevertIfSetTokenIsLocked(subject);
    });

    describe("#removeExternalPositionModule [ @optimism-client-skip ]", async () => {
      let subjectComponent: Address;
      let subjectExternalModule: Address;

      beforeEach(async () => {
        subjectComponent = firstComponent.address;
        subjectExternalModule = mockBasicIssuanceModule.address;

        subjectCaller = mockBasicIssuanceModule;

        await setToken.connect(subjectCaller.wallet).addExternalPositionModule(subjectComponent, subjectExternalModule);
      });

      async function subject(): Promise<any> {
        return setToken.connect(subjectCaller.wallet).removeExternalPositionModule(subjectComponent, subjectExternalModule);
      }

      it("should properly remove the module from externalPositionModules", async () => {
        const prevModules = await setToken.getExternalPositionModules(subjectComponent);

        await subject();

        const retrievedExternalModules = await setToken.getExternalPositionModules(subjectComponent);
        expect(retrievedExternalModules.length).to.eq(prevModules.length - 1);
      });

      it("should zero out the data in externalPositions", async () => {
        await subject();

        const retrievedRealUnit = await setTokenDataUtils["getExternalPositionRealUnit(address,address,address)"](
          setToken.address,
          subjectComponent,
          subjectExternalModule
        );
        const retrievedData = await setToken.getExternalPositionData(subjectComponent, subjectExternalModule);
        expect(retrievedRealUnit).to.eq(ZERO);
        expect(retrievedData).to.eq(EMPTY_BYTES);
      });

      // Event commmented out to reduce contract size
      it.skip("should emit the PositionModuleRemoved event", async () => {
        await expect(subject()).to.emit(setToken, "PositionModuleRemoved").withArgs(subjectComponent, subjectExternalModule);
      });

      shouldRevertIfModuleDisabled(subject);
      shouldRevertIfCallerIsNotModule(subject);
      shouldRevertIfSetTokenIsLocked(subject);
    });

    describe("#editExternalPositionUnit [ @optimism-client-skip ]", async () => {
      let subjectComponent: Address;
      let subjectModule: Address;
      let subjectNewUnit: BigNumber;

      const multiplier = ether(2);

      beforeEach(async () => {
        subjectComponent = firstComponent.address;
        subjectModule = await getRandomAddress();
        subjectNewUnit = ether(4);

        subjectCaller = mockBasicIssuanceModule;

        await setToken.connect(subjectCaller.wallet).editPositionMultiplier(multiplier);
      });

      async function subject(): Promise<any> {
        return setToken.connect(subjectCaller.wallet).editExternalPositionUnit(
          subjectComponent,
          subjectModule,
          subjectNewUnit
        );
      }

      it("should properly edit the external position unit", async () => {
        await subject();

        const retrievedUnit = await setTokenDataUtils["getExternalPositionRealUnit(address,address,address)"](
          setToken.address,
          subjectComponent,
          subjectModule
        );

        expect(retrievedUnit).to.eq(subjectNewUnit);
      });

      it("should emit the ExternalPositionUnitEdited event", async () => {
        await expect(subject()).to.emit(setToken, "ExternalPositionUnitEdited").withArgs(
          subjectComponent,
          subjectModule,
          subjectNewUnit
        );
      });

      describe("when the conversion results in a virtual unit of -1", async () => {
        let hugePositionMultiplier: BigNumber;

        beforeEach(async () => {
          subjectNewUnit = BigNumber.from(10 ** 2).mul(-1);
          hugePositionMultiplier = ether(10000000000000000);
          await setToken.connect(subjectCaller.wallet).editPositionMultiplier(hugePositionMultiplier);
        });

        it("should return a conservative value", async () => {
          await subject();

          const expectedStoredVirtualUnit = divDown(subjectNewUnit.mul(PRECISE_UNIT), hugePositionMultiplier);
          const expectedExternalRealUnit = divDown(expectedStoredVirtualUnit.mul(hugePositionMultiplier), PRECISE_UNIT);

          const retrievedUnit = await setTokenDataUtils["getExternalPositionRealUnit(address,address,address)"](
            setToken.address,
            subjectComponent,
            subjectModule
          );
          expect(retrievedUnit).to.eq(expectedExternalRealUnit);
        });
      });

      describe("when the value is 0", async () => {
        beforeEach(async () => {
          subjectNewUnit = ZERO;
        });

        it("should properly edit the default position unit", async () => {
          await subject();

          const retrievedUnit = await setTokenDataUtils["getExternalPositionRealUnit(address,address,address)"](
            setToken.address,
            subjectComponent,
            subjectModule
          );

          expect(retrievedUnit).to.eq(subjectNewUnit);
        });
      });

      describe("when the conversion results in a virtual unit of 0 (positive)", async () => {
        beforeEach(async () => {
          subjectNewUnit = BigNumber.from(10 ** 2);
          const hugePositionMultiplier = ether(1000000);
          await setToken.connect(subjectCaller.wallet).editPositionMultiplier(hugePositionMultiplier);
        });

        it("should revert", async () => {
          await assertRevertOVM(subject(), "Virtual unit conversion invalid", provider);
        });
      });

      shouldRevertIfModuleDisabled(subject);
      shouldRevertIfCallerIsNotModule(subject);
      shouldRevertIfSetTokenIsLocked(subject);
    });

    describe("#editExternalPositionData [ @optimism-client-skip ]", async () => {
      let subjectComponent: Address;
      let subjectModule: Address;
      let subjectData: string;

      beforeEach(async () => {
        subjectComponent = firstComponent.address;
        subjectModule = await getRandomAddress();
        subjectData = "0x11";

        subjectCaller = mockBasicIssuanceModule;
      });

      async function subject(): Promise<any> {
        return setToken.connect(subjectCaller.wallet).editExternalPositionData(
          subjectComponent,
          subjectModule,
          subjectData
        );
      }

      it("should properly edit the external position unit", async () => {
        await subject();

        const data = await setToken.getExternalPositionData(subjectComponent, subjectModule);
        expect(data).to.eq(subjectData);
      });

      it("should emit the ExternalPositionDataEdited event", async () => {
        await expect(subject()).to.emit(setToken, "ExternalPositionDataEdited").withArgs(
          subjectComponent,
          subjectModule,
          subjectData
        );
      });

      shouldRevertIfModuleDisabled(subject);
      shouldRevertIfCallerIsNotModule(subject);
      shouldRevertIfSetTokenIsLocked(subject);
    });

    describe("#editPositionMultiplier [ @optimism-client-skip ]", async () => {
      let subjectPositionMultiplier: BigNumber;

      beforeEach(async () => {
        subjectCaller = mockBasicIssuanceModule;
        subjectPositionMultiplier = ether(2);
      });

      async function subject(): Promise<any> {
        return setToken.connect(subjectCaller.wallet).editPositionMultiplier(subjectPositionMultiplier);
      }

      it("should update the multiplier", async () => {
        await subject();

        const newMultiplier = await setToken.positionMultiplier();
        expect(newMultiplier).to.eq(subjectPositionMultiplier);
      });

      it("should update the real position units", async () => {
        await subject();

        const firstPositionRealUnits = await setTokenDataUtils["getDefaultPositionRealUnit(address,address)"](
          setToken.address,
          firstComponent.address
        );
        const expectedRealUnit = preciseMul(firstComponentUnits, ether(2));
        expect(firstPositionRealUnits).to.eq(expectedRealUnit);
      });

      it("should emit the correct PositionMultiplierEdited event", async () => {
        await expect(subject()).to.emit(setToken, "PositionMultiplierEdited").withArgs(subjectPositionMultiplier);
      });

      describe("when the value is 0", async () => {
        beforeEach(async () => {
          subjectPositionMultiplier = ZERO;
        });

        it("should revert", async () => {
          await assertRevertOVM(subject(), "New multiplier too small", provider);
        });
      });

      describe("when the positionMultiplier results in a real position unit = 0", async () => {
        // When positionMultiplier x unit is < 10^18
        beforeEach(async () => {
          // Set a really small value
          const smallPositionUnitValue = BigNumber.from(10 ** 2);
          await setToken.editDefaultPositionUnit(firstComponent.address, smallPositionUnitValue);

          subjectPositionMultiplier = ONE;
        });

        it("should revert", async () => {
          await assertRevertOVM(subject(), "New multiplier too small", provider);
        });
      });

      describe("when the caller is not a module", async () => {
        beforeEach(async () => {
          subjectCaller = await getRandomAccount();
        });

        it("should revert", async () => {
          await assertRevertOVM(subject(), "Only the module can call", provider);
        });
      });

      describe("when the module is locked", async () => {
        beforeEach(async () => {
          setToken = setToken.connect(mockLockedModule.wallet);

          await setToken.lock();
        });

        it("should revert", async () => {
          await assertRevertOVM(subject(), "Locked: only locker can call", provider);
        });
      });

      shouldRevertIfModuleDisabled(subject);
    });

    describe("#lock [ @optimism-client-skip ]", async () => {
      beforeEach(async () => {
        subjectCaller = mockBasicIssuanceModule;
      });

      async function subject(): Promise<any> {
        setToken = setToken.connect(subjectCaller.wallet);
        return setToken.lock();
      }

      it("should lock the SetToken", async () => {
        await subject();

        const isLocked = await setToken.isLocked();
        expect(isLocked).to.eq(true);
      });

      it("should set the locker to the module", async () => {
        await subject();

        const lockerAddress = await setToken.locker();
        expect(lockerAddress).to.eq(mockBasicIssuanceModule.address);
      });

      describe("when the caller is not a module", async () => {
        beforeEach(async () => {
          subjectCaller = await getRandomAccount();
        });

        it("should revert", async () => {
          await assertRevertOVM(subject(), "Only the module can call", provider);
        });
      });

      describe("when the SetToken is already locked", async () => {
        beforeEach(async () => {
          setToken = setToken.connect(subjectCaller.wallet);
          await setToken.lock();
        });

        it("should revert", async () => {
          await assertRevertOVM(subject(), "Must not be locked", provider);
        });
      });

      shouldRevertIfModuleDisabled(subject);
    });

    describe("#unlock [ @optimism-client-skip ]", async () => {
      beforeEach(async () => {
        setToken = setToken.connect(mockBasicIssuanceModule.wallet);
        await setToken.lock();

        subjectCaller = mockBasicIssuanceModule;
      });

      async function subject(): Promise<any> {
        setToken = setToken.connect(subjectCaller.wallet);
        return setToken.unlock();
      }

      it("should put the SetToken in an unlocked state", async () => {
        await subject();

        const isLocked = await setToken.isLocked();
        expect(isLocked).to.eq(false);
      });

      it("should clear the locker", async () => {
        await subject();

        const lockerAddress = await setToken.locker();
        expect(lockerAddress).to.eq(ADDRESS_ZERO);
      });

      describe("when the caller is not a module", async () => {
        beforeEach(async () => {
          subjectCaller = await getRandomAccount();
        });

        it("should revert", async () => {
          await assertRevertOVM(subject(), "Only the module can call", provider);
        });
      });

      describe("when the caller is a module but not the locker", async () => {
        beforeEach(async () => {
          subjectCaller = mockLockedModule;

        });

        it("should revert", async () => {
          await assertRevertOVM(subject(), "Must be locker", provider);
        });
      });

      describe("when the SetToken is already unlocked", async () => {
        beforeEach(async () => {
          await setToken.unlock();
        });

        it("should revert", async () => {
          await assertRevertOVM(subject(), "Must be locked", provider);
        });
      });

      shouldRevertIfModuleDisabled(subject);
    });

    describe("#mint", async () => {
      let subjectMintee: Address;
      let subjectQuantity: BigNumber;

      beforeEach(async () => {
        subjectMintee = manager.address;
        subjectQuantity = ether(3);
        subjectCaller = mockBasicIssuanceModule;
      });

      async function subject(): Promise<any> {
        setToken = setToken.connect(subjectCaller.wallet);
        return setToken.mint(subjectMintee, subjectQuantity);
      }

      it("should mint the correct quantity to the mintee", async () => {
        await subject();

        const newSetBalance = await setToken.balanceOf(subjectMintee);
        expect(newSetBalance).to.eq(subjectQuantity);
      });

      describe("when the module is locked [ @optimism-client-skip ]", async () => {
        beforeEach(async () => {
          setToken = setToken.connect(mockLockedModule.wallet);

          await setToken.lock();

          subjectCaller = mockLockedModule;
        });

        it("should mint the correct quantity to the mintee", async () => {
          await subject();

          const newSetBalance = await setToken.balanceOf(subjectMintee);
          expect(newSetBalance).to.eq(subjectQuantity);
        });
      });

      describe("when the caller is not a module [ @optimism-client-skip ]", async () => {
        beforeEach(async () => {
          subjectCaller = await getRandomAccount();
        });

        it("should revert", async () => {
          await assertRevertOVM(subject(), "Only the module can call", provider);
        });
      });

      describe("when the module is locked [ @optimism-client-skip ]", async () => {
        beforeEach(async () => {
          setToken = setToken.connect(mockLockedModule.wallet);

          await setToken.lock();
        });

        it("should revert", async () => {
          await assertRevertOVM(subject(), "Locked: only locker can call", provider);
        });
      });

      // shouldRevertIfModuleDisabled(subject);
    });

    describe("#burn", async () => {
      const mintQuantity = ether(4);

      let subjectMintee: Address;
      let subjectQuantity: BigNumber;

      beforeEach(async () => {
        subjectCaller = mockBasicIssuanceModule;
        subjectMintee = manager.address;
        subjectQuantity = ether(3);

        setToken = setToken.connect(subjectCaller.wallet);
        await setToken.mint(subjectMintee, mintQuantity);
      });

      async function subject(): Promise<any> {
        setToken = setToken.connect(subjectCaller.wallet);
        return setToken.burn(subjectMintee, subjectQuantity);
      }

      it("should reduce the correct quantity of the mintee", async () => {
        await subject();

        const newSetBalance = await setToken.balanceOf(subjectMintee);
        expect(newSetBalance).to.eq(mintQuantity.sub(subjectQuantity));
      });

      describe("when the module is locked [ @optimism-client-skip ]", async () => {
        beforeEach(async () => {
          setToken = setToken.connect(mockLockedModule.wallet);

          await setToken.lock();

          subjectCaller = mockLockedModule;
        });

        it("should reduce the correct quantity from the mintee", async () => {
          await subject();

          const newSetBalance = await setToken.balanceOf(subjectMintee);
          expect(newSetBalance).to.eq(mintQuantity.sub(subjectQuantity));
        });
      });

      describe("when the caller is not a module [ @optimism-client-skip ]", async () => {
        beforeEach(async () => {
          subjectCaller = await getRandomAccount();
        });

        it("should revert", async () => {
          await assertRevertOVM(subject(), "Only the module can call", provider);
        });
      });

      describe("when the module is locked [ @optimism-client-skip ]", async () => {
        beforeEach(async () => {
          setToken = setToken.connect(mockLockedModule.wallet);

          await setToken.lock();
        });

        it("should revert", async () => {
          await assertRevertOVM(subject(), "Locked: only locker can call", provider);
        });
      });

      // shouldRevertIfModuleDisabled(subject);
    });

    describe("#addModule [ @optimism-client-skip ]", async () => {
      let subjectModule: Address;

      beforeEach(async () => {
        await controller.addModule(testAccount.address);

        subjectModule = testAccount.address;
        subjectCaller = manager;
      });

      async function subject(): Promise<any> {
        setToken = setToken.connect(subjectCaller.wallet);
        return setToken.addModule(subjectModule);
      }

      it("should change the state to pending", async () => {
        await subject();

        const moduleState = await setToken.moduleStates(subjectModule);
        expect(moduleState).to.eq(MODULE_STATE["PENDING"]);
      });

      // Event commented out to reduce contract size
      it.skip("should emit the ModuleAdded event", async () => {
        await expect(subject()).to.emit(setToken, "ModuleAdded").withArgs(subjectModule);
      });


      describe("when the caller is not the manager", async () => {
        beforeEach(async () => {
          subjectCaller = await getRandomAccount();
        });

        it("should revert", async () => {
          await assertRevertOVM(subject(), "Only manager can call", provider);
        });
      });

      describe("when the module is already added", async () => {
        beforeEach(async () => {
          subjectModule = mockBasicIssuanceModule.address;
        });

        it("should revert", async () => {
          await assertRevertOVM(subject(), "Module must not be added", provider);
        });
      });

      describe("when the module is not enabled", async () => {
        beforeEach(async () => {
          await controller.removeModule(subjectModule);
        });

        it("should revert", async () => {
          await assertRevertOVM(subject(), "Must be enabled on Controller", provider);
        });
      });
    });

    describe("#removeModule [ @optimism-client-skip ]", async () => {
      let moduleMock: ModuleBaseMock;

      let subjectModule: Address;

      beforeEach(async () => {

        moduleMock = await deployer.mocks.deployModuleBaseMock(
          controller.address,
          setTokenDataUtils.address
        );
        await controller.addModule(moduleMock.address);

        setToken = setToken.connect(manager.wallet);
        await setToken.addModule(moduleMock.address);
        await moduleMock.initializeModuleOnSet(setToken.address);

        subjectModule = moduleMock.address;
        subjectCaller = manager;
      });

      async function subject(): Promise<any> {
        setToken = setToken.connect(subjectCaller.wallet);
        return setToken.removeModule(subjectModule);
      }

      it("should call the module", async () => {
        await subject();

        const isCalled = await moduleMock.removed();
        expect(isCalled).to.be.true;
      });

      it("should change the state to NONE", async () => {
        await subject();

        const moduleState = await setToken.moduleStates(subjectModule);
        expect(moduleState).to.eq(MODULE_STATE["NONE"]);
      });

      it("should remove from the modules array", async () => {
        await subject();

        const modules = await setToken.getModules();
        expect(modules).to.not.contain(subjectModule);
      });

      // Event commented out to reduce contract size
      it.skip("should emit the ModuleRemoved event", async () => {
        await expect(subject()).to.emit(setToken, "ModuleRemoved").withArgs(subjectModule);
      });

      describe("when the caller is not the manager", async () => {
        beforeEach(async () => {
          subjectCaller = await getRandomAccount();
        });

        it("should revert", async () => {
          await assertRevertOVM(subject(), "Only manager can call", provider);
        });
      });

      describe("when the module is not added", async () => {
        beforeEach(async () => {
          setToken = setToken.connect(manager.wallet);
          await controller.addModule(pendingModule.address);
          subjectModule = unaddedModule.address;
        });

        it("should revert", async () => {
          await assertRevertOVM(subject(), "Module must be added", provider);
        });
      });

      describe("when the module is pending", async () => {
        beforeEach(async () => {
          await controller.addModule(pendingModule.address);
          await setToken.connect(manager.wallet).addModule(pendingModule.address);
          subjectModule = pendingModule.address;
        });

        it("should revert", async () => {
          await assertRevertOVM(subject(), "Module must be added", provider);
        });
      });

      describe("when the module is locked", async () => {
        beforeEach(async () => {
          await setToken.connect(mockLockedModule.wallet).lock();
        });

        it("should revert", async () => {
          await assertRevertOVM(subject(), "Only when unlocked", provider);
        });
      });
    });

    describe("#removePendingModule [ @optimism-client-skip ]", async () => {
      let moduleMock: ModuleBaseMock;

      let subjectModule: Address;

      beforeEach(async () => {
        moduleMock = await deployer.mocks.deployModuleBaseMock(
          controller.address,
          setTokenDataUtils.address
        );
        await controller.addModule(moduleMock.address);

        setToken = setToken.connect(manager.wallet);
        await setToken.addModule(moduleMock.address);

        subjectModule = moduleMock.address;
        subjectCaller = manager;
      });

      async function subject(): Promise<any> {
        setToken = setToken.connect(subjectCaller.wallet);
        return setToken.removePendingModule(subjectModule);
      }

      it("should change the state to NONE", async () => {
        await subject();

        const moduleState = await setToken.moduleStates(subjectModule);
        expect(moduleState).to.eq(MODULE_STATE["NONE"]);
      });

      // Event commented out to reduce contract size
      it.skip("should emit the PendingModuleRemoved event", async () => {
        await expect(subject()).to.emit(setToken, "PendingModuleRemoved").withArgs(subjectModule);
      });

      describe("when the caller is not the manager", async () => {
        beforeEach(async () => {
          subjectCaller = await getRandomAccount();
        });

        it("should revert", async () => {
          await assertRevertOVM(subject(), "Only manager can call", provider);
        });
      });

      describe("when the module is not pending", async () => {
        beforeEach(async () => {
          subjectModule = unaddedModule.address;
        });

        it("should revert", async () => {
          await assertRevertOVM(subject(), "Module must be pending", provider);
        });
      });

      describe("when the module is locked", async () => {
        beforeEach(async () => {
          await setToken.connect(mockLockedModule.wallet).lock();
        });

        it("should revert", async () => {
          await assertRevertOVM(subject(), "Only when unlocked", provider);
        });
      });
    });

    describe("#setManager [ @optimism-client-skip ]", async () => {
      let subjectManager: Address;

      beforeEach(async () => {
        subjectManager = testAccount.address;
        subjectCaller = manager;
      });

      async function subject(): Promise<any> {
        setToken = setToken.connect(subjectCaller.wallet);
        return setToken.setManager(subjectManager);
      }

      it("should change the manager", async () => {
        await subject();

        const managerAddress = await setToken.manager();
        expect(managerAddress).to.eq(subjectManager);
      });

      // Event commented out to reduce contract size
      it.skip("should emit the ManagerEdited event", async () => {
        await expect(subject()).to.emit(setToken, "ManagerEdited").withArgs(subjectManager, manager.address);
      });

      describe("when the caller is not the manager", async () => {
        beforeEach(async () => {
          subjectCaller = await getRandomAccount();
        });

        it("should revert", async () => {
          await assertRevertOVM(subject(), "Only manager can call", provider);
        });
      });

      describe("when the module is locked", async () => {
        beforeEach(async () => {
          await setToken.connect(mockLockedModule.wallet).lock();
        });

        it("should revert", async () => {
          await assertRevertOVM(subject(), "Only when unlocked", provider);
        });
      });
    });

    describe("#initializeModule [ @optimism-client-skip ]", async () => {
      let subjectModule: Address;

      beforeEach(async () => {
        subjectModule = testAccount.address;
        subjectCaller = testAccount;

        setToken = setToken.connect(manager.wallet);

        await controller.addModule(subjectModule);
        await setToken.addModule(subjectModule);
      });

      async function subject(): Promise<any> {
        setToken = setToken.connect(subjectCaller.wallet);
        return setToken.initializeModule();
      }

      it("should add the module to the modules list", async () => {
        await subject();

        const moduleList = await setToken.getModules();
        expect(moduleList).to.include(subjectModule);
      });

      it("should update the module state to initialized", async () => {
        await subject();

        const moduleState = await setToken.moduleStates(subjectModule);
        expect(moduleState).to.eq(MODULE_STATE["INITIALIZED"]);
      });

      // Event commented out to reduce contract size
      it.skip("should emit the ModuleInitialized event", async () => {
        await expect(subject()).to.emit(setToken, "ModuleInitialized").withArgs(subjectModule);
      });

      describe("when the module is not added", async () => {
        beforeEach(async () => {
          subjectCaller = owner;
        });

        it("should revert", async () => {
          await assertRevertOVM(subject(), "Module must be pending", provider);
        });
      });

      describe("when the module already added", async () => {
        beforeEach(async () => {
          subjectCaller = mockBasicIssuanceModule;
        });

        it("should revert", async () => {
          await assertRevertOVM(subject(), "Module must be pending", provider);
        });
      });

      describe("when the module is locked", async () => {
        beforeEach(async () => {
          setToken = setToken.connect(mockBasicIssuanceModule.wallet);
          await setToken.lock();
        });

        it("should revert", async () => {
          await assertRevertOVM(subject(), "Only when unlocked", provider);
        });
      });
    });

    describe("#getDefaultPositionRealUnit [ @optimism-client-skip ]", async () => {
      let subjectComponent: Address;

      const multiplier: BigNumber = ether(2);

      beforeEach(async () => {
        subjectComponent = secondComponent.address;
        await setToken.connect(mockBasicIssuanceModule.wallet).editPositionMultiplier(multiplier);
      });

      async function subject(): Promise<BigNumber> {
        return await setTokenDataUtils["getDefaultPositionRealUnit(address,address)"](
          setToken.address,
          subjectComponent
        );
      }

      it("should return the correct components", async () => {
        const realUnit = await subject();

        const expectedResult = preciseMul(secondComponentUnits, multiplier);
        expect(realUnit).to.eq(expectedResult);
      });
    });

    describe("#getExternalPositionRealUnit [ @optimism-client-skip ]", async () => {
      let subjectComponent: Address;
      let subjectModule: Address;

      let externalUnitToAdd: BigNumber;

      const multiplier: BigNumber = ether(2);

      beforeEach(async () => {
        subjectComponent = secondComponent.address;
        subjectModule = mockBasicIssuanceModule.address;

        externalUnitToAdd = ether(9);

        await setToken.connect(mockBasicIssuanceModule.wallet).editPositionMultiplier(multiplier);

        await setToken.connect(mockBasicIssuanceModule.wallet).editExternalPositionUnit(
          subjectComponent,
          subjectModule,
          externalUnitToAdd
        );
      });

      async function subject(): Promise<BigNumber> {
        return await setTokenDataUtils["getExternalPositionRealUnit(address,address,address)"](
          setToken.address,
          subjectComponent,
          subjectModule
        );
      }

      it("should return the correct components", async () => {
        const externalModuleUnit = await subject();
        expect(externalModuleUnit).to.eq(externalUnitToAdd);
      });
    });

    describe("#getComponents", async () => {
      async function subject(): Promise<Address[]> {
        return await setToken.getComponents();
      }

      it("should return the correct components", async () => {
        const componentAddresses = await subject();

        expect(JSON.stringify(componentAddresses)).to.eq(JSON.stringify(components));
      });
    });

    describe("#getExternalPositionModules [ @optimism-client-skip ]", async () => {
      let subjectComponent: Address;

      beforeEach(async () => {
        subjectComponent = secondComponent.address;

        await setToken.connect(mockBasicIssuanceModule.wallet).addExternalPositionModule(
          subjectComponent,
          mockBasicIssuanceModule.address
        );
        await setToken.connect(mockBasicIssuanceModule.wallet).addExternalPositionModule(
          subjectComponent,
          mockLockedModule.address
        );
      });

      async function subject(): Promise<Address[]> {
        return await setToken.getExternalPositionModules(subjectComponent);
      }

      it("should return the correct modules", async () => {
        const modules = await subject();
        expect(JSON.stringify(modules)).to.eq(JSON.stringify(modules));
      });
    });

    describe("#getExternalPositionData [ @optimism-client-skip ]", async () => {
      let subjectComponent: Address;
      let subjectModule: Address;

      let expectedData: string;

      beforeEach(async () => {
        subjectComponent = firstComponent.address;
        subjectModule = mockBasicIssuanceModule.address;
        subjectCaller = mockBasicIssuanceModule;

        expectedData = "0x11";

        await setToken.connect(subjectCaller.wallet).editExternalPositionData(
          subjectComponent,
          subjectModule,
          expectedData
        );
      });

      async function subject(): Promise<string> {
        return setToken.getExternalPositionData(
          subjectComponent,
          subjectModule,
        );
      }

      it("should properly edit the external position unit", async () => {
        const data = await subject();
        expect(data).to.eq(expectedData);
      });
    });

    describe("#getPositions [ @optimism-client-skip ]", async () => {
      let subjectSetToken: SetToken;

      const subjectMultiplier = ether(0.5);

      beforeEach(async () => {
        subjectSetToken = setToken;

        await subjectSetToken.connect(mockBasicIssuanceModule.wallet).editPositionMultiplier(subjectMultiplier);
      });

      async function subject(): Promise<Position[]> {
        return await setTokenDataUtils.getPositions(subjectSetToken.address);
      }

      it("should return the correct Positions", async () => {
        const positions = await subject();

        const expectedPositionOneRealUnit = preciseMul(units[0], subjectMultiplier);
        const expectedPositionTwoRealUnit = preciseMul(units[1], subjectMultiplier);

        const firstPosition = positions[0];
        expect(firstPosition.component).to.eq(firstComponent.address);
        expect(firstPosition.unit).to.eq(expectedPositionOneRealUnit);
        expect(firstPosition.module).to.eq(ADDRESS_ZERO);
        expect(firstPosition.positionState).to.eq(POSITION_STATE["DEFAULT"]);
        expect(firstPosition.data).to.eq(EMPTY_BYTES);

        const secondPosition = positions[1];
        expect(secondPosition.component).to.eq(secondComponent.address);
        expect(secondPosition.unit).to.eq(expectedPositionTwoRealUnit);
        expect(secondPosition.module).to.eq(ADDRESS_ZERO);
        expect(secondPosition.positionState).to.eq(POSITION_STATE["DEFAULT"]);
        expect(secondPosition.data).to.eq(EMPTY_BYTES);
      });

      describe("when the SetToken has an external position and the Default virtual unit is 0", async () => {
        let externalComponent: Address;
        let externalModule: Address;
        let externalRealUnit: BigNumber;
        let externalData: string;

        beforeEach(async () => {
          externalComponent = (await deployer.mocks.deployTokenMock(manager.address)).address;
          externalModule = mockBasicIssuanceModule.address;
          externalRealUnit = ether(-1);
          externalData = "0x11";
          // Add a component to the end.
          await subjectSetToken.connect(mockBasicIssuanceModule.wallet).addComponent(externalComponent);
          // Add module to the component
          await subjectSetToken.connect(mockBasicIssuanceModule.wallet).addExternalPositionModule(
            externalComponent,
            externalModule
          );
          await subjectSetToken.connect(mockBasicIssuanceModule.wallet).editExternalPositionUnit(
            externalComponent,
            externalModule,
            externalRealUnit,
          );

          await subjectSetToken.connect(mockBasicIssuanceModule.wallet).editExternalPositionData(
            externalComponent,
            externalModule,
            externalData,
          );
        });

        it("should have the correct number of positions", async () => {
          const positions = await subject();
          expect(positions.length).to.eq(3);
        });

        it("should have the correct data for the new position", async () => {
          const positions = await subject();

          const thirdPosition = positions[2];
          expect(thirdPosition.component).to.eq(externalComponent);
          expect(thirdPosition.unit).to.eq(externalRealUnit);
          expect(thirdPosition.module).to.eq(externalModule);
          expect(thirdPosition.positionState).to.eq(POSITION_STATE["EXTERNAL"]);
          expect(thirdPosition.data).to.eq(externalData);
        });
      });
    });

    describe("#getModules [ @optimism-client-skip ]", async () => {
      async function subject(): Promise<Address[]> {
        return await setToken.getModules();
      }

      it("should return the correct modules", async () => {
        const moduleAddresses = await subject();

        expect(JSON.stringify(moduleAddresses)).to.eq(JSON.stringify(modules));
      });
    });

    describe("#getTotalComponentRealUnits", async () => {
      let subjectComponent: Address;
      let externalModuleOne: Address;
      let externalModuleTwo: Address;
      let externalRealUnitOne: BigNumber;
      let externalRealUnitTwo: BigNumber;

      beforeEach(async () => {
        externalModuleOne = mockBasicIssuanceModule.address;
        externalModuleTwo = mockLockedModule.address;
        externalRealUnitOne = ether(6);
        externalRealUnitTwo = ether(-1);

        subjectComponent = firstComponent.address;

        await setToken.connect(mockBasicIssuanceModule.wallet).addExternalPositionModule(
          subjectComponent,
          externalModuleOne
        );
        await setToken.connect(mockBasicIssuanceModule.wallet).editExternalPositionUnit(
          subjectComponent,
          externalModuleOne,
          externalRealUnitOne,
        );
        await setToken.connect(mockBasicIssuanceModule.wallet).addExternalPositionModule(
          subjectComponent,
          externalModuleTwo
        );
        await setToken.connect(mockBasicIssuanceModule.wallet).editExternalPositionUnit(
          subjectComponent,
          externalModuleTwo,
          externalRealUnitTwo,
        );
      });

      async function subject(): Promise<BigNumber> {
        return await setTokenDataUtils.getTotalComponentRealUnits(setToken.address, subjectComponent);
      }

      it("should return the correct value", async () => {
        const totalRealUnits = await subject();

        const expectedResult = firstComponentUnits.add(externalRealUnitOne).add(externalRealUnitTwo);
        expect(totalRealUnits).to.eq(expectedResult);
      });
    });

    describe("#isInitializedModule [ @optimism-client-skip ]", async () => {
      let subjectModule: Address;

      beforeEach(async () => {
        subjectModule = modules[0];
      });

      async function subject(): Promise<boolean> {
        return await setTokenDataUtils["isInitializedModule(address,address)"](setToken.address, subjectModule);
      }

      it("should return the correct state", async () => {
        const isInitializedModule = await subject();

        expect(isInitializedModule).to.eq(true);
      });
    });

    function shouldRevertIfModuleDisabled(subject: any) {
      describe("when the calling module is disabled", async () => {
        beforeEach(async () => {
          await controller.removeModule(mockBasicIssuanceModule.address);
        });


        it("should revert", async () => {
          await assertRevertOVM(subject(), "Module must be enabled on controller", provider);
        });
      });
    }

    function shouldRevertIfCallerIsNotModule(subject: any) {
      describe("when the caller is not a module", async () => {
        beforeEach(async () => {
          subjectCaller = await getRandomAccount();
        });

        it("should revert", async () => {
          await assertRevertOVM(subject(), "Only the module can call", provider);
        });
      });
    }

    function shouldRevertIfSetTokenIsLocked(subject: any) {
      describe("when the SetToken is locked", async () => {
        beforeEach(async () => {
          await setToken.connect(mockLockedModule.wallet).lock();
        });

        it("should revert", async () => {
          await assertRevertOVM(subject(), "Locked: only locker can call", provider);
        });
      });
    }
  });
});
