import "module-alias/register";

import { BigNumber, Signer } from "ethers";
import { ethers, network } from "hardhat";

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
  INotionalProxy,
  ManagerIssuanceHookMock,
  NotionalTradeModule,
  WrappedfCash,
  WrappedfCashFactory,
} from "@utils/contracts";

import { IERC20 } from "@typechain/IERC20";
import { IERC20Metadata } from "@typechain/IERC20Metadata";
import { NBeaconProxy } from "@typechain/NBeaconProxy";
import { NBeaconProxy__factory } from "@typechain/factories/NBeaconProxy__factory";
import { NUpgradeableBeacon } from "@typechain/NUpgradeableBeacon";
import { NUpgradeableBeacon__factory } from "@typechain/factories/NUpgradeableBeacon__factory";
import { MAX_UINT_256 } from "@utils/constants";

const expect = getWaffleExpect();

const batchActionArtifact = require("../../external/abi/notional/BatchAction.json");
const erc1155ActionArtifact = require("../../external/abi/notional/ERC1155Action.json");
const routerArtifact = require("../../external/abi/notional/Router.json");

async function impersonateAccount(address: string) {
  await network.provider.request({
    method: "hardhat_impersonateAccount",
    params: [address],
  });
  return ethers.provider.getSigner(address);
}

async function upgradeNotionalProxy(signer: Signer) {
  // Create these three contract factories
  console.log("RouterFactory");
  const routerFactory = new ethers.ContractFactory(
    routerArtifact["abi"],
    routerArtifact["bytecode"],
    signer,
  );
  console.log("ERC155Factory");
  const erc1155ActionFactory = new ethers.ContractFactory(
    erc1155ActionArtifact["abi"],
    erc1155ActionArtifact["bytecode"],
    signer,
  );
  console.log("BatchActionFactory");
  const batchActionFactory = new ethers.ContractFactory(
    batchActionArtifact["abi"],
    batchActionArtifact["bytecode"],
    signer,
  );
  console.log("Created factories");

  // Get the current router to get current contract addresses (same as notional contract, just different abi)
  const router = (await ethers.getContractAt(
    routerArtifact["abi"],
    "0x1344A36A1B56144C3Bc62E7757377D288fDE0369",
  )) as any;

  // This is the notional contract w/ notional abi
  console.log("connecting to notional");
  const notional = (await ethers.getContractAt(
    "INotionalProxy",
    "0x1344A36A1B56144C3Bc62E7757377D288fDE0369",
  )) as INotionalProxy;
  console.log("connected to notional");

  // Deploy the new upgraded contracts
  const batchAction = await batchActionFactory.deploy();
  const erc1155Action = await erc1155ActionFactory.deploy();

  // Get the current router args and replace upgraded addresses
  const routerArgs = await Promise.all([
    router.GOVERNANCE(),
    router.VIEWS(),
    router.INITIALIZE_MARKET(),
    router.NTOKEN_ACTIONS(),
    batchAction.address, // upgraded
    router.ACCOUNT_ACTION(),
    erc1155Action.address, // upgraded
    router.LIQUIDATE_CURRENCY(),
    router.LIQUIDATE_FCASH(),
    router.cETH(),
    router.TREASURY(),
    router.CALCULATION_VIEWS(),
  ]);

  // Deploy a new router
  const newRouter = await routerFactory.deploy(...routerArgs);
  // Get the owner contract
  const notionalOwner = await impersonateAccount(await notional.owner());
  // Upgrade the system to the new router

  const fundingValue = ethers.utils.parseEther("1");
  await signer.sendTransaction({ to: await notionalOwner.getAddress(), value: fundingValue });

  console.log("Upgrading to", newRouter.address);
  await notional.connect(notionalOwner).upgradeTo(newRouter.address);
}

/**
 * Tests the icETH rebalance flow.
 *
 * The icETH product is a composite product composed of:
 * 1. stETH
 * 2. WETH
 */
