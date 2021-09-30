import "module-alias/register";

import { Account } from "@utils/test/types";
import {
  addSnapshotBeforeRestoreAfterEach,
  getAccounts,
  getPerpV2Fixture,
  getWaffleExpect,
} from "@utils/test/index";

import { PerpV2Fixture } from "@utils/fixtures";

const expect = getWaffleExpect();

describe("PerpV2Fixture", () => {
  let owner: Account;
  let maker: Account;
  // let trader: Account;
  let perpV2: PerpV2Fixture;

  before(async () => {
    [ owner, maker, /*trader*/ ] = await getAccounts();
    perpV2 = getPerpV2Fixture(owner.address);
    await perpV2.initialize();
  });

  addSnapshotBeforeRestoreAfterEach();

  describe("#initializePoolWithLiquidityWide", () => {
    const subjectBaseTokenAmount = "10000";
    const subjectQuoteTokenAmount = "100000";

    async function subject(): Promise<void> {
      return await perpV2.initializePoolWithLiquidityWide(
        maker,
        subjectBaseTokenAmount,
        subjectQuoteTokenAmount
      );
    }

    it.skip("should have the expected baseToken price at beginning", async () => {
      await subject();

      const baseTokenPrice = await perpV2.getAMMBaseTokenPrice();
      expect(baseTokenPrice).to.equal("10");
      console.log("baseTokenPrice --> " + baseTokenPrice);
    });

    it.skip("should open a position and the price should change", () => {

    });

  });

  describe("#initializePoolWithLiquidityWithinTicks", () => {

  });


});
