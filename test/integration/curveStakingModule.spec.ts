import "module-alias/register";
import { BigNumber } from "ethers";

import { Address } from "@utils/types";
import { Account } from "@utils/test/types";
import { ADDRESS_ZERO, ZERO } from "@utils/constants";
import { AirdropModule, CurveStakingAdapter, SetToken, StakingModule, StandardTokenMock } from "@utils/contracts";
import DeployHelper from "@utils/deploys";
import {
  ether,
} from "@utils/index";
import {
  getAccounts,
  getWaffleExpect,
  getSystemFixture,
  getCurveFixture,
  addSnapshotBeforeRestoreAfterEach,
} from "@utils/test/index";
import { CurveFixture, SystemFixture } from "@utils/fixtures";
import { LiquidityGauge } from "@utils/contracts/curve";

const expect = getWaffleExpect();

describe("curveStakingModule", () => {
  let owner: Account;
  let deployer: DeployHelper;
  let setup: SystemFixture;
  let stakingModule: StakingModule;
  let curveStaking: CurveStakingAdapter;
  let airdropModule: AirdropModule;

  let curveSetup: CurveFixture;
  let usdt: StandardTokenMock;
  let susd: StandardTokenMock;
  let gauge: LiquidityGauge;

  const curveStakingAdapterIntegrationName: string = "CURVE_STAKE";

  before(async () => {
    [
      owner,
    ] = await getAccounts();

    deployer = new DeployHelper(owner.wallet);
    setup = getSystemFixture(owner.address);
    await setup.initialize();
    // Add owner.address as module so it can call invoke method
    await setup.controller.addModule(owner.address);

    // Extra tokens setup
    usdt = await deployer.mocks.deployTokenMock(owner.address, ether(10000), 6);
    susd = await deployer.mocks.deployTokenMock(owner.address, ether(10000), 18);

    // Curve system setup
    curveSetup = getCurveFixture(owner.address);
    await curveSetup.initializePool([setup.dai.address, setup.usdc.address, usdt.address, susd.address]);
    await curveSetup.initializeDAO();
    gauge = await curveSetup.initializeGauge(curveSetup.poolToken.address);

    // Add staking module
    stakingModule = await deployer.modules.deployStakingModule(setup.controller.address);
    await setup.controller.addModule(stakingModule.address);

    // Add Curve Staking Module Adapter
    curveStaking = await deployer.adapters.deployCurveStakingAdapter(curveSetup.gaugeController.address);
    await setup.integrationRegistry.addIntegration(stakingModule.address, curveStakingAdapterIntegrationName, curveStaking.address);

    // Add airdrop module to absorb the lp token
    airdropModule = await deployer.modules.deployAirdropModule(setup.controller.address);
    await setup.controller.addModule(airdropModule.address);

    // Add some base liquidity to the curve pool
    const subject18DecimalAmount = ether(10);
    const subject6DecimalAmount = 10000000;
    await setup.dai.approve(curveSetup.deposit.address, subject18DecimalAmount);
    await setup.usdc.approve(curveSetup.deposit.address, subject6DecimalAmount);
    await usdt.approve(curveSetup.deposit.address, subject6DecimalAmount);
    await susd.approve(curveSetup.deposit.address, subject18DecimalAmount);

    await curveSetup.deposit.add_liquidity(
      [subject18DecimalAmount, subject6DecimalAmount, subject6DecimalAmount, subject18DecimalAmount],
      0,
      {
        gasLimit: 5000000,
      });
  });

  addSnapshotBeforeRestoreAfterEach();
  context("when a SetToken has been deployed and issued", async () => {
    let setToken: SetToken;
    let setTokensIssued: BigNumber;

    before(async () => {
      setToken = await setup.createSetToken(
        [setup.dai.address],
        [ether(1)],
        [setup.issuanceModule.address, stakingModule.address, airdropModule.address, owner.address]
      );

      // Initialize modules
      await setToken.initializeModule(); // initializes owner.address module
      await setup.issuanceModule.initialize(setToken.address, ADDRESS_ZERO);
      await stakingModule.initialize(
        setToken.address
      );
      await airdropModule.initialize(setToken.address, {
        airdrops: [curveSetup.poolToken.address],
        airdropFee: ZERO,
        anyoneAbsorb: true,
        feeRecipient: owner.address,
      });

      // Issue some Sets
      setTokensIssued = ether(10);
      const underlyingRequired = setTokensIssued;
      await setup.dai.approve(setup.controller.address, underlyingRequired);
      await setup.issuanceModule.issue(setToken.address, setTokensIssued, owner.address);
    });

    describe("when a SetToken provided liquidity", async () => {
      let subjectStakingContract: Address;
      let subjectSetToken: Address;
      let subjectComponent: Address;

      beforeEach(async () => {
        subjectSetToken = setToken.address;
        subjectStakingContract = gauge.address;
        subjectComponent = curveSetup.poolToken.address;
        const amount = ether(10);

        // Add liquidity to pool
        const approveDepositCallData = setup.dai.interface.encodeFunctionData("approve", [curveSetup.deposit.address, amount]);
        await setToken.invoke(setup.dai.address, ZERO, approveDepositCallData);

        const addLiquidityCallData = curveSetup.deposit.interface.encodeFunctionData("add_liquidity", [[amount, 0, 0, 0], 0]);
        await setToken.invoke(curveSetup.deposit.address, ZERO, addLiquidityCallData, {
          gasLimit: 5000000,
        });

        // Absorb the lp token into the SetToken
        await airdropModule.absorb(subjectSetToken, subjectComponent);
      });

      async function subject(): Promise<any> {
        return stakingModule.stake(
          subjectSetToken,
          subjectStakingContract,
          subjectComponent,
          curveStakingAdapterIntegrationName,
          ether(.5),
          {
            gasLimit: 5000000,
          }
        );
      }

      it("should be able to stake lp tokens to gauge", async () => {
        const prevBalance = await curveSetup.poolToken.balanceOf(subjectSetToken);

        await subject();

        const balance = await curveSetup.poolToken.balanceOf(subjectSetToken);
        expect(balance).to.lt(prevBalance);
      });

      describe("when a SetToken staked lp tokens", async () => {

        beforeEach(async () => {
          await stakingModule.stake(
            subjectSetToken,
            subjectStakingContract,
            subjectComponent,
            curveStakingAdapterIntegrationName,
            ether(.5),
            {
              gasLimit: 5000000,
            }
          );
        });

        async function subject(): Promise<any> {
          await stakingModule.unstake(
            subjectSetToken,
            subjectStakingContract,
            subjectComponent,
            curveStakingAdapterIntegrationName,
            ether(.5),
            {
              gasLimit: 5000000,
            }
          );
        }

        it("should be able to withdraw", async () => {
          const prevBalance = await curveSetup.poolToken.balanceOf(subjectSetToken);

          await subject();

          const balance = await curveSetup.poolToken.balanceOf(subjectSetToken);
          expect(balance).to.gt(prevBalance);
        });
      });
    });
  });
});
