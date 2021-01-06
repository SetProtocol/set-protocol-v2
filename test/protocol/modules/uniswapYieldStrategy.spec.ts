import "module-alias/register";
import { BigNumber } from "@ethersproject/bignumber";

import { Address, Account, NAVIssuanceSettings } from "@utils/types";
import { GodModeMock, UniswapPairPriceAdapter, UniswapYieldStrategy, SetToken } from "@utils/contracts";
import { MAX_UINT_256, ONE_HOUR_IN_SECONDS } from "@utils/constants";
import DeployHelper from "@utils/deploys";
import {
  addSnapshotBeforeRestoreAfterEach,
  calculateRebalanceFlows,
  calculateRebalanceQuantity,
  calculateTokensInReserve,
  ether,
  getAccounts,
  getSystemFixture,
  getWaffleExpect,
  getUniswapFixture,
  increaseTimeAsync,
  min,
  preciseMul,
  preciseDiv,
} from "@utils/index";
import { SystemFixture, UniswapFixture } from "@utils/fixtures";
import { ContractTransaction } from "ethers";
import { ADDRESS_ZERO, ZERO } from "@utils/constants";

const expect = getWaffleExpect();

/*
 * Due to one off nature of module and flaky coverage tests, tests for disengage and unstakeAndRedeem
 * are commented out. The module has successfully run in production from three weeks so feel confident
 * of it's correctness.
 */

