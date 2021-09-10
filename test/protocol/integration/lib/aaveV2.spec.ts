import "module-alias/register";
import { BigNumber } from "ethers";

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
  getAaveV2Fixture
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

    aWETH = aaveSetup.wethReserveTokens.aToken;
    stableDebtDAI = aaveSetup.daiReserveTokens.stableDebtToken;
    variableDebtDAI = aaveSetup.daiReserveTokens.variableDebtToken;

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
        subjectLendingPool,
        subjectAsset,
        subjectAmountNotional,
        subjectOnBehalfOf,
        subjectReferralCode
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
        subjectLendingPool,
        subjectAsset,
        subjectAmountNotional
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

  describe("#getSetUserUseReserveAsCollateralCalldata", async () => {
    let subjectAsset: Address;
    let subjectUseAsCollateral: boolean;
    let subjectLendingPool: Address;

    beforeEach(async () => {
      subjectAsset = setup.weth.address;
      subjectUseAsCollateral = true;
      subjectLendingPool = aaveSetup.lendingPool.address;
    });

    async function subject(): Promise<any> {
      return await aaveLibMock.testGetSetUserUseReserveAsCollateralCalldata(
        subjectLendingPool,
        subjectAsset,
        subjectUseAsCollateral
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

  describe("#invokeSetUserUseReserveAsCollateral", async () => {
    let subjectSetToken: Address;
    let subjectAsset: Address;
    let subjectUseAsCollateral: boolean;
    let subjectLendingPool: Address;

    beforeEach(async () => {
      await invokeLibMock.testInvokeApprove(setToken.address, setup.weth.address, aaveSetup.lendingPool.address, MAX_UINT_256);
      await aaveLibMock.testInvokeDeposit(setToken.address, aaveSetup.lendingPool.address, setup.weth.address, ether(1));

      subjectSetToken = setToken.address;
      subjectAsset = setup.weth.address;
      subjectUseAsCollateral = true;
      subjectLendingPool = aaveSetup.lendingPool.address;
    });

    async function subject(): Promise<any> {
      return await aaveLibMock.testInvokeSetUserUseReserveAsCollateral(
        subjectSetToken,
        subjectLendingPool,
        subjectAsset,
        subjectUseAsCollateral
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
        subjectLendingPool,
        subjectAsset,
        subjectAmountNotional,
        subjectReceiver
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
      await aaveLibMock.testInvokeDeposit(setToken.address, aaveSetup.lendingPool.address, setup.weth.address, ether(1));

      subjectSetToken = setToken.address;
      subjectAsset = setup.weth.address;
      subjectAmountNotional = ether(1);
      subjectLendingPool = aaveSetup.lendingPool.address;
    });

    async function subject(): Promise<any> {
      return await aaveLibMock.testInvokeWithdraw(
        subjectSetToken,
        subjectLendingPool,
        subjectAsset,
        subjectAmountNotional
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
        subjectLendingPool,
        subjectAsset,
        subjectAmountNotional,
        subjectInterestRateMode,
        subjectReferralCode,
        subjectOnBehalfOf
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
      await aaveLibMock.testInvokeDeposit(setToken.address, aaveSetup.lendingPool.address, setup.weth.address, ether(1));
      await aaveLibMock.testInvokeSetUserUseReserveAsCollateral(setToken.address, aaveSetup.lendingPool.address, setup.weth.address, true);

      subjectSetToken = setToken.address;
      subjectAsset = setup.dai.address;
      subjectAmountNotional = ether(100);
      subjectLendingPool = aaveSetup.lendingPool.address;
    });

    async function subject(): Promise<any> {
      return await aaveLibMock.testInvokeBorrow(
        subjectSetToken,
        subjectLendingPool,
        subjectAsset,
        subjectAmountNotional,
        subjectInterestRateMode
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
        subjectLendingPool,
        subjectAsset,
        subjectAmountNotional,
        subjectInterestRateMode,
        subjectOnBehalfOf
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
      await aaveLibMock.testInvokeDeposit(setToken.address, aaveSetup.lendingPool.address, setup.weth.address, ether(1));
      await aaveLibMock.testInvokeSetUserUseReserveAsCollateral(setToken.address, aaveSetup.lendingPool.address, setup.weth.address, true);
      await invokeLibMock.testInvokeApprove(setToken.address, setup.dai.address, aaveSetup.lendingPool.address, MAX_UINT_256); 	// for repaying

      subjectSetToken = setToken.address;
      subjectAsset = setup.dai.address;
      subjectAmountNotional = ether(100);
      subjectLendingPool = aaveSetup.lendingPool.address;
    });

    async function subject(): Promise<any> {
      return await aaveLibMock.testInvokeRepay(
        subjectSetToken,
        subjectLendingPool,
        subjectAsset,
        subjectAmountNotional,
        subjectInterestRateMode
      );
    }

    describe("when selected intereset rate mode is stable", async () => {
      beforeEach(async () => {
        await aaveLibMock.testInvokeBorrow(
          subjectSetToken,
          subjectLendingPool,
          subjectAsset,
          subjectAmountNotional,
          stableInterestRateMode		// stable mode
        );

        subjectInterestRateMode = stableInterestRateMode;
      });

      it("should repay DAI and burn stableDebtDAI", async () => {
        const previousUnderlyingBalance = await setup.dai.balanceOf(setToken.address);
        await subject();
        const currentUnderlyingBalance = await setup.dai.balanceOf(setToken.address);

        const expectedUnderlyingBalance = previousUnderlyingBalance.sub(subjectAmountNotional);
        expect(currentUnderlyingBalance).to.eq(expectedUnderlyingBalance);
      });
    });

    describe("when selected intereset rate mode is variable", async () => {
      beforeEach(async () => {
        await aaveLibMock.testInvokeBorrow(
          subjectSetToken,
          subjectLendingPool,
          subjectAsset,
          subjectAmountNotional,
          variableInterestRateMode		// variable mode
        );

        subjectInterestRateMode = variableInterestRateMode;
      });

      it("should repay DAI and burn variableDebtDAI", async () => {
        const previousUnderlyingBalance = await setup.dai.balanceOf(setToken.address);
        await subject();
        const currentUnderlyingBalance = await setup.dai.balanceOf(setToken.address);
        const expectedUnderlyingBalance = previousUnderlyingBalance.sub(subjectAmountNotional);
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
      return await aaveLibMock.testGetSwapBorrowRateModeCalldata(subjectLendingPool, subjectAsset, subjectRateMode);
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
      await invokeLibMock.testInvokeApprove(setToken.address, setup.weth.address, aaveSetup.lendingPool.address, MAX_UINT_256);
      await aaveLibMock.testInvokeDeposit(setToken.address, aaveSetup.lendingPool.address, setup.weth.address, ether(1));
      await aaveLibMock.testInvokeSetUserUseReserveAsCollateral(setToken.address, aaveSetup.lendingPool.address, setup.weth.address, true);

      subjectSetToken = setToken.address;
      subjectAsset = setup.dai.address;
      subjectLendingPool = aaveSetup.lendingPool.address;
    });

    async function subject(): Promise<any> {
      return await aaveLibMock.testInvokeSwapBorrowRateMode(
        subjectSetToken,
        subjectLendingPool,
        subjectAsset,
        subjectRateMode
      );
    }

    describe("when moving to stable mode from variable mode", async () => {
      beforeEach(async () => {
        // Borrow DAI in variable rate mode
        await aaveLibMock.testInvokeBorrow(setToken.address, aaveSetup.lendingPool.address, setup.dai.address, ether(100), variableInterestRateMode);

        subjectRateMode = variableInterestRateMode;
      });

      it("should burn stableDebtDAI and mint equivalent amount of variableDebtDAI", async () => {
        const previousStableDebtTokenBalance = await stableDebtDAI.balanceOf(setToken.address);
        await subject();
        const currentVariableDebtTokenBalance = await variableDebtDAI.balanceOf(setToken.address);
        expect(currentVariableDebtTokenBalance).to.eq(previousStableDebtTokenBalance);
      });
    });

    describe("when moving to variable mode from stable mode", async () => {
      beforeEach(async () => {
        // Borrow DAI in stable rate mode
        await aaveLibMock.testInvokeBorrow(setToken.address, aaveSetup.lendingPool.address, setup.dai.address, ether(100), stableInterestRateMode);

        subjectRateMode = stableInterestRateMode;
      });

      it("should burn variableDebtDAI and mint equivalent amount of stableDebtDAI", async () => {
        const previousVariableDebtTokenBalance = await variableDebtDAI.balanceOf(setToken.address);
        await subject();
        const currentStableDebtTokenBalance = await stableDebtDAI.balanceOf(setToken.address);
        expect(currentStableDebtTokenBalance).to.eq(previousVariableDebtTokenBalance);
      });
    });
  });
});
