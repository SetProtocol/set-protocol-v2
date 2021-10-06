import "module-alias/register";

import { Account } from "@utils/test/types";

import {
  addSnapshotBeforeRestoreAfterEach,
  getAccounts,
  getSystemFixture,
  getBalancerV2Fixture,
} from "@utils/test/index";
import { SystemFixture, BalancerV2Fixture } from "@utils/fixtures";
import { expect } from "chai";
import { BigNumber } from "@ethersproject/bignumber";
import { Address } from "@utils/types";
import { ether } from "@utils/index";


describe("BalancerFixture", () => {
  let owner: Account;

  let setup: SystemFixture;
  let balancerSetup: BalancerV2Fixture;

  before(async () => {
    [
      owner,
    ] = await getAccounts();

    setup = getSystemFixture(owner.address);
    balancerSetup = getBalancerV2Fixture(owner.address);

    await setup.initialize();
  });

  addSnapshotBeforeRestoreAfterEach();

  describe("#initialize", async () => {
    async function subject(): Promise<any> {
      await balancerSetup.initialize(owner, setup.weth, setup.wbtc, setup.dai);
    }

    it("should deploy core balancer V2 contacts", async () => {
      await subject();

      expect(balancerSetup.vault).to.exist;
      expect(balancerSetup.weightedPoolFactory).to.exist;
    });

    it("should create a WETH-DAI pool", async () => {
      await subject();

      expect(balancerSetup.wethDaiPoolId).to.exist;
    });
  });

  describe("#createPool", async () => {
    let subjectTokens: Address[];
    let subjectWeights: BigNumber[];

    beforeEach(async () => {
      await balancerSetup.initialize(owner, setup.weth, setup.wbtc, setup.dai);

      subjectTokens = [setup.wbtc.address, setup.weth.address];
      subjectWeights = [ether(0.3), ether(0.7)];
    });

    async function subject(): Promise<string> {
      return await balancerSetup.createPool(subjectTokens, subjectWeights);
    }

    it("should return a pool id", async () => {
      const id = await subject();

      expect(id).to.not.eq("");
    });
  });
});