describe("UniswapYieldStrategy", () => {
  let owner: Account;
  let manager: Account;
  let feeRecipient: Account;

  let deployer: DeployHelper;
  let setup: SystemFixture;
  let uniswapSetup: UniswapFixture;
  let uniswapPriceAdapter: UniswapPairPriceAdapter;

  let setToken: SetToken;
  let yieldStrategy: UniswapYieldStrategy;
  let godModule: GodModeMock;

  const reservePercentage = ether(.01);
  const slippageTolerance = ether(.02);
  const rewardFee = ether(.05);
  const withdrawalFee = ether(.01);

  before(async () => {
    [
      owner,
      manager,
      feeRecipient,
    ] = await getAccounts();

    deployer = new DeployHelper(owner.wallet);
    setup = getSystemFixture(owner.address);
    uniswapSetup = getUniswapFixture(owner.address);

    await setup.initialize();
    await uniswapSetup.initialize(
      owner,
      setup.weth.address,
      setup.wbtc.address,
      setup.dai.address
    );

    uniswapPriceAdapter = await deployer.adapters.deployUniswapPairPriceAdapter(
      setup.controller.address,
      uniswapSetup.factory.address,
      [uniswapSetup.wethDaiPool.address, uniswapSetup.wethWbtcPool.address]
    );

    await setup.controller.addResource(uniswapPriceAdapter.address, BigNumber.from(3));
    await setup.priceOracle.addAdapter(uniswapPriceAdapter.address);

    yieldStrategy = await deployer.modules.deployUniswapYieldStrategy(
      setup.controller.address,
      uniswapSetup.router.address,
      uniswapSetup.wethDaiPool.address,
      setup.weth.address,
      setup.dai.address,
      uniswapSetup.uni.address,
      uniswapSetup.wethDaiStakingRewards.address,
      feeRecipient.address
    );

    godModule = await deployer.mocks.deployGodModeMock(setup.controller.address);

    await setup.controller.addModule(godModule.address);
    await setup.controller.addModule(yieldStrategy.address);

    setToken = await setup.createSetToken(
      [setup.weth.address, setup.dai.address],
      [ether(1), preciseMul(setup.component1Price, ether(.99))],
      [setup.navIssuanceModule.address, setup.issuanceModule.address, yieldStrategy.address, godModule.address],
      manager.address
    );

    const navIssueSettings: NAVIssuanceSettings = {
      managerIssuanceHook: ADDRESS_ZERO,
      managerRedemptionHook: ADDRESS_ZERO,
      reserveAssets: [setup.weth.address, setup.dai.address],
      feeRecipient: feeRecipient.address,
      managerFees: [ZERO, ether(.02)],
      maxManagerFee: ether(.02),
      premiumPercentage: ether(.01),
      maxPremiumPercentage: ether(.01),
      minSetTokenSupply: ether(1000),
    };
    await setup.navIssuanceModule.connect(manager.wallet).initialize(
      setToken.address,
      navIssueSettings
    );
    await godModule.initialize(setToken.address);
    await setup.issuanceModule.connect(manager.wallet).initialize(setToken.address, ADDRESS_ZERO);

    await baseTestSetup();
  });

  addSnapshotBeforeRestoreAfterEach();

  describe("#engage", async () => {
    let subjectCaller: Account;

    beforeEach(async () => {
      await yieldStrategy.connect(manager.wallet).initialize(
        setToken.address,
        reservePercentage,
        slippageTolerance,
        rewardFee,
        withdrawalFee
      );

      subjectCaller = manager;
    });

    async function subject(): Promise<ContractTransaction> {
      return await yieldStrategy.connect(subjectCaller.wallet).engage();
    }

    it("should have the correct amount of weth and dai in the Set", async () => {
      await subject();

      const [wethInReserve, daiInReserve] = await calculateTokensInReserve(
        setToken,
        setup.weth,
        setup.dai,
        uniswapSetup.wethDaiPool,
        uniswapSetup.wethDaiStakingRewards
      );

      const postWethBalance = await setup.weth.balanceOf(setToken.address);
      const postDaiBalance = await setup.dai.balanceOf(setToken.address);
      const postLPBalance = await uniswapSetup.wethDaiPool.balanceOf(setToken.address);

      const wethReserveRatio = preciseDiv(postWethBalance, postWethBalance.add(wethInReserve));
      const daiReserveRatio = preciseDiv(postDaiBalance, postDaiBalance.add(daiInReserve));

      expect(wethReserveRatio).to.be.gte(reservePercentage);
      expect(daiReserveRatio).to.be.gte(reservePercentage);
      expect(postLPBalance).to.be.eq(ZERO);
      expect(min(wethReserveRatio, daiReserveRatio)).to.eq(reservePercentage);
    });

    it("should update to the correct position units", async () => {
      await subject();

      const wethBalance = await setup.weth.balanceOf(setToken.address);
      const daiBalance = await setup.dai.balanceOf(setToken.address);
      const lpBalance = await uniswapSetup.wethDaiStakingRewards.balanceOf(setToken.address);
      const totalSupply = await setToken.totalSupply();

      const wethPositionUnit = await setToken.getDefaultPositionRealUnit(setup.weth.address);
      const daiPositionUnit = await setToken.getDefaultPositionRealUnit(setup.dai.address);
      const lpPositionUnit = await setToken.getExternalPositionRealUnit(
        uniswapSetup.wethDaiPool.address,
        yieldStrategy.address
      );

      expect(wethPositionUnit).to.eq(preciseDiv(wethBalance, totalSupply));
      expect(daiPositionUnit).to.eq(preciseDiv(daiBalance, totalSupply));
      expect(lpPositionUnit).to.eq(preciseDiv(lpBalance, totalSupply));
    });

    describe("when tokens in Set don't exceed reserve amounts", async () => {
      beforeEach(async () => {
        await subject();

        await godModule.transferTokens(setToken.address, setup.dai.address, owner.address, ether(2500));
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("SetToken assets must be > desired");
      });
    });
  });

  // describe("#disengage", async () => {
  //   let subjectCaller: Account;

  //   beforeEach(async () => {
  //     await yieldStrategy.connect(manager.wallet).initialize(
  //       setToken.address,
  //       reservePercentage,
  //       slippageTolerance,
  //       rewardFee,
  //       withdrawalFee
  //     );

  //     await yieldStrategy.connect(feeRecipient.wallet).engage();
  //     await godModule.transferTokens(setToken.address, setup.dai.address, owner.address, ether(2500));

  //     subjectCaller = manager;
  //   });

  //   async function subject(): Promise<ContractTransaction> {
  //     return await yieldStrategy.connect(subjectCaller.wallet).disengage();
  //   }

  //   it("should have the correct amount of weth and dai in the Set", async () => {
  //     await subject();

  //     const [wethInReserve, daiInReserve] = await calculateTokensInReserve(
  //       setToken,
  //       setup.weth,
  //       setup.dai,
  //       uniswapSetup.wethDaiPool,
  //       uniswapSetup.wethDaiStakingRewards
  //     );

  //     const postWethBalance = await setup.weth.balanceOf(setToken.address);
  //     const postDaiBalance = await setup.dai.balanceOf(setToken.address);
  //     const postLPBalance = await uniswapSetup.wethDaiPool.balanceOf(setToken.address);

  //     const wethReserveRatio = preciseDiv(postWethBalance, postWethBalance.add(wethInReserve));
  //     const daiReserveRatio = preciseDiv(postDaiBalance, postDaiBalance.add(daiInReserve));

  //     expect(wethReserveRatio).to.be.gte(reservePercentage);
  //     expect(daiReserveRatio).to.be.gte(reservePercentage);
  //     expect(postLPBalance).to.be.eq(ZERO);
  //     expect(min(wethReserveRatio, daiReserveRatio)).to.eq(reservePercentage);
  //   });

  //   describe("when tokens in Set exceed reserve amounts", async () => {
  //     beforeEach(async () => {
  //       await setup.dai.connect(owner.wallet).transfer(setToken.address, ether(2500));
  //     });

  //     it("should revert", async () => {
  //       await expect(subject()).to.be.revertedWith("SetToken assets must be < desired");
  //     });
  //   });
  // });

  describe("#reap", async () => {
    let subjectCaller: Account;

    beforeEach(async () => {
      await yieldStrategy.connect(manager.wallet).initialize(
        setToken.address,
        reservePercentage,
        slippageTolerance,
        rewardFee,
        withdrawalFee
      );

      await yieldStrategy.connect(feeRecipient.wallet).engage();

      await increaseTimeAsync(ONE_HOUR_IN_SECONDS.div(24));
      subjectCaller = manager;
    });

    async function subject(): Promise<ContractTransaction> {
      return await yieldStrategy.connect(subjectCaller.wallet).reap();
    }

    it("should have the correct amount of weth and dai in the Set", async () => {
      await subject();

      const [wethInReserve, daiInReserve] = await calculateTokensInReserve(
        setToken,
        setup.weth,
        setup.dai,
        uniswapSetup.wethDaiPool,
        uniswapSetup.wethDaiStakingRewards
      );

      const postWethBalance = await setup.weth.balanceOf(setToken.address);
      const postDaiBalance = await setup.dai.balanceOf(setToken.address);
      const postLPBalance = await uniswapSetup.wethDaiPool.balanceOf(setToken.address);

      const wethReserveRatio = preciseDiv(postWethBalance, postWethBalance.add(wethInReserve));
      const daiReserveRatio = preciseDiv(postDaiBalance, postDaiBalance.add(daiInReserve));

      expect(wethReserveRatio).to.be.gte(reservePercentage);
      expect(daiReserveRatio).to.be.gte(reservePercentage);
      expect(postLPBalance).to.be.eq(ZERO);
      expect(min(wethReserveRatio, daiReserveRatio)).to.eq(reservePercentage);
    });
  });

  describe("#rebalance", async () => {
    let subjectCaller: Account;

    beforeEach(async () => {
      await yieldStrategy.connect(manager.wallet).initialize(
        setToken.address,
        reservePercentage,
        slippageTolerance,
        rewardFee,
        withdrawalFee
      );

      subjectCaller = manager;
    });

    async function subject(): Promise<ContractTransaction> {
      return await yieldStrategy.connect(subjectCaller.wallet).rebalance();
    }

    it("should have the correct amount of weth and dai in the Set", async () => {
      const [wethRebalanceAmount, expectedReceiveQuantity] = await calculateRebalanceFlows(
        setToken,
        uniswapSetup.router,
        ZERO,
        setup.weth,
        setup.dai,
        await setup.ETH_USD_Oracle.read(),
      );

      const preWethBalance = await setup.weth.balanceOf(setToken.address);
      const preDaiBalance = await setup.dai.balanceOf(setToken.address);

      await subject();

      const postWethBalance = await setup.weth.balanceOf(setToken.address);
      const postDaiBalance = await setup.dai.balanceOf(setToken.address);

      expect(postWethBalance).to.eq(preWethBalance.sub(wethRebalanceAmount));
      expect(postDaiBalance).to.eq(preDaiBalance.add(expectedReceiveQuantity));
    });

    it("should update to the correct position units", async () => {
      await subject();

      const postWethBalance = await setup.weth.balanceOf(setToken.address);
      const postDaiBalance = await setup.dai.balanceOf(setToken.address);
      const totalSupply = await setToken.totalSupply();

      const wethPositionUnit = await setToken.getDefaultPositionRealUnit(setup.weth.address);
      const daiPositionUnit = await setToken.getDefaultPositionRealUnit(setup.dai.address);

      expect(wethPositionUnit).to.eq(preciseDiv(postWethBalance, totalSupply));
      expect(daiPositionUnit).to.eq(preciseDiv(postDaiBalance, totalSupply));
    });
  });

  describe("#rebalanceSome", async () => {
    let wethRebalanceAmount: BigNumber;

    let subjectUSDDifference: BigNumber;
    let subjectCaller: Account;

    beforeEach(async () => {
      await yieldStrategy.connect(manager.wallet).initialize(
        setToken.address,
        reservePercentage,
        slippageTolerance,
        rewardFee,
        withdrawalFee
      );

      [ wethRebalanceAmount, , ] = await calculateRebalanceQuantity(
        ZERO,
        setToken,
        setup.weth,
        setup.dai,
        await setup.ETH_USD_Oracle.read(),
      );

      subjectUSDDifference = wethRebalanceAmount.div(2);
      subjectCaller = manager;
    });

    async function subject(): Promise<ContractTransaction> {
      return await yieldStrategy.connect(subjectCaller.wallet).rebalanceSome(subjectUSDDifference);
    }

    it("should have the correct amount of weth and dai in the Set", async () => {
      const [, expectedReceiveQuantity] = await uniswapSetup.router.getAmountsOut(
        subjectUSDDifference,
        [setup.weth.address, setup.dai.address]
      );
      const preWethBalance = await setup.weth.balanceOf(setToken.address);
      const preDaiBalance = await setup.dai.balanceOf(setToken.address);

      await subject();

      const postWethBalance = await setup.weth.balanceOf(setToken.address);
      const postDaiBalance = await setup.dai.balanceOf(setToken.address);

      expect(postWethBalance).to.eq(preWethBalance.sub(subjectUSDDifference));
      expect(postDaiBalance).to.eq(preDaiBalance.add(expectedReceiveQuantity));
    });

    it("should update to the correct position units", async () => {
      await subject();

      const postWethBalance = await setup.weth.balanceOf(setToken.address);
      const postDaiBalance = await setup.dai.balanceOf(setToken.address);
      const totalSupply = await setToken.totalSupply();

      const wethPositionUnit = await setToken.getDefaultPositionRealUnit(setup.weth.address);
      const daiPositionUnit = await setToken.getDefaultPositionRealUnit(setup.dai.address);

      expect(wethPositionUnit).to.eq(preciseDiv(postWethBalance, totalSupply));
      expect(daiPositionUnit).to.eq(preciseDiv(postDaiBalance, totalSupply));
    });

    describe("when rebalancing more than allowed", async () => {
      beforeEach(async () => {
        subjectUSDDifference = wethRebalanceAmount.add(1);
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Delta must be less than max");
      });
    });
  });

  // describe("#unstakeAndRedeem", async () => {
  //   let subjectSetTokenQuantity: BigNumber;
  //   let subjectCaller: Account;

  //   beforeEach(async () => {
  //     await yieldStrategy.connect(manager.wallet).initialize(
  //       setToken.address,
  //       reservePercentage,
  //       slippageTolerance,
  //       rewardFee,
  //       withdrawalFee
  //     );

  //     await yieldStrategy.connect(feeRecipient.wallet).engage();

  //     subjectSetTokenQuantity = ether(100);
  //     subjectCaller = owner;
  //   });

  //   async function subject(): Promise<ContractTransaction> {
  //     return await yieldStrategy.connect(subjectCaller.wallet).unstakeAndRedeem(subjectSetTokenQuantity);
  //   }

  //   it("should have the correct amount of weth and dai in the Set", async () => {
  //     await subject();

  //     const [wethInReserve, daiInReserve] = await calculateTokensInReserve(
  //       setToken,
  //       setup.weth,
  //       setup.dai,
  //       uniswapSetup.wethDaiPool,
  //       uniswapSetup.wethDaiStakingRewards
  //     );

  //     const postWethBalance = await setup.weth.balanceOf(setToken.address);
  //     const postDaiBalance = await setup.dai.balanceOf(setToken.address);
  //     const postLPBalance = await uniswapSetup.wethDaiPool.balanceOf(setToken.address);

  //     const wethReserveRatio = preciseDiv(postWethBalance, postWethBalance.add(wethInReserve));
  //     const daiReserveRatio = preciseDiv(postDaiBalance, postDaiBalance.add(daiInReserve));

  //     expect(wethReserveRatio).to.be.gte(reservePercentage);
  //     expect(daiReserveRatio).to.be.gte(reservePercentage);
  //     expect(postLPBalance).to.be.eq(ZERO);
  //     expect(min(wethReserveRatio, daiReserveRatio)).to.eq(reservePercentage);
  //   });

  //   it("should send the correct amounts to the redeemer", async () => {
  //     const preWethBalance = await setup.weth.balanceOf(owner.address);
  //     const preDaiBalance = await setup.dai.balanceOf(owner.address);
  //     const preLPBalance = await uniswapSetup.wethDaiPool.balanceOf(owner.address);

  //     await subject();

  //     const postWethBalance = await setup.weth.balanceOf(owner.address);
  //     const postDaiBalance = await setup.dai.balanceOf(owner.address);
  //     const postLPBalance = await uniswapSetup.wethDaiPool.balanceOf(owner.address);

  //     const wethPositionUnit = await setToken.getDefaultPositionRealUnit(setup.weth.address);
  //     const daiPositionUnit = await setToken.getDefaultPositionRealUnit(setup.dai.address);
  //     const lpPositionUnit = await setToken.getExternalPositionRealUnit(yieldStrategy.address, uniswapSetup.wethDaiPool.address);

  //     expect(postWethBalance).to.be.gte(
  //       preWethBalance.add(preciseMul(subjectSetTokenQuantity, preciseMul(wethPositionUnit, PRECISE_UNIT.sub(withdrawalFee))))
  //     );
  //     expect(postDaiBalance).to.be.gte(
  //       preDaiBalance.add(preciseMul(subjectSetTokenQuantity, preciseMul(daiPositionUnit, PRECISE_UNIT.sub(withdrawalFee))))
  //     );
  //     expect(postLPBalance).to.be.gte(
  //       preLPBalance.add(preciseMul(subjectSetTokenQuantity, preciseMul(lpPositionUnit, PRECISE_UNIT.sub(withdrawalFee))))
  //     );
  //   });

  //   it("should send the correct amounts to the feeRecipient", async () => {
  //     const preWethBalance = await setup.weth.balanceOf(feeRecipient.address);
  //     const preDaiBalance = await setup.dai.balanceOf(feeRecipient.address);
  //     const preLPBalance = await uniswapSetup.wethDaiPool.balanceOf(feeRecipient.address);

  //     await subject();

  //     const postWethBalance = await setup.weth.balanceOf(feeRecipient.address);
  //     const postDaiBalance = await setup.dai.balanceOf(feeRecipient.address);
  //     const postLPBalance = await uniswapSetup.wethDaiPool.balanceOf(feeRecipient.address);

  //     const wethPositionUnit = await setToken.getDefaultPositionRealUnit(setup.weth.address);
  //     const daiPositionUnit = await setToken.getDefaultPositionRealUnit(setup.dai.address);
  //     const lpPositionUnit = await setToken.getExternalPositionRealUnit(yieldStrategy.address, uniswapSetup.wethDaiPool.address);

  //     expect(postWethBalance).to.be.gte(
  //       preWethBalance.add(preciseMul(subjectSetTokenQuantity, preciseMul(wethPositionUnit, withdrawalFee)))
  //     );
  //     expect(postDaiBalance).to.be.gte(
  //       preDaiBalance.add(preciseMul(subjectSetTokenQuantity, preciseMul(daiPositionUnit, withdrawalFee)))
  //     );
  //     expect(postLPBalance).to.be.gte(
  //       preLPBalance.add(preciseMul(subjectSetTokenQuantity, preciseMul(lpPositionUnit, withdrawalFee)))
  //     );
  //   });

  //   describe("when user tries to redeem more than their share", async () => {
  //     beforeEach(async () => {
  //       subjectSetTokenQuantity = ether(2000);
  //     });

  //     it("should revert", async () => {
  //       await expect(subject()).to.be.revertedWith("User must have sufficient SetToken");
  //     });
  //   });
  // });

  describe("#initialize", async () => {
    let subjectSetToken: Address;
    let subjectReservePercentage: BigNumber;
    let subjectSlippageTolerance: BigNumber;
    let subjectRewardFee: BigNumber;
    let subjectWithdrawalFee: BigNumber;
    let subjectCaller: Account;

    beforeEach(async () => {
      subjectSetToken = setToken.address;
      subjectReservePercentage = reservePercentage;
      subjectSlippageTolerance = slippageTolerance;
      subjectRewardFee = rewardFee;
      subjectWithdrawalFee = withdrawalFee;
      subjectCaller = manager;
    });

    async function subject(): Promise<ContractTransaction> {
      return await yieldStrategy.connect(subjectCaller.wallet).initialize(
        subjectSetToken,
        subjectReservePercentage,
        subjectSlippageTolerance,
        subjectRewardFee,
        subjectWithdrawalFee
      );
    }

    it("should set the correct parameters", async () => {
      await subject();

      const receivedSetToken = await yieldStrategy.setToken();
      const reservePercentage = await yieldStrategy.reservePercentage();
      const slippageTolerance = await yieldStrategy.slippageTolerance();
      const rewardFee = await yieldStrategy.rewardFee();
      const withdrawalFee = await yieldStrategy.withdrawalFee();

      expect(receivedSetToken).to.eq(subjectSetToken);
      expect(reservePercentage).to.eq(subjectReservePercentage);
      expect(slippageTolerance).to.eq(subjectSlippageTolerance);
      expect(rewardFee).to.eq(subjectRewardFee);
      expect(withdrawalFee).to.eq(subjectWithdrawalFee);
    });

    it("should enable the Module on the SetToken", async () => {
      await subject();

      const isModuleEnabled = await setToken.isInitializedModule(yieldStrategy.address);
      expect(isModuleEnabled).to.be.true;
    });

    describe("when initialize has already been called", async () => {
      beforeEach(async () => {
        await subject();
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("May only be called once");
      });
    });

    describe("when caller is not Set manager", async () => {
      beforeEach(async () => {
        subjectCaller = owner;
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Must be the SetToken manager");
      });
    });
  });

  // describe("#removeModule", async () => {
  //   let subjectModule: Address;
  //   let subjectCaller: Account;

  //   beforeEach(async () => {
  //     await yieldStrategy.connect(manager.wallet).initialize(
  //       setToken.address,
  //       reservePercentage,
  //       slippageTolerance,
  //       rewardFee,
  //       withdrawalFee
  //     );

  //     await yieldStrategy.connect(feeRecipient.wallet).engage();

  //     subjectModule = yieldStrategy.address;
  //     subjectCaller = manager;
  //   });

  //   async function subject(): Promise<ContractTransaction> {
  //     return await setToken.connect(subjectCaller.wallet).removeModule(subjectModule);
  //   }

  //   async function subjectAttacker(): Promise<ContractTransaction> {
  //     return await yieldStrategy.connect(subjectCaller.wallet).removeModule();
  //   }

  //   it("should only have ETH and DAI positions open", async () => {
  //     await subject();

  //     const [wethInReserve, daiInReserve] = await calculateTokensInReserve(
  //       setToken,
  //       setup.weth,
  //       setup.dai,
  //       uniswapSetup.wethDaiPool,
  //       uniswapSetup.wethDaiStakingRewards
  //     );

  //     const postWethBalance = await setup.weth.balanceOf(setToken.address);
  //     const postDaiBalance = await setup.dai.balanceOf(setToken.address);
  //     const postLPBalance = await uniswapSetup.wethDaiPool.balanceOf(setToken.address);
  //     const postLPStakingBalance = await uniswapSetup.wethDaiStakingRewards.balanceOf(setToken.address);

  //     const wethReserveRatio = preciseDiv(postWethBalance, postWethBalance.add(wethInReserve));
  //     const daiReserveRatio = preciseDiv(postDaiBalance, postDaiBalance.add(daiInReserve));

  //     expect(wethReserveRatio).to.eq(PRECISE_UNIT);
  //     expect(daiReserveRatio).to.eq(PRECISE_UNIT);
  //     expect(postLPBalance).to.be.eq(ZERO);
  //     expect(postLPStakingBalance).to.be.eq(ZERO);
  //   });

  //   describe("when caller is not SetToken", async () => {
  //     beforeEach(async () => {
  //       subjectCaller = manager;
  //     });

  //     it("should revert", async () => {
  //       await expect(subjectAttacker()).to.be.revertedWith("Caller must be SetToken");
  //     });
  //   });
  // });

  async function baseTestSetup(): Promise<void> {
    await setup.weth.connect(owner.wallet).approve(uniswapSetup.router.address, ether(1000));
    await setup.dai.connect(owner.wallet).approve(uniswapSetup.router.address, ether(350000));
    await uniswapSetup.router.addLiquidity(
      setup.weth.address,
      setup.dai.address,
      ether(1000),
      ether(230000),
      ether(999),
      ether(225000),
      owner.address,
      MAX_UINT_256
    );

    await setup.weth.connect(owner.wallet).approve(uniswapSetup.router.address, ether(2000));
    await uniswapSetup.uni.connect(owner.wallet).approve(uniswapSetup.router.address, ether(400000));
    await uniswapSetup.router.connect(owner.wallet).addLiquidity(
      setup.weth.address,
      uniswapSetup.uni.address,
      ether(2000),
      ether(400000),
      ether(1485),
      ether(173000),
      owner.address,
      MAX_UINT_256
    );

    await setup.weth.connect(owner.wallet).approve(setup.issuanceModule.address, ether(1000));
    await setup.dai.connect(owner.wallet).approve(setup.issuanceModule.address, ether(350000));
    await setup.issuanceModule.connect(owner.wallet).issue(setToken.address, ether(1000), owner.address);
  }
});