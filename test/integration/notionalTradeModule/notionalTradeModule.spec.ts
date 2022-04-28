import "module-alias/register";

import { BigNumber} from "ethers";
import { ethers} from "hardhat";

import { Account, ForkedTokens } from "@utils/test/types";
import DeployHelper from "@utils/deploys";
import { ether } from "@utils/index";
import {
  getAccounts,
  getForkedTokens,
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
} from "@utils/contracts";

import { IERC20 } from "@typechain/IERC20";
import { ICErc20 } from "@typechain/ICErc20";
import { upgradeNotionalProxy, deployWrappedfCashInstance, mintWrappedFCash } from "./utils";

const expect = getWaffleExpect();

describe("Notional trade module integration [ @forked-mainnet ]", () => {
  const cdaiAddress = "0x5d3a536E4D6DbD6114cc1Ead35777bAB948E3643";
  let owner: Account;
  let manager: Account;
  let tokens: ForkedTokens;
  let dai: IERC20;
  let cDai: ICErc20;
  let deployer: DeployHelper;
  let setup: SystemFixture;

  beforeEach(async () => {
    [owner, manager] = await getAccounts();
    deployer = new DeployHelper(owner.wallet);
    setup = getSystemFixture(owner.address);
    await setup.initialize();

    // Setup ForkedTokens
    await initializeForkedTokens(deployer);
    tokens = getForkedTokens();
    dai = tokens.dai;
    cDai = (await ethers.getContractAt("ICErc20", cdaiAddress)) as ICErc20;
  });

  describe("When WrappedfCash is deployed", () => {
    let wrappedFCashInstance: WrappedfCash;
    beforeEach(async () => {
      wrappedFCashInstance = await deployWrappedfCashInstance(deployer, owner.wallet, cdaiAddress);
    });

    describe("When notional proxy is upgraded", () => {
      let daiAmount: BigNumber;
      let fCashAmount: BigNumber;
      beforeEach(async () => {
        await upgradeNotionalProxy(owner.wallet);
        daiAmount = ethers.utils.parseEther("1");
        fCashAmount = ethers.utils.parseUnits("1", 8);
        await dai.transfer(owner.address, daiAmount);
      });

      describe("When setToken with wrappedFCash component is deployed", () => {
        let debtIssuanceModule: DebtIssuanceModuleV2;
        let mockPreIssuanceHook: ManagerIssuanceHookMock;
        let notionalTradeModule: NotionalTradeModule;
        let setToken: SetToken;
        let wrappedFCashPosition: BigNumber;

        beforeEach(async () => {
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

          wrappedFCashPosition = ethers.utils.parseUnits(
            "2",
            await wrappedFCashInstance.decimals(),
          );

          await initialize();
        });

        async function initialize() {
          // Create Set token
          setToken = await setup.createSetToken(
            [wrappedFCashInstance.address],
            [wrappedFCashPosition],
            [debtIssuanceModule.address, notionalTradeModule.address],
            manager.address,
          );

          // Fund owner with stETH
          await tokens.steth.transfer(owner.address, ether(11000));

          // Initialize debIssuance module
          await debtIssuanceModule.connect(manager.wallet).initialize(
            setToken.address,
            ether(0.1),
            ether(0), // No issue fee
            ether(0), // No redeem fee
            owner.address,
            mockPreIssuanceHook.address,
          );

          await setup.integrationRegistry.addIntegration(
            notionalTradeModule.address,
            "DefaultIssuanceModule",
            debtIssuanceModule.address,
          );
          await notionalTradeModule.updateAllowedSetToken(setToken.address, true);
          await notionalTradeModule
            .connect(manager.wallet)
            .initialize(setToken.address, [wrappedFCashInstance.address]);
        }

        it("Should be able to issue set from wrappeFCash", async () => {
          daiAmount = ethers.utils.parseEther("10");
          fCashAmount = ethers.utils.parseUnits("9", 8);
          const setAmount = ethers.utils.parseEther("1");
          await dai.transfer(owner.address, daiAmount);

          await mintWrappedFCash(
            owner.wallet,
            dai,
            daiAmount,
            fCashAmount,
            cDai,
            wrappedFCashInstance,
            true,
          );

          await wrappedFCashInstance
            .connect(owner.wallet)
            .approve(debtIssuanceModule.address, ethers.constants.MaxUint256);
          await wrappedFCashInstance
            .connect(owner.wallet)
            .approve(setToken.address, ethers.constants.MaxUint256);

          const setBalanceBefore = await setToken.balanceOf(owner.address);
          await debtIssuanceModule
            .connect(owner.wallet)
            .issue(setToken.address, setAmount, owner.address);
          const setBalanceAfter = await setToken.balanceOf(owner.address);

          expect(setBalanceAfter.sub(setBalanceBefore)).to.eq(setAmount);
        });
      });
    });
  });
});
