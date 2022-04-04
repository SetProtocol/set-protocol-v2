import "module-alias/register";
import { BigNumber } from "ethers";

import { Address } from "@utils/types";
import { Account } from "@utils/test/types";
import { PerpV2LibraryV2, PerpV2LibraryV2Mock, InvokeMock, SetToken } from "@utils/contracts";
import { PerpV2BaseToken } from "@utils/contracts/perpV2";
import DeployHelper from "@utils/deploys";
import {
  ether,
} from "@utils/index";
import {
  getAccounts,
  getSystemFixture,
  getWaffleExpect,
  addSnapshotBeforeRestoreAfterEach,
  getPerpV2Fixture
} from "@utils/test/index";
import { PerpV2Fixture, SystemFixture } from "@utils/fixtures";
import { MAX_UINT_256, ZERO_BYTES, ADDRESS_ZERO, ZERO } from "@utils/constants";

const expect = getWaffleExpect();

describe("PerpV2LibraryV2", () => {
  let owner: Account;
  let maker: Account;
  let otherTrader: Account;
  let deployer: DeployHelper;

  let perpLib: PerpV2LibraryV2;
  let perpLibMock: PerpV2LibraryV2Mock;
  let invokeLibMock: InvokeMock;
  let setup: SystemFixture;
  let perpSetup: PerpV2Fixture;

  let setToken: SetToken;
  let vETH:  PerpV2BaseToken;

  before(async () => {
    [
      owner,
      maker,
      otherTrader
    ] = await getAccounts();

    deployer = new DeployHelper(owner.wallet);
    setup = getSystemFixture(owner.address);
    await setup.initialize();

    perpLib = await deployer.libraries.deployPerpV2LibraryV2();
    perpLibMock = await deployer.mocks.deployPerpV2LibraryV2Mock(
      "contracts/protocol/integration/lib/PerpV2LibraryV2.sol:PerpV2LibraryV2",
      perpLib.address
    );
    invokeLibMock = await deployer.mocks.deployInvokeMock();
    await setup.controller.addModule(perpLibMock.address);
    await setup.controller.addModule(invokeLibMock.address);

    perpSetup = getPerpV2Fixture(owner.address);
    await perpSetup.initialize(maker, otherTrader);

    vETH = perpSetup.vETH;

    // Create liquidity
    await perpSetup.initializePoolWithLiquidityWide(vETH, ether(1000), ether(10_000));

    setToken = await setup.createSetToken(
      [perpSetup.usdc.address],
      [ether(1000)],
      [setup.issuanceModule.address, perpLibMock.address, invokeLibMock.address]
    );

    await setup.issuanceModule.initialize(setToken.address, ADDRESS_ZERO);
    await invokeLibMock.initializeModuleOnSet(setToken.address);
    await perpLibMock.initializeModuleOnSet(setToken.address);

    await perpSetup.usdc.approve(setup.issuanceModule.address, MAX_UINT_256);
    await setup.issuanceModule.issue(setToken.address, ether(1), owner.address);
  });

  addSnapshotBeforeRestoreAfterEach();

  describe("#getDepositCalldata", async () => {
    let subjectAsset: Address;
    let subjectAmountNotional: BigNumber;
    let subjectVault: Address;

    beforeEach(async () => {
      subjectAsset = perpSetup.usdc.address;
      subjectAmountNotional = ether(1);
      subjectVault = perpSetup.vault.address;
    });

    async function subject(): Promise<any> {
      return await perpLibMock.testGetDepositCalldata(
        subjectVault,
        subjectAsset,
        subjectAmountNotional
      );
    }

    it("should get correct data", async () => {
      const [target, value, calldata] = await subject();
      const expectedCalldata = perpSetup.vault.interface.encodeFunctionData("deposit", [
        subjectAsset,
        subjectAmountNotional
      ]);

      expect(target).to.eq(subjectVault);
      expect(value).to.eq(ZERO);
      expect(calldata).to.eq(expectedCalldata);
    });
  });

  describe("#invokeDeposit", async () => {
    let subjectSetToken: Address;
    let subjectAsset: Address;
    let subjectAmountNotional: BigNumber;
    let subjectVault: Address;

    beforeEach(async () => {
      await invokeLibMock.testInvokeApprove(setToken.address, perpSetup.usdc.address, perpSetup.vault.address, MAX_UINT_256);

      subjectSetToken = setToken.address;
      subjectAsset = perpSetup.usdc.address;
      subjectAmountNotional = ether(1);
      subjectVault = perpSetup.vault.address;
    });

    async function subject(): Promise<any> {
      return await perpLibMock.testInvokeDeposit(
        subjectSetToken,
        subjectVault,
        subjectAsset,
        subjectAmountNotional
      );
    }

    it("should create a USDC collateral balance", async () => {
      const previousCollateralBalance = await perpSetup.vault.getBalance(setToken.address);
      await subject();
      const currentCollateralBalance = await perpSetup.vault.getBalance(setToken.address);
      const expectedCollateralBalance = previousCollateralBalance.add(subjectAmountNotional);
      expect(currentCollateralBalance).to.eq(expectedCollateralBalance);
    });
  });

  describe("#getWithdrawCalldata", async () => {
    let subjectAsset: Address;
    let subjectAmountNotional: BigNumber;
    let subjectVault: Address;

    beforeEach(async () => {
      subjectAsset = perpSetup.usdc.address;
      subjectAmountNotional = ether(1);
      subjectVault = perpSetup.vault.address;
    });

    async function subject(): Promise<any> {
      return await perpLibMock.testGetWithdrawCalldata(
        subjectVault,
        subjectAsset,
        subjectAmountNotional
      );
    }

    it("should get correct data", async () => {
      const [target, value, calldata] = await subject();
      const expectedCalldata = perpSetup.vault.interface.encodeFunctionData("withdraw", [
        subjectAsset,
        subjectAmountNotional
      ]);

      expect(target).to.eq(subjectVault);
      expect(value).to.eq(ZERO);
      expect(calldata).to.eq(expectedCalldata);
    });
  });

  describe("#invokeWithdraw", async () => {
    let subjectSetToken: Address;
    let subjectAsset: Address;
    let subjectAmountNotional: BigNumber;
    let subjectVault: Address;

    beforeEach(async () => {
      await invokeLibMock.testInvokeApprove(setToken.address, perpSetup.usdc.address, perpSetup.vault.address, MAX_UINT_256);
      await perpLibMock.testInvokeDeposit(setToken.address, perpSetup.vault.address, perpSetup.usdc.address, ether(1));

      subjectSetToken = setToken.address;
      subjectAsset = perpSetup.usdc.address;
      subjectAmountNotional = ether(1);
      subjectVault = perpSetup.vault.address;
    });

    async function subject(): Promise<any> {
      return await perpLibMock.testInvokeWithdraw(
        subjectSetToken,
        subjectVault,
        subjectAsset,
        subjectAmountNotional
      );
    }

    it("should withdraw USDC collateral and return USDC", async () => {
      const previousCollateralBalance = await perpSetup.vault.getBalance(setToken.address);
      const previousUSDCBalance = await perpSetup.usdc.balanceOf(setToken.address);
      await subject();
      const currentCollateralBalance = await perpSetup.vault.getBalance(setToken.address);
      const currentUSDCBalance = await perpSetup.usdc.balanceOf(setToken.address);

      const expectedCollateralBalance = previousCollateralBalance.sub(subjectAmountNotional);
      const expectedUSDCBalance = previousUSDCBalance.add(subjectAmountNotional);  // 1:1 ratio

      expect(currentCollateralBalance).to.eq(expectedCollateralBalance);
      expect(currentUSDCBalance).to.eq(expectedUSDCBalance);
    });
  });

  describe("#getOpenPositionCalldata", async () => {
    let subjectClearingHouse: Address;
    let subjectVETH: PerpV2BaseToken;
    let subjectIsBaseToQuote: boolean;
    let subjectIsExactInput: boolean;
    let subjectTradeQuoteAmount: BigNumber;
    let subjectOppositeAmountBound: BigNumber;
    let subjectDeadline: BigNumber;
    let subjectSqrtPriceLimitX96: BigNumber;
    let subjectReferralCode: string;

    beforeEach(async () => {
      subjectClearingHouse = perpSetup.clearingHouse.address;
      subjectVETH = vETH;
      subjectIsBaseToQuote = false;
      subjectIsExactInput = true;
      subjectTradeQuoteAmount = ether(1);
      subjectOppositeAmountBound = ZERO;
      subjectDeadline = MAX_UINT_256;
      subjectSqrtPriceLimitX96 = ZERO;
      subjectReferralCode = ZERO_BYTES;
    });

    async function subject(): Promise<any> {
      return await perpLibMock.testGetOpenPositionCalldata(
        subjectClearingHouse,
        {
          baseToken: subjectVETH.address,
          isBaseToQuote: subjectIsBaseToQuote,
          isExactInput: subjectIsExactInput,
          amount: subjectTradeQuoteAmount,
          oppositeAmountBound: subjectOppositeAmountBound,
          deadline:  subjectDeadline,
          sqrtPriceLimitX96: subjectSqrtPriceLimitX96,
          referralCode: subjectReferralCode
        }
      );
    }

    it("should get correct data", async () => {
      const [target, value, calldata] = await subject();
      const expectedCalldata = perpSetup.clearingHouse.interface.encodeFunctionData("openPosition", [
        {
          baseToken: subjectVETH.address,
          isBaseToQuote: subjectIsBaseToQuote,
          isExactInput: subjectIsExactInput,
          amount: subjectTradeQuoteAmount,
          oppositeAmountBound: subjectOppositeAmountBound,
          deadline:  subjectDeadline,
          sqrtPriceLimitX96: subjectSqrtPriceLimitX96,
          referralCode: subjectReferralCode
        }
      ]);

      expect(target).to.eq(subjectClearingHouse);
      expect(value).to.eq(ZERO);
      expect(calldata).to.eq(expectedCalldata);
    });
  });

  describe("#invokeOpenPosition", async () => {
    let subjectSetToken: Address;
    let subjectClearingHouse: Address;
    let subjectVETH: PerpV2BaseToken;
    let subjectIsBaseToQuote: boolean;
    let subjectIsExactInput: boolean;
    let subjectTradeQuoteAmount: BigNumber;
    let subjectOppositeAmountBound: BigNumber;
    let subjectDeadline: BigNumber;
    let subjectSqrtPriceLimitX96: BigNumber;
    let subjectReferralCode: string;

    beforeEach(async () => {
      await invokeLibMock.testInvokeApprove(setToken.address, perpSetup.usdc.address, perpSetup.vault.address, MAX_UINT_256);
      await perpLibMock.testInvokeDeposit(setToken.address, perpSetup.vault.address, perpSetup.usdc.address, ether(1));

      subjectSetToken = setToken.address;
      subjectClearingHouse = perpSetup.clearingHouse.address;
      subjectVETH = vETH;
      subjectIsBaseToQuote = false;
      subjectIsExactInput = true;
      subjectTradeQuoteAmount = ether(1);
      subjectOppositeAmountBound = ZERO;
      subjectDeadline = MAX_UINT_256;
      subjectSqrtPriceLimitX96 = ZERO;
      subjectReferralCode = ZERO_BYTES;
    });

    async function subject(): Promise<any> {
      return await perpLibMock.testInvokeOpenPosition(
        subjectSetToken,
        subjectClearingHouse,
        {
          baseToken: subjectVETH.address,
          isBaseToQuote: subjectIsBaseToQuote,
          isExactInput: subjectIsExactInput,
          amount: subjectTradeQuoteAmount,
          oppositeAmountBound: subjectOppositeAmountBound,
          deadline:  subjectDeadline,
          sqrtPriceLimitX96: subjectSqrtPriceLimitX96,
          referralCode: subjectReferralCode
        }
      );
    }

    it("should open a position", async () => {
      const previousBaseBalance = await perpSetup.accountBalance.getBase(setToken.address, subjectVETH.address);
      const previousQuoteBalance = await perpSetup.accountBalance.getQuote(setToken.address, subjectVETH.address);

      await subject();

      const currentBaseBalance = await perpSetup.accountBalance.getBase(setToken.address, subjectVETH.address);
      const currentQuoteBalance = await perpSetup.accountBalance.getQuote(setToken.address, subjectVETH.address);

      const expectedQuoteBalance = previousQuoteBalance.sub(subjectTradeQuoteAmount);

      expect(previousBaseBalance).to.eq(0);
      expect(currentBaseBalance).to.be.gt(previousBaseBalance);
      expect(currentQuoteBalance).to.eq(expectedQuoteBalance);
    });
  });

  describe("#getSwapCalldata", async () => {
    let subjectQuoter: Address;
    let subjectVETH: PerpV2BaseToken;
    let subjectIsBaseToQuote: boolean;
    let subjectIsExactInput: boolean;
    let subjectTradeQuoteAmount: BigNumber;
    let subjectSqrtPriceLimitX96: BigNumber;

    beforeEach(async () => {
      subjectQuoter = perpSetup.clearingHouse.address;
      subjectVETH = vETH;
      subjectIsBaseToQuote = false;
      subjectIsExactInput = true;
      subjectTradeQuoteAmount = ether(1);
      subjectSqrtPriceLimitX96 = ZERO;
    });

    async function subject(): Promise<any> {
      return await perpLibMock.testGetSwapCalldata(
        subjectQuoter,
        {
          baseToken: subjectVETH.address,
          isBaseToQuote: subjectIsBaseToQuote,
          isExactInput: subjectIsExactInput,
          amount: subjectTradeQuoteAmount,
          sqrtPriceLimitX96: subjectSqrtPriceLimitX96,
        }
      );
    }

    it("should get correct data", async () => {
      const [target, value, calldata] = await subject();
      const expectedCalldata = perpSetup.quoter.interface.encodeFunctionData("swap", [
        {
          baseToken: subjectVETH.address,
          isBaseToQuote: subjectIsBaseToQuote,
          isExactInput: subjectIsExactInput,
          amount: subjectTradeQuoteAmount,
          sqrtPriceLimitX96: subjectSqrtPriceLimitX96,
        }
      ]);

      expect(target).to.eq(subjectQuoter);
      expect(value).to.eq(ZERO);
      expect(calldata).to.eq(expectedCalldata);
    });
  });

  describe("#invokeSwap", async () => {
    let subjectSetToken: Address;
    let subjectQuoter: Address;
    let subjectVETH: PerpV2BaseToken;
    let subjectIsBaseToQuote: boolean;
    let subjectIsExactInput: boolean;
    let subjectTradeQuoteAmount: BigNumber;
    let subjectSqrtPriceLimitX96: BigNumber;
    beforeEach(async () => {
      await invokeLibMock.testInvokeApprove(setToken.address, perpSetup.usdc.address, perpSetup.vault.address, MAX_UINT_256);
      await perpLibMock.testInvokeDeposit(setToken.address, perpSetup.vault.address, perpSetup.usdc.address, ether(1));

      subjectSetToken = setToken.address;
      subjectQuoter = perpSetup.quoter.address;
      subjectVETH = vETH;
      subjectIsBaseToQuote = false;
      subjectIsExactInput = true;
      subjectTradeQuoteAmount = ether(1);
      subjectSqrtPriceLimitX96 = ZERO;
    });

    // Need to callStatic this swap to get the return values
    async function subject(callStatic: boolean): Promise<any> {
      const params = {
        baseToken: subjectVETH.address,
        isBaseToQuote: subjectIsBaseToQuote,
        isExactInput: subjectIsExactInput,
        amount: subjectTradeQuoteAmount,
        sqrtPriceLimitX96: subjectSqrtPriceLimitX96,
      };

      return (callStatic)
        ? await perpLibMock.callStatic.testInvokeSwap(subjectSetToken, subjectQuoter, params)
        : await perpLibMock.testInvokeSwap(subjectSetToken, subjectQuoter, params);
    }

    it("should return the same deltaBase & deltaQuote values as `openPosition`", async () => {
      const {
        deltaBase: expectedDeltaAvailableBase,
        deltaQuote: expectedDeltaAvailableQuote
      } = await perpLibMock.callStatic.testInvokeOpenPosition(
        subjectSetToken,
        perpSetup.clearingHouse.address,
        {
          baseToken: subjectVETH.address,
          isBaseToQuote: subjectIsBaseToQuote,
          isExactInput: subjectIsExactInput,
          amount: subjectTradeQuoteAmount,
          oppositeAmountBound: ZERO,
          deadline:  MAX_UINT_256,
          sqrtPriceLimitX96: ZERO,
          referralCode: ZERO_BYTES
        }
      );

      const {
        deltaAvailableBase: quotedDeltaAvailableBase,
        deltaAvailableQuote: quotedDeltaAvailableQuote
      } = await subject(true);

      expect(expectedDeltaAvailableBase).to.eq(quotedDeltaAvailableBase);
      expect(expectedDeltaAvailableQuote).to.eq(quotedDeltaAvailableQuote);
    });

    it("should only simulate the trade", async () => {
      const previousQuoteBalance = await await perpSetup.accountBalance.getQuote(setToken.address, subjectVETH.address);
      await subject(false);
      const currentQuoteBalance = await perpSetup.accountBalance.getQuote(setToken.address, subjectVETH.address);

      expect(currentQuoteBalance).to.eq(previousQuoteBalance);
    });
  });

  describe("#simulateTrade", async () => {
    let subjectSetToken: Address;
    let subjectBaseToken: Address;
    let subjectIsBuy: boolean;
    let subjectBaseTokenAmount: BigNumber;
    let subjectOppositeAmountBound: BigNumber;

    beforeEach(async () => {
      await invokeLibMock.testInvokeApprove(setToken.address, perpSetup.usdc.address, perpSetup.vault.address, MAX_UINT_256);
      await perpLibMock.testInvokeDeposit(setToken.address, perpSetup.vault.address, perpSetup.usdc.address, ether(1));

      subjectSetToken = setToken.address;
      subjectBaseToken = vETH.address;
      subjectIsBuy = true;
      subjectBaseTokenAmount = ether(1);
      subjectOppositeAmountBound = ZERO;
    });

    // Need to callStatic this swap to get the return values
    async function subject(callStatic: boolean): Promise<any> {
      const actionInfo = {
        setToken: subjectSetToken,
        baseToken: subjectBaseToken,
        isBuy: subjectIsBuy,
        baseTokenAmount: subjectBaseTokenAmount,
        oppositeAmountBound: subjectOppositeAmountBound
      };

      return (callStatic)
        ? await perpLibMock.callStatic.testSimulateTrade(actionInfo, perpSetup.quoter.address)
        : await perpLibMock.testSimulateTrade(actionInfo, perpSetup.quoter.address);
    }

    it("should return the same deltaBase & deltaQuote values as `invokeSwap`", async () => {
      const {
        deltaAvailableBase: expectedDeltaAvailableBase,
        deltaAvailableQuote: expectedDeltaAvailableQuote
      } = await perpLibMock.callStatic.testInvokeSwap(
        subjectSetToken,
        perpSetup.quoter.address,
        {
          baseToken: subjectBaseToken,
          isBaseToQuote: !subjectIsBuy,
          isExactInput: !subjectIsBuy,
          amount: subjectBaseTokenAmount,
          sqrtPriceLimitX96: ZERO
        }
      );

      const [quotedDeltaAvailableBase, quotedDeltaAvailableQuote] = await subject(true);

      expect(expectedDeltaAvailableBase).to.eq(quotedDeltaAvailableBase);
      expect(expectedDeltaAvailableQuote).to.eq(quotedDeltaAvailableQuote);
    });

    it("should only simulate the trade", async () => {
      const previousQuoteBalance = await await perpSetup.accountBalance.getQuote(setToken.address, subjectBaseToken);
      await subject(false);
      const currentQuoteBalance = await perpSetup.accountBalance.getQuote(setToken.address, subjectBaseToken);

      expect(currentQuoteBalance).to.eq(previousQuoteBalance);
    });
  });

  describe("#executeTrade", async () => {
    let subjectSetToken: Address;
    let subjectBaseToken: Address;
    let subjectIsBuy: boolean;
    let subjectBaseTokenAmount: BigNumber;
    let subjectOppositeAmountBound: BigNumber;

    beforeEach(async () => {
      await invokeLibMock.testInvokeApprove(setToken.address, perpSetup.usdc.address, perpSetup.vault.address, MAX_UINT_256);
      await perpLibMock.testInvokeDeposit(setToken.address, perpSetup.vault.address, perpSetup.usdc.address, ether(1));

      subjectSetToken = setToken.address;
      subjectBaseToken = vETH.address;
      subjectIsBuy = true;
      subjectBaseTokenAmount = ether(1);
      subjectOppositeAmountBound = MAX_UINT_256;
    });

    async function subject(): Promise<any> {
      return await perpLibMock.testExecuteTrade(
        {
          setToken: subjectSetToken,
          baseToken: subjectBaseToken,
          isBuy: subjectIsBuy,
          baseTokenAmount: subjectBaseTokenAmount,
          oppositeAmountBound: subjectOppositeAmountBound
        },
        perpSetup.clearingHouse.address
      );
    }

    it("should execute a trade", async () => {
      const previousBaseBalance = await perpSetup.accountBalance.getBase(setToken.address, subjectBaseToken);

      await subject();

      const currentBaseBalance = await perpSetup.accountBalance.getBase(setToken.address, subjectBaseToken);
      const currentQuoteBalance = await perpSetup.accountBalance.getQuote(setToken.address, subjectBaseToken);

      const expectedBaseBalance = previousBaseBalance.add(subjectBaseTokenAmount);

      expect(previousBaseBalance).to.eq(0);
      expect(currentBaseBalance).to.be.eq(expectedBaseBalance);
      expect(currentQuoteBalance).to.be.lt(0);
    });

    describe("when isBuy is false", async () => {
      beforeEach(async () => {
        subjectIsBuy = false;
        subjectOppositeAmountBound = ZERO;
      });

      async function subject(): Promise<any> {
        return await perpLibMock.testExecuteTrade(
          {
            setToken: subjectSetToken,
            baseToken: subjectBaseToken,
            isBuy: subjectIsBuy,
            baseTokenAmount: subjectBaseTokenAmount,
            oppositeAmountBound: subjectOppositeAmountBound
          },
          perpSetup.clearingHouse.address
        );
      }

      it("should execute a trade", async () => {
        const previousBaseBalance = await perpSetup.accountBalance.getBase(setToken.address, subjectBaseToken);

        await subject();

        const currentBaseBalance = await perpSetup.accountBalance.getBase(setToken.address, subjectBaseToken);
        const currentQuoteBalance = await perpSetup.accountBalance.getQuote(setToken.address, subjectBaseToken);

        const expectedBaseBalance = previousBaseBalance.sub(subjectBaseTokenAmount);

        expect(previousBaseBalance).to.eq(0);
        expect(currentBaseBalance).to.be.eq(expectedBaseBalance);
        expect(currentQuoteBalance).to.be.gt(0);
      });
    });
  });
});
