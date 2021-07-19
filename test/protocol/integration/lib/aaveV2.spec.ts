import "module-alias/register";
import { BigNumber } from "@ethersproject/bignumber";

import { Address } from "@utils/types";
import { Account } from "@utils/test/types";
import { AaveV2, AaveV2Mock, InvokeMock, SetToken } from "@utils/contracts";
import DeployHelper from "@utils/deploys";
import {
  ether,
} from "@utils/index";
import {
  getAccounts,
  getSystemFixture,
  getWaffleExpect,
  addSnapshotBeforeRestoreAfterEach,
  getAaveV2Fixture,
} from "@utils/test/index";
import { AaveV2Fixture, SystemFixture } from "@utils/fixtures";
import { ADDRESS_ZERO, MAX_UINT_256, ONE, ZERO } from "@utils/constants";
import { AaveV2AToken } from "@typechain/AaveV2AToken";
import { AaveV2StableDebtToken } from "@typechain/AaveV2StableDebtToken";
import { AaveV2VariableDebtToken } from "@typechain/AaveV2VariableDebtToken";

const expect = getWaffleExpect();

describe("AaveV2", () => {
  let owner: Account;
  let deployer: DeployHelper;

  let aaveLib: AaveV2;
  let aaveLibMock: AaveV2Mock;
  let invokeLibMock: InvokeMock;
  let setup: SystemFixture;
  let aaveSetup: AaveV2Fixture;

  let aWETH: AaveV2AToken;
  let stableDebtDAI: AaveV2StableDebtToken;
  let variableDebtDAI: AaveV2VariableDebtToken;

  let setToken: SetToken;

  const stableInterestRateMode = ONE;
  const variableInterestRateMode = BigNumber.from(2);

  before(async () => {
    [
      owner,
    ] = await getAccounts();

    deployer = new DeployHelper(owner.wallet);
    setup = getSystemFixture(owner.address);
    await setup.initialize();

    aaveLib = await deployer.libraries.deployAaveV2();
    aaveLibMock = await deployer.mocks.deployAaveV2Mock(
      "contracts/protocol/integration/lib/AaveV2.sol:AaveV2",
      aaveLib.address
    );
    invokeLibMock = await deployer.mocks.deployInvokeMock();
    await setup.controller.addModule(aaveLibMock.address);
    await setup.controller.addModule(invokeLibMock.address);

    aaveSetup = getAaveV2Fixture(owner.address);
    await aaveSetup.initialize(setup.weth.address, setup.dai.address);

    [aWETH, , ] = await aaveSetup.deployWethReserve();
    [, stableDebtDAI, variableDebtDAI] = await aaveSetup.deployDaiReserve();

    // Create liquidity
    await setup.weth.connect(owner.wallet).approve(aaveSetup.lendingPool.address, ether(100));
    await aaveSetup.lendingPool.connect(owner.wallet).deposit(
      setup.weth.address,
      ether(100),
      owner.address,
      ZERO
    );
    await setup.dai.connect(owner.wallet).approve(aaveSetup.lendingPool.address, ether(1000));
    await aaveSetup.lendingPool.connect(owner.wallet).deposit(
      setup.dai.address,
      ether(1000),
      owner.address,
      ZERO
    );

    setToken = await setup.createSetToken(
      [setup.dai.address, setup.weth.address],
      [ether(1000), ether(10)],
      [setup.issuanceModule.address, aaveLibMock.address, invokeLibMock.address]
    );

    await setup.issuanceModule.initialize(setToken.address, ADDRESS_ZERO);
    await invokeLibMock.initializeModuleOnSet(setToken.address);
    await aaveLibMock.initializeModuleOnSet(setToken.address);

    await setup.dai.approve(setup.issuanceModule.address, MAX_UINT_256);
    await setup.weth.approve(setup.issuanceModule.address, MAX_UINT_256);
    await setup.issuanceModule.issue(setToken.address, ether(1), owner.address);
  });

  addSnapshotBeforeRestoreAfterEach();

  describe("#getDepositCalldata", async () => {
    let subjectAsset: Address;
    let subjectAmountNotional: BigNumber;
    let subjectOnBehalfOf: Address;
    let subjectReferralCode: BigNumber;
    let subjectLendingPool: Address;

    beforeEach(async () => {
      subjectAsset = setup.weth.address;
      subjectAmountNotional = ether(1);
      subjectOnBehalfOf = owner.address;
      subjectReferralCode = ZERO;
      subjectLendingPool = aaveSetup.lendingPool.address;
    });

    async function subject(): Promise<any> {
      return await aaveLibMock.testGetDepositCalldata(
        subjectAsset,
        subjectAmountNotional,
        subjectOnBehalfOf,
        subjectReferralCode,
        subjectLendingPool
      );
    }

    it("should get correct data", async () => {
      const [target, value, calldata] = await subject();
      const expectedCalldata = aaveSetup.lendingPool.interface.encodeFunctionData("deposit", [
        subjectAsset,
        subjectAmountNotional,
        subjectOnBehalfOf,
        subjectReferralCode,
      ]);

      expect(target).to.eq(subjectLendingPool);
      expect(value).to.eq(ZERO);
      expect(calldata).to.eq(expectedCalldata);
    });
  });

  describe("#invokeDeposit", async () => {
    let subjectSetToken: Address;
    let subjectAsset: Address;
    let subjectAmountNotional: BigNumber;
    let subjectLendingPool: Address;

    beforeEach(async () => {
      await invokeLibMock.testInvokeApprove(setToken.address, setup.weth.address, aaveSetup.lendingPool.address, MAX_UINT_256);

      subjectSetToken = setToken.address;
      subjectAsset = setup.weth.address;
      subjectAmountNotional = ether(1);
      subjectLendingPool = aaveSetup.lendingPool.address;
    });

    async function subject(): Promise<any> {
      return await aaveLibMock.testInvokeDeposit(
        subjectSetToken,
        subjectAsset,
        subjectAmountNotional,
        subjectLendingPool
      );
    }

    it("should mint aWETH", async () => {
      const previousATokenBalance = await aWETH.balanceOf(setToken.address);
      await subject();
      const currentATokenBalance = await aWETH.balanceOf(setToken.address);
      const expectedATokenBalance = previousATokenBalance.add(subjectAmountNotional);
      expect(currentATokenBalance).to.eq(expectedATokenBalance);
    });
  });

  describe("#getUseReserveAsCollateralCalldata", async () => {
    let subjectAsset: Address;
    let subjectUseAsCollateral: boolean;
    let subjectLendingPool: Address;

    beforeEach(async () => {
      subjectAsset = setup.weth.address;
      subjectUseAsCollateral = true;
      subjectLendingPool = aaveSetup.lendingPool.address;
    });

    async function subject(): Promise<any> {
      return await aaveLibMock.testGetUseReserveAsCollateralCalldata(
        subjectAsset,
        subjectUseAsCollateral,
        subjectLendingPool
      );
    }

    it("should get correct data", async () => {
      const [target, value, calldata] = await subject();
      const expectedCalldata = aaveSetup.lendingPool.interface.encodeFunctionData("setUserUseReserveAsCollateral", [
        subjectAsset,
        subjectUseAsCollateral,
      ]);

      expect(target).to.eq(subjectLendingPool);
      expect(value).to.eq(ZERO);
      expect(calldata).to.eq(expectedCalldata);
    });

    describe("when use as collateral is false", async () => {
      beforeEach(async () => {
        subjectUseAsCollateral = false;
      });

      it("should get correct data", async () => {
        const [target, value, calldata] = await subject();
        const expectedCalldata = aaveSetup.lendingPool.interface.encodeFunctionData("setUserUseReserveAsCollateral", [
          subjectAsset,
          subjectUseAsCollateral,
        ]);

        expect(target).to.eq(subjectLendingPool);
        expect(value).to.eq(ZERO);
        expect(calldata).to.eq(expectedCalldata);
      });
    });
  });

  describe("#invokeUseReserveAsCollateral", async () => {
    let subjectSetToken: Address;
    let subjectAsset: Address;
    let subjectUseAsCollateral: boolean;
    let subjectLendingPool: Address;

    beforeEach(async () => {
      await invokeLibMock.testInvokeApprove(setToken.address, setup.weth.address, aaveSetup.lendingPool.address, MAX_UINT_256);
      await aaveLibMock.testInvokeDeposit(setToken.address, setup.weth.address, ether(1), aaveSetup.lendingPool.address);

      subjectSetToken = setToken.address;
      subjectAsset = setup.weth.address;
      subjectUseAsCollateral = true;
      subjectLendingPool = aaveSetup.lendingPool.address;
    });

    async function subject(): Promise<any> {
      return await aaveLibMock.testInvokeUseReserveAsCollateral(
        subjectSetToken,
        subjectAsset,
        subjectUseAsCollateral,
        subjectLendingPool
      );
    }

    it("should set use reserve as collateral by SetToken to true", async () => {
      await subject();
      const currentUseAsCollateral = (await aaveSetup.protocolDataProvider.getUserReserveData(
        subjectAsset,
        subjectSetToken
      )).usageAsCollateralEnabled;
      const expectedUseAsCollateral = true;
      expect(currentUseAsCollateral).to.eq(expectedUseAsCollateral);
    });

    describe("when use as collateral is false", async () => {
      beforeEach(async () => {
        subjectUseAsCollateral = false;
      });

      it("should set use reserve as collateral by SetToken to false", async () => {
        await subject();
        const currentUseAsCollateral = (await aaveSetup.protocolDataProvider.getUserReserveData(
          subjectAsset,
          subjectSetToken
        )).usageAsCollateralEnabled;
        const expectedUseAsCollateral = false;
        expect(currentUseAsCollateral).to.eq(expectedUseAsCollateral);
      });
    });
  });

  describe("#getWithdrawCalldata", async () => {
    let subjectAsset: Address;
    let subjectAmountNotional: BigNumber;
    let subjectReceiver: Address;
    let subjectLendingPool: Address;

    beforeEach(async () => {
      subjectAsset = setup.weth.address;
      subjectAmountNotional = ether(1);
      subjectReceiver = owner.address;
      subjectLendingPool = aaveSetup.lendingPool.address;
    });

    async function subject(): Promise<any> {
      return await aaveLibMock.testGetWithdrawCalldata(
        subjectAsset,
        subjectAmountNotional,
        subjectReceiver,
        subjectLendingPool
      );
    }

    it("should get correct data", async () => {
      const [target, value, calldata] = await subject();
      const expectedCalldata = aaveSetup.lendingPool.interface.encodeFunctionData("withdraw", [
        subjectAsset,
        subjectAmountNotional,
        subjectReceiver,
      ]);

      expect(target).to.eq(subjectLendingPool);
      expect(value).to.eq(ZERO);
      expect(calldata).to.eq(expectedCalldata);
    });
  });

  describe("#invokeWithdraw", async () => {
    let subjectSetToken: Address;
    let subjectAsset: Address;
    let subjectAmountNotional: BigNumber;
    let subjectLendingPool: Address;

    beforeEach(async () => {
      await invokeLibMock.testInvokeApprove(setToken.address, setup.weth.address, aaveSetup.lendingPool.address, MAX_UINT_256);
      await aaveLibMock.testInvokeDeposit(setToken.address, setup.weth.address, ether(1), aaveSetup.lendingPool.address);

      subjectSetToken = setToken.address;
      subjectAsset = setup.weth.address;
      subjectAmountNotional = ether(1);
      subjectLendingPool = aaveSetup.lendingPool.address;
    });

    async function subject(): Promise<any> {
      return await aaveLibMock.testInvokeWithdraw(
        subjectSetToken,
        subjectAsset,
        subjectAmountNotional,
        subjectLendingPool
      );
    }

    it("should burn aWETH and return underlying WETH", async () => {
      const previousATokenBalance = await aWETH.balanceOf(setToken.address);
      const previousUnderlyingBalance = await setup.weth.balanceOf(setToken.address);
      await subject();
      const currentATokenBalance = await aWETH.balanceOf(setToken.address);
      const currentUnderlyingBalance = await setup.weth.balanceOf(setToken.address);

      const expectedATokenBalance = previousATokenBalance.sub(subjectAmountNotional);
      const expectedUnderlyingBalance = previousUnderlyingBalance.add(subjectAmountNotional);	// 1:1 ratio for aTokena & underlying

      expect(currentATokenBalance).to.eq(expectedATokenBalance);
      expect(currentUnderlyingBalance).to.eq(expectedUnderlyingBalance);
    });
  });

  describe("#getBorrowCalldata", async () => {
    let subjectAsset: Address;
    let subjectAmountNotional: BigNumber;
    let subjectInterestRateMode: BigNumber;
    let subjectReferralCode: BigNumber;
    let subjectOnBehalfOf: Address;
    let subjectLendingPool: Address;

    beforeEach(async () => {
      subjectAsset = setup.weth.address;
      subjectAmountNotional = ether(1);
      subjectInterestRateMode = stableInterestRateMode;
      subjectOnBehalfOf = owner.address;
      subjectReferralCode = ZERO;
      subjectLendingPool = aaveSetup.lendingPool.address;
    });

    async function subject(): Promise<any> {
      return await aaveLibMock.testGetBorrowCalldata(
        subjectAsset,
        subjectAmountNotional,
        subjectInterestRateMode,
        subjectReferralCode,
        subjectOnBehalfOf,
        subjectLendingPool
      );
    }

    it("should get correct data", async () => {
      const [target, value, calldata] = await subject();
      const expectedCalldata = aaveSetup.lendingPool.interface.encodeFunctionData("borrow", [
        subjectAsset,
        subjectAmountNotional,
        subjectInterestRateMode,
        subjectReferralCode,
        subjectOnBehalfOf,
      ]);

      expect(target).to.eq(subjectLendingPool);
      expect(value).to.eq(ZERO);
      expect(calldata).to.eq(expectedCalldata);
    });
  });

  describe("#invokeBorrow", async () => {
    let subjectSetToken: Address;
    let subjectAsset: Address;
    let subjectAmountNotional: BigNumber;
    let subjectInterestRateMode: BigNumber;
    let subjectLendingPool: Address;

    beforeEach(async () => {
      await invokeLibMock.testInvokeApprove(setToken.address, setup.weth.address, aaveSetup.lendingPool.address, MAX_UINT_256);
      await aaveLibMock.testInvokeDeposit(setToken.address, setup.weth.address, ether(1), aaveSetup.lendingPool.address);
      await aaveLibMock.testInvokeUseReserveAsCollateral(setToken.address, setup.weth.address, true, aaveSetup.lendingPool.address);

      subjectSetToken = setToken.address;
      subjectAsset = setup.dai.address;
      subjectAmountNotional = ether(100);
      subjectLendingPool = aaveSetup.lendingPool.address;
    });

    async function subject(): Promise<any> {
      return await aaveLibMock.testInvokeBorrow(
        subjectSetToken,
        subjectAsset,
        subjectAmountNotional,
        subjectInterestRateMode,
        subjectLendingPool
      );
    }

    describe("when selected intereset rate mode is stable", async () => {
      beforeEach(async () => {
        subjectInterestRateMode = stableInterestRateMode;
      });

      it("should mint stableDebtDAI", async () => {
        const previousDebtTokenBalance = await stableDebtDAI.balanceOf(setToken.address);
        await subject();
        const currentDebtTokenBalance = await stableDebtDAI.balanceOf(setToken.address);
        const expectedDebtTokenBalance = previousDebtTokenBalance.add(subjectAmountNotional);
        expect(currentDebtTokenBalance).to.eq(expectedDebtTokenBalance);
      });
    });

    describe("when selected intereset rate mode is variable", async () => {
      beforeEach(async () => {
        subjectInterestRateMode = variableInterestRateMode;
      });

      it("should mint variableDebtDAI", async () => {
        const previousDebtTokenBalance = await variableDebtDAI.balanceOf(setToken.address);
        await subject();
        const currentDebtTokenBalance = await variableDebtDAI.balanceOf(setToken.address);
        const expectedDebtTokenBalance = previousDebtTokenBalance.add(subjectAmountNotional);
        expect(currentDebtTokenBalance).to.eq(expectedDebtTokenBalance);
      });
    });
  });

  describe("#getRepayCalldata", async () => {
    let subjectAsset: Address;
    let subjectAmountNotional: BigNumber;
    let subjectOnBehalfOf: Address;
    let subjectInterestRateMode: BigNumber;
    let subjectLendingPool: Address;

    beforeEach(async () => {
      subjectAsset = setup.weth.address;
      subjectAmountNotional = ether(1);
      subjectOnBehalfOf = owner.address;
      subjectInterestRateMode = variableInterestRateMode;
      subjectLendingPool = aaveSetup.lendingPool.address;
    });

    async function subject(): Promise<any> {
      return await aaveLibMock.testGetRepayCalldata(
        subjectAsset,
        subjectAmountNotional,
        subjectInterestRateMode,
        subjectOnBehalfOf,
        subjectLendingPool
      );
    }

    it("should get correct data", async () => {
      const [target, value, calldata] = await subject();
      const expectedCalldata = aaveSetup.lendingPool.interface.encodeFunctionData("repay", [
        subjectAsset,
        subjectAmountNotional,
        subjectInterestRateMode,
        subjectOnBehalfOf,
      ]);

      expect(target).to.eq(subjectLendingPool);
      expect(value).to.eq(ZERO);
      expect(calldata).to.eq(expectedCalldata);
    });
  });

  describe("#invokeRepay", async () => {
    let subjectSetToken: Address;
    let subjectAsset: Address;
    let subjectAmountNotional: BigNumber;
    let subjectInterestRateMode: BigNumber;
    let subjectLendingPool: Address;

    beforeEach(async () => {
      await invokeLibMock.testInvokeApprove(setToken.address, setup.weth.address, aaveSetup.lendingPool.address, MAX_UINT_256);
      await aaveLibMock.testInvokeDeposit(setToken.address, setup.weth.address, ether(1), aaveSetup.lendingPool.address);
      await aaveLibMock.testInvokeUseReserveAsCollateral(setToken.address, setup.weth.address, true, aaveSetup.lendingPool.address);
      await invokeLibMock.testInvokeApprove(setToken.address, setup.dai.address, aaveSetup.lendingPool.address, MAX_UINT_256); 	// for repaying

      subjectSetToken = setToken.address;
      subjectAsset = setup.dai.address;
      subjectAmountNotional = ether(100);
      subjectLendingPool = aaveSetup.lendingPool.address;
    });

    async function subject(): Promise<any> {
      return await aaveLibMock.testInvokeRepay(
        subjectSetToken,
        subjectAsset,
        subjectAmountNotional,
        subjectInterestRateMode,
        subjectLendingPool
      );
    }

    describe("when selected intereset rate mode is stable", async () => {
      beforeEach(async () => {
        await aaveLibMock.testInvokeBorrow(
          subjectSetToken,
          subjectAsset,
          subjectAmountNotional,
          stableInterestRateMode,		// stable mode
          subjectLendingPool
        );

        subjectInterestRateMode = stableInterestRateMode;
      });

      it("should repay DAI and burn stableDebtDAI", async () => {
        // const previousDebtTokenBalance = await stableDebtDAI.balanceOf(setToken.address);
        const previousUnderlyingBalance = await setup.dai.balanceOf(setToken.address);
        await subject();
        // const currentDebtTokenBalance = await stableDebtDAI.balanceOf(setToken.address);
        const currentUnderlyingBalance = await setup.dai.balanceOf(setToken.address);

        // const expectedDebtTokenBalance = previousDebtTokenBalance.sub(subjectAmountNotional);
        const expectedUnderlyingBalance = previousUnderlyingBalance.sub(subjectAmountNotional);

        // expect(currentDebtTokenBalance).to.eq(expectedDebtTokenBalance);
        expect(currentUnderlyingBalance).to.eq(expectedUnderlyingBalance);
      });
    });

    describe("when selected intereset rate mode is variable", async () => {
      beforeEach(async () => {
        await aaveLibMock.testInvokeBorrow(
          subjectSetToken,
          subjectAsset,
          subjectAmountNotional,
          variableInterestRateMode,		// variable mode
          subjectLendingPool
        );

        subjectInterestRateMode = variableInterestRateMode;
      });

      it("should repay DAI and burn variableDebtDAI", async () => {
        // const previousDebtTokenBalance = await variableDebtDAI.balanceOf(setToken.address);
        const previousUnderlyingBalance = await setup.dai.balanceOf(setToken.address);
        await subject();
        // const currentDebtTokenBalance = await variableDebtDAI.balanceOf(setToken.address);
        const currentUnderlyingBalance = await setup.dai.balanceOf(setToken.address);

        // const expectedDebtTokenBalance = previousDebtTokenBalance.sub(subjectAmountNotional);
        const expectedUnderlyingBalance = previousUnderlyingBalance.sub(subjectAmountNotional);

        // expect(currentDebtTokenBalance).to.eq(expectedDebtTokenBalance);
        expect(currentUnderlyingBalance).to.eq(expectedUnderlyingBalance);
      });
    });
  });

  describe("#getSwapBorrowRateModeCalldata", async () => {
    let subjectAsset: Address;
    let subjectRateMode: BigNumber;
    let subjectLendingPool: Address;

    beforeEach(async () => {
      subjectAsset = setup.weth.address;
      subjectRateMode = stableInterestRateMode;
      subjectLendingPool = aaveSetup.lendingPool.address;
    });

    async function subject(): Promise<any> {
      return await aaveLibMock.testGetSwapBorrowRateModeCalldata(subjectAsset, subjectRateMode, subjectLendingPool);
    }

    it("should get correct data", async () => {
      const [target, value, calldata] = await subject();
      const expectedCalldata = aaveSetup.lendingPool.interface.encodeFunctionData("swapBorrowRateMode", [
        subjectAsset,
        subjectRateMode,
      ]);

      expect(target).to.eq(subjectLendingPool);
      expect(value).to.eq(ZERO);
      expect(calldata).to.eq(expectedCalldata);
    });

    describe("when borrow rate mode is variable", async () => {
      beforeEach(async () => {
        subjectRateMode = variableInterestRateMode;
      });

      it("should get correct data", async () => {
        const [target, value, calldata] = await subject();
        const expectedCalldata = aaveSetup.lendingPool.interface.encodeFunctionData("swapBorrowRateMode", [
          subjectAsset,
          subjectRateMode,
        ]);

        expect(target).to.eq(subjectLendingPool);
        expect(value).to.eq(ZERO);
        expect(calldata).to.eq(expectedCalldata);
      });
    });
  });

  describe("#invokeSwapBorrowRateMode", async () => {
    let subjectSetToken: Address;
    let subjectAsset: Address;
    let subjectRateMode: BigNumber;
    let subjectLendingPool: Address;

    beforeEach(async () => {
      subjectSetToken = setToken.address;
      subjectAsset = setup.dai.address;
      subjectLendingPool = aaveSetup.lendingPool.address;
    });

    async function subject(): Promise<any> {
      return await aaveLibMock.testInvokeSwapBorrowRateMode(
        subjectSetToken,
        subjectAsset,
        subjectRateMode,
        subjectLendingPool
      );
    }

    describe("when moving to stable mode from variable mode", async () => {
      beforeEach(async () => {
        await invokeLibMock.testInvokeApprove(setToken.address, setup.weth.address, aaveSetup.lendingPool.address, MAX_UINT_256);
        await aaveLibMock.testInvokeDeposit(setToken.address, setup.weth.address, ether(1), aaveSetup.lendingPool.address);
        await aaveLibMock.testInvokeUseReserveAsCollateral(setToken.address, setup.weth.address, true, aaveSetup.lendingPool.address);
        // Borrow DAI in variable rate mode
        await aaveLibMock.testInvokeBorrow(setToken.address, setup.dai.address, ether(100), variableInterestRateMode, aaveSetup.lendingPool.address);

        subjectRateMode = variableInterestRateMode;
      });

      it("should burn stableDebtDAI and mint equivalent amount of variableDebtDAI", async () => {
        const previousStableDebtTokenBalance = await stableDebtDAI.balanceOf(setToken.address);
        await subject();
        const currentVariableDebtTokenBalance = await variableDebtDAI.balanceOf(setToken.address);

        // expect(currentStableDebtTokenBalance).to.eq(ZERO);
        expect(currentVariableDebtTokenBalance).to.eq(previousStableDebtTokenBalance);
      });
    });

    describe("when moving to variable mode from stable mode", async () => {
      beforeEach(async () => {
        await invokeLibMock.testInvokeApprove(setToken.address, setup.weth.address, aaveSetup.lendingPool.address, MAX_UINT_256);
        await aaveLibMock.testInvokeDeposit(setToken.address, setup.weth.address, ether(1), aaveSetup.lendingPool.address);
        await aaveLibMock.testInvokeUseReserveAsCollateral(setToken.address, setup.weth.address, true, aaveSetup.lendingPool.address);
        // Borrow DAI in stable rate mode
        await aaveLibMock.testInvokeBorrow(setToken.address, setup.dai.address, ether(100), stableInterestRateMode, aaveSetup.lendingPool.address);

        subjectRateMode = stableInterestRateMode;
      });

      it("should burn variableDebtDAI and mint equivalent amount of stableDebtDAI", async () => {
        const previousVariableDebtTokenBalance = await variableDebtDAI.balanceOf(setToken.address);
        await subject();
        const currentStableDebtTokenBalance = await stableDebtDAI.balanceOf(setToken.address);

        // expect(currentVariableDebtTokenBalance).to.eq(ZERO);
        expect(currentStableDebtTokenBalance).to.eq(previousVariableDebtTokenBalance);
      });
    });
  });
});