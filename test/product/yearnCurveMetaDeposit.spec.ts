import "module-alias/register";

import {
  addSnapshotBeforeRestoreAfterEach,
  getAccounts,
  getRandomAddress,
  getSystemFixture,
  getWaffleExpect,
  getYearnFixture,
} from "@utils/test/index";

import DeployHelper from "@utils/deploys";
import { Account } from "@utils/test/types";
import { CurveMetaPoolZapMock, CurveRegistryMock, StandardTokenMock, YearnCurveMetaDeposit } from "@utils/contracts";
import { Vault } from "@utils/contracts/yearn";
import { Address, ContractTransaction, CurveUnderlyingTokens } from "@utils/types";
import { ether, preciseMul } from "@utils/index";
import { ADDRESS_ZERO } from "@utils/constants";
import { SystemFixture, YearnFixture } from "@utils/fixtures";
import { BigNumber } from "@ethersproject/bignumber";

const expect = getWaffleExpect();

describe("YearnCurveMetaDeposit", async () => {

  let owner: Account;
  let user: Account;
  let deployer: DeployHelper;
  let yearnSetup: YearnFixture;
  let systemSetup: SystemFixture;

  let metaPool: Address;
  let metaPoolLpToken: StandardTokenMock;
  let underlyingPoolTokens: CurveUnderlyingTokens;

  let alUSD: StandardTokenMock;

  let curve3Pool: CurveMetaPoolZapMock;
  let curveRegistry: CurveRegistryMock;

  let yVault: Vault;

  let yearnCurveDeposit: YearnCurveMetaDeposit;

  before(async () => {
    [ owner, user ] = await getAccounts();

    deployer = new DeployHelper(owner.wallet);

    systemSetup = getSystemFixture(owner.address);
    await systemSetup.initialize();

    metaPoolLpToken = await deployer.mocks.deployTokenMock(owner.address, ether(1000), 18, "Curve alUSD/3Pool", "crv-alUSD-3Pool");
    alUSD = await deployer.mocks.deployTokenMock(owner.address, ether(10000), 18, "Alchemix USD", "alUSD");
    metaPool = metaPoolLpToken.address;   // usually Curve pools are the same as the LP token address (but not always)

    underlyingPoolTokens = [
      alUSD.address,
      systemSetup.usdc.address,
      systemSetup.dai.address,
      ADDRESS_ZERO,
      ADDRESS_ZERO,
      ADDRESS_ZERO,
      ADDRESS_ZERO,
      ADDRESS_ZERO,
    ];

    curveRegistry = await deployer.mocks.deployCurveRegistryMock(metaPool, underlyingPoolTokens);
    curve3Pool = await deployer.mocks.deployCurveMetaPoolZapMock(metaPoolLpToken.address, alUSD.address, ether(3), ether(10));
    yearnCurveDeposit = await deployer.product.deployYearnCurveMetaDeposit(curveRegistry.address, curve3Pool.address);

    metaPoolLpToken.transfer(curve3Pool.address, ether(100));

    yearnSetup = getYearnFixture(owner.address);
    await yearnSetup.initialize();
    yVault = await yearnSetup.createAndEnableVaultWithStrategyMock(
      metaPoolLpToken.address,
      owner.address,
      owner.address,
      owner.address,
      "Yearn Curve alUSD-3Pool Vault",
      "yCRValUSD",
      ether(100000)
    );
  });

  addSnapshotBeforeRestoreAfterEach();

  describe("#constructor", async () => {
    let subjectCurveRegistry: Address;
    let subjectMetaPoolZap: Address;

    beforeEach(async () => {
      subjectCurveRegistry = await getRandomAddress();
      subjectMetaPoolZap = await getRandomAddress();
    });

    async function subject(): Promise<YearnCurveMetaDeposit> {
      return await deployer.product.deployYearnCurveMetaDeposit(subjectCurveRegistry, subjectMetaPoolZap);
    }

    it("should set the correct state variables", async () => {
      const yearnCurveDeposit = await subject();

      expect(await yearnCurveDeposit.curveRegistry()).to.eq(subjectCurveRegistry);
      expect(await yearnCurveDeposit.metaPoolZap()).to.eq(subjectMetaPoolZap);
    });
  });

  describe("#deposit", async () => {
    let subjectCaller: Account;
    let subjectYVault: Vault;
    let subjectInputToken: StandardTokenMock;
    let subjectInputTokenAmount: BigNumber;
    let subjectMinYTokenReceive: BigNumber;

    beforeEach(async () => {
      subjectCaller = user;
      subjectYVault = yVault;
      subjectInputToken = alUSD;
      subjectInputTokenAmount = ether(10);
      subjectMinYTokenReceive = ether(0);

      await subjectInputToken.transfer(user.address, subjectInputTokenAmount);
      await subjectInputToken.connect(subjectCaller.wallet).approve(yearnCurveDeposit.address, ether(10));
    });

    async function subject(): Promise<ContractTransaction> {
      return yearnCurveDeposit.connect(subjectCaller.wallet).deposit(
        subjectYVault.address,
        subjectInputToken.address,
        subjectInputTokenAmount,
        subjectMinYTokenReceive
      );
    }

    it("should mint the correct amount of yTokens", async () => {
      const initYTokens = await subjectYVault.balanceOf(subjectCaller.address);
      await subject();
      const finalYTokens = await subjectYVault.balanceOf(subjectCaller.address);

      const expectedCrvTokens = ether(3);
      const exchangeRate = await yVault.pricePerShare();
      const expectedYTokens = preciseMul(expectedCrvTokens, exchangeRate);

      expect(finalYTokens.sub(initYTokens)).to.eq(expectedYTokens);
    });

    it("should spend the correct amount of input tokens", async () => {
      const initInputTokens = await subjectInputToken.balanceOf(subjectCaller.address);
      await subject();
      const finalInputTokens = await subjectInputToken.balanceOf(subjectCaller.address);

      expect(initInputTokens.sub(finalInputTokens)).to.eq(subjectInputTokenAmount);
    });
  });
});