describe("Notional trade module integration [ @forked-mainnet ]", () => {
  const notionalProxyAddress = "0x1344a36a1b56144c3bc62e7757377d288fde0369";
  const cdaiAddress = "0x5d3a536E4D6DbD6114cc1Ead35777bAB948E3643";
  let notionalProxy: INotionalProxy;

  beforeEach(async () => {
    notionalProxy = (await ethers.getContractAt(
      "INotionalProxy",
      notionalProxyAddress,
    )) as INotionalProxy;
  });

  describe("Test notional proxy", async () => {
    // // cacheBeforeEach(initialize);
    // const daiCurrencyId = 2;
    // it("owner should work", async () => {
    //   const owner = await notionalProxy.owner();
    // });
    // it("max currency id should work", async () => {
    //   const maxCurrencyId = await notionalProxy.getMaxCurrencyId();
    //   expect(maxCurrencyId).to.eq(4);
    // });
    // it("getCurrencyId should work", async () => {
    //   const currencyId = await notionalProxy.getCurrencyId(cdaiAddress);
    //   expect(currencyId).to.eq(daiCurrencyId);
    // });
    // describe("When currencyId is valid", () => {
    //   [1, 2, 3, 4].forEach((currencyId) => {
    //     describe(`With currencyId: ${currencyId}`, () => {
    //       it("getCurrency should work", async () => {
    //         const { underlyingToken, assetToken } = await notionalProxy.getCurrency(currencyId);
    //         const underlyingContract = (await ethers.getContractAt(
    //           "IERC20Metadata",
    //           underlyingToken.tokenAddress,
    //         )) as IERC20Metadata;
    //         const tokenSymbol =
    //           underlyingToken.tokenAddress == constants.AddressZero
    //             ? "ETH"
    //             : await underlyingContract.symbol();
    //         console.log("Underlying token", {
    //           assetAddress: assetToken.tokenAddress,
    //           underlyingAddress: underlyingToken.tokenAddress,
    //           symbol: tokenSymbol,
    //         });
    //       });
    //       it("getDepositParameters should work", async () => {
    //         await notionalProxy.getDepositParameters(currencyId);
    //       });
    //       it("getInitializationParameters should work", async () => {
    //         await notionalProxy.getInitializationParameters(currencyId);
    //       });
    //       it("getRateStorage should work", async () => {
    //         await notionalProxy.getRateStorage(currencyId);
    //       });
    //       it("getCurrencyAndRates should work", async () => {
    //         await notionalProxy.getCurrencyAndRates(currencyId);
    //       });
    //       it("getActiveMarkets should work", async () => {
    //         const activeMarkets = await notionalProxy.getActiveMarkets(currencyId);
    //         expect(activeMarkets.length).to.be.gte(2);
    //       });
    //       describe("When the maturity is valid", () => {
    //         let maturity: number;
    //         let referenceTime: number;
    //         beforeEach(async () => {
    //           const secondsInQuarter = 3 * 30 * 24 * 60 * 60;
    //           const latestBlock = await ethers.provider.getBlock("latest");
    //           const blockTime = latestBlock.timestamp;
    //           referenceTime = blockTime - (blockTime % secondsInQuarter);
    //           const quarters = referenceTime / secondsInQuarter;
    //           maturity = referenceTime + secondsInQuarter;
    //         });
    //         it("getSettlementRate should work", async () => {
    //           const settlementRate = await notionalProxy.getSettlementRate(currencyId, maturity);
    //           expect(settlementRate.underlyingDecimals.gt(0)).to.be.true;
    //         });
    //         it("getMarket should work", async () => {
    //           const marketData = await notionalProxy.getMarket(currencyId, maturity, maturity);
    //           expect(marketData.maturity).to.eq(maturity);
    //         });
    //       });
    //     });
    //   });
    // });
    // describe("When currency id is invalid", () => {
    //   const invalidCurrencyId = 5;
    //   it("getActiveMarkets should revert correctly", async () => {
    //     await expect(notionalProxy.getActiveMarkets(invalidCurrencyId)).to.be.revertedWith(
    //       "Invalid currency id",
    //     );
    //   });
    // });
  });

  describe("Test WrappedfCash contract", () => {
    let owner: Account;
    let manager: Account;

    let deployer: DeployHelper;

    let setup: SystemFixture;
    let tokens: ForkedTokens;

    let weth: IERC20;
    let dai: IERC20;
    let steth: IERC20;
    let debtIssuanceModule: DebtIssuanceModuleV2;
    let mockPreIssuanceHook: ManagerIssuanceHookMock;
    let notionalTradeModule: NotionalTradeModule;

    let setToken: SetToken;
    let issueQuantity: BigNumber;

    let wrappedfCashImplementation: WrappedfCash;
    let wrappedfCashBeacon: NUpgradeableBeacon;
    let wrappedfCashFactory: WrappedfCashFactory;

    beforeEach(async () => {
      [owner, manager] = await getAccounts();

      deployer = new DeployHelper(owner.wallet);

      setup = getSystemFixture(owner.address);
      await setup.initialize();

      // Setup ForkedTokens
      await initializeForkedTokens(deployer);
      tokens = getForkedTokens();
      weth = tokens.weth;
      steth = tokens.steth;
      dai = tokens.dai;
      // Deploy WrappedfCash
      wrappedfCashImplementation = await deployer.external.deployWrappedfCash(notionalProxyAddress);

      wrappedfCashBeacon = await new NUpgradeableBeacon__factory(owner.wallet).deploy(
        wrappedfCashImplementation.address,
      );

      wrappedfCashFactory = await deployer.external.deployWrappedfCashFactory(
        wrappedfCashBeacon.address,
      );

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

      await initialize();
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

    describe("Test WrappedFCash contracts", () => {
      // kAI currencyId
      const currencyId = 2;
      let maturity: BigNumber;
      let wrappedFCashInstance: WrappedfCash;
      beforeEach(async () => {
        const activeMarkets = await notionalProxy.getActiveMarkets(currencyId);
        maturity = activeMarkets[0].maturity;
        const maturityDate = new Date(Math.floor(maturity.toNumber() * 1000));
        console.log("maturity", maturityDate.toISOString());
      });

      describe("Deploying WrappedfCash with beacon proxy", () => {
        let proxyContract;
        it("deployment should work", async () => {
          const initializationData = wrappedfCashImplementation.interface.encodeFunctionData(
            "initialize",
            [currencyId, maturity],
          );
          proxyContract = await new NBeaconProxy__factory(owner.wallet).deploy(
            wrappedfCashBeacon.address,
            initializationData,
          );
          wrappedFCashInstance = wrappedfCashImplementation.attach(proxyContract.address);
        });
      });

      describe("WrappedFCashFactory", () => {
        it("Can create new wrappedFCash instance", async () => {
          await wrappedfCashFactory.deployWrapper(currencyId, maturity);
        });
        describe("When WrappedfCash is deployed", () => {
          beforeEach(async () => {
            const wrappeFCashAddress = await wrappedfCashFactory.callStatic.deployWrapper(
              currencyId,
              maturity,
            );
            await wrappedfCashFactory.deployWrapper(currencyId, maturity);
            wrappedFCashInstance = wrappedfCashImplementation.attach(wrappeFCashAddress);
          });

          it("getCurrencyId works correctly", async () => {
            const returnedCurrencyId = await wrappedFCashInstance.getCurrencyId();
            expect(returnedCurrencyId).to.eq(currencyId);
          });

          it("getAssetToken works", async () => {
            const [assetTokenAddress] = await wrappedFCashInstance.getAssetToken();
            expect(assetTokenAddress).to.eq(cdaiAddress);
          });

          describe("When notional proxy is upgraded", () => {
            beforeEach(async () => {
              await upgradeNotionalProxy(owner.wallet);
            });
            it("mint works", async () => {
              // No matter how high I set the depositAmoutnExternal get 'Insufficient deposit' revertion from Notional address.
              // (If I set it below the fCash amoutn I get a transfer failed exception from the DAI contract instead, which is to be expected.
              const depositAmountExternal = ethers.utils.parseEther("2");
              const fCashAmount = ethers.utils.parseUnits("1", 8);
              const receiver = owner.address;
              const minImpliedRate = 0;
              const useUnderlying = true;
              await dai.transfer(owner.address, depositAmountExternal);
              await dai
                .connect(owner.wallet)
                .approve(wrappedFCashInstance.address, depositAmountExternal);

              // Double check we have enough dai
              const balanceBefore = await dai.balanceOf(owner.address);
              console.log("Dai balance", ethers.utils.formatEther(balanceBefore));
              expect(balanceBefore).to.be.gte(depositAmountExternal);

              // Double check we have approved enough
              const allowanceBefore = await dai.allowance(
                owner.address,
                wrappedFCashInstance.address,
              );
              console.log("Allowance", ethers.utils.formatEther(allowanceBefore));
              expect(allowanceBefore).to.be.gte(depositAmountExternal);

              // Mint fcash (reverting)
              await wrappedFCashInstance
                .connect(owner.wallet)
                .mint(depositAmountExternal, fCashAmount, receiver, minImpliedRate, useUnderlying);
            });
          });
        });
      });
    });
  });
});
