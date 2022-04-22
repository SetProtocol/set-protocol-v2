import "module-alias/register";

import { BigNumber } from "ethers";

import { Account, ForkedTokens } from "@utils/test/types";
import DeployHelper from "@utils/deploys";
import { ether } from "@utils/index";
import {
  cacheBeforeEach,
  getAccounts,
  getForkedTokens,
  getRandomAccount,
  getSystemFixture,
  getWaffleExpect,
  initializeForkedTokens,
} from "@utils/test/index";

import { SystemFixture } from "@utils/fixtures";
import {
  SetToken,
  DebtIssuanceModuleV2,
  ManagerIssuanceHookMock,
  NotionalTradeModule,
  WrappedfCash,
  WrappedfCashFactory,
} from "@utils/contracts";

import { IERC20 } from "@typechain/IERC20";
import { MAX_UINT_256 } from "@utils/constants";

const expect = getWaffleExpect();

/**
 * Tests the icETH rebalance flow.
 *
 * The icETH product is a composite product composed of:
 * 1. stETH
 * 2. WETH
 */
describe("Notional trade module integration [ @forked-mainnet ]", () => {
  let owner: Account;
  let manager: Account;

  let deployer: DeployHelper;

  let setup: SystemFixture;
  let tokens: ForkedTokens;

  let weth: IERC20;
  let steth: IERC20;
  let debtIssuanceModule: DebtIssuanceModuleV2;
  let mockPreIssuanceHook: ManagerIssuanceHookMock;
  let notionalTradeModule: NotionalTradeModule;

  let setToken: SetToken;
  let issueQuantity: BigNumber;

  const notionalProxyAddress = "0x1344a36a1b56144c3bc62e7757377d288fde0369";
  let wrappedfCashBeacon: WrappedfCash;
  let wrappedfCashFactory: WrappedfCashFactory;

  cacheBeforeEach(async () => {
    [owner, manager] = await getAccounts();

    deployer = new DeployHelper(owner.wallet);

    setup = getSystemFixture(owner.address);
    await setup.initialize();

    // Setup ForkedTokens
    await initializeForkedTokens(deployer);
    tokens = getForkedTokens();
    weth = tokens.weth;
    steth = tokens.steth;

    // Deploy WrappedfCash
    wrappedfCashBeacon = await deployer.external.deployWrappedfCash(
      notionalProxyAddress
    );
    console.log("wrappedfCashBeacon:", wrappedfCashBeacon.address);

    wrappedfCashFactory = await deployer.external.deployWrappedfCashFactory(
      wrappedfCashBeacon.address
    );
    console.log("wrappedfCashFactory:", wrappedfCashFactory.address);

    // Deploy DebtIssuanceModuleV2
    debtIssuanceModule = await deployer.modules.deployDebtIssuanceModuleV2(
      setup.controller.address,
    );
    await setup.controller.addModule(debtIssuanceModule.address);

    // Deploy NotionalTradeModule
    notionalTradeModule = await deployer.modules.deployNotionalTradeModule(
      setup.controller.address,
    );
    await setup.controller.addModule(notionalTradeModule.address);

    // Deploy mock issuance hook to pass as arg in DebtIssuance module initialization
    mockPreIssuanceHook = await deployer.mocks.deployManagerIssuanceHookMock();

    // Create liquidity
    const ape = await getRandomAccount(); // The wallet adding initial liquidity
    await weth.transfer(ape.address, ether(50));
    await steth.transfer(ape.address, ether(50000));
  });

  async function initialize() {
    // Create Set token
    setToken = await setup.createSetToken(
      [steth.address],
      [ether(2)],
      [debtIssuanceModule.address, notionalTradeModule.address],
      manager.address,
    );

    // Fund owner with stETH
    await tokens.steth.transfer(owner.address, ether(11000));

    // stETH has balance rounding errors that crash DebtIssuanceModuleV2 with:
    //  "Invalid transfer in. Results in undercollateralization"
    // > transfer quantity =              1000000000000000000
    // > stETH balanceOf after transfer =  999999999999999999
    // Transfer steth to set token to overcollaterize the position by exactly the rounding error
    // Transferring 2 results in steth.balanceOf(setToken) == 1
    await tokens.steth.transfer(setToken.address, 2);

    await steth.connect(owner.wallet).approve(debtIssuanceModule.address, MAX_UINT_256);

    // Initialize debIssuance module
    await debtIssuanceModule.connect(manager.wallet).initialize(
      setToken.address,
      ether(0.1),
      ether(0), // No issue fee
      ether(0), // No redeem fee
      owner.address,
      mockPreIssuanceHook.address,
    );

    // Issue
    issueQuantity = ether(1);

    await debtIssuanceModule
      .connect(owner.wallet)
      .issue(setToken.address, issueQuantity, owner.address);
  }

  describe("#trade", async () => {
    cacheBeforeEach(initialize);
    it("should work", async () => {
      const setTokenBalance = await setToken.balanceOf(owner.address);
      expect(setTokenBalance).to.eq(issueQuantity);
    });
  });
});
