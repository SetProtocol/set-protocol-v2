import "module-alias/register";
import { BigNumber } from "ethers";

import { Address } from "@utils/types";
import { Account } from "@utils/test/types";
import { ADDRESS_ZERO, ZERO } from "@utils/constants";
import { RgtMigrationWrapAdapter, SetToken, StandardTokenMock, WrapModule } from "@utils/contracts";
import DeployHelper from "@utils/deploys";
import {
  ether,
} from "@utils/index";
import {
  addSnapshotBeforeRestoreAfterEach,
  getAccounts,
  getWaffleExpect,
  getSystemFixture,
} from "@utils/test/index";
import { SystemFixture } from "@utils/fixtures";

const expect = getWaffleExpect();

describe("rgtMigrationWrapModule", () => {
  let owner: Account;
  let deployer: DeployHelper;
  let setup: SystemFixture;

  let wrapModule: WrapModule;

  let rgtToken: StandardTokenMock;
  let tribeToken: StandardTokenMock;
  let adapter: RgtMigrationWrapAdapter;

  const rgtMigrationWrapAdapterIntegrationName: string = "RGT_MIGRATION_WRAPPER";

  before(async () => {
    [
      owner,
    ] = await getAccounts();

    // System setup
    deployer = new DeployHelper(owner.wallet);
    setup = getSystemFixture(owner.address);
    await setup.initialize();

    // WrapModule setup
    wrapModule = await deployer.modules.deployWrapModule(setup.controller.address, setup.weth.address);
    await setup.controller.addModule(wrapModule.address);

    // RgtMigrationWrapV2Adapter setup
    rgtToken = await deployer.mocks.deployTokenMock(owner.address);
    tribeToken = await deployer.mocks.deployTokenMock(owner.address);

    const rariTimelock = await deployer.external.deployRariTimelock(owner.address, 3);
    const tribe = await deployer.external.deployFeiTribe(owner.address, owner.address);
    const rariTribeDao = await deployer.external.deployFeiDAO(tribe.address, rariTimelock.address, ADDRESS_ZERO);
    const pegExchanger = await deployer.external.deployPegExchanger(rariTribeDao.address);
    adapter = await deployer.adapters.deployRgtMigrationWrapAdapter(pegExchanger.address);

    await setup.integrationRegistry.addIntegration(wrapModule.address, rgtMigrationWrapAdapterIntegrationName, adapter.address);
  });

  addSnapshotBeforeRestoreAfterEach();

  context("when a SetToken has been deployed and issued", async () => {
    let setToken: SetToken;
    let setTokensIssued: BigNumber;

    before(async () => {
      setToken = await setup.createSetToken(
        [rgtToken.address],
        [BigNumber.from(10 ** 8)],
        [setup.issuanceModule.address, wrapModule.address]
      );

      // Initialize modules
      await setup.issuanceModule.initialize(setToken.address, ADDRESS_ZERO);
      await wrapModule.initialize(setToken.address);

      // Issue some Sets
      setTokensIssued = ether(10);
      const underlyingRequired = setTokensIssued.div(10 ** 9);
      await rgtToken.approve(setup.issuanceModule.address, underlyingRequired);
      await setup.issuanceModule.issue(setToken.address, setTokensIssued, owner.address);
    });

    describe("#wrap", async () => {
      let subjectSetToken: Address;
      let subjectUnderlyingToken: Address;
      let subjectWrappedToken: Address;
      let subjectUnderlyingUnits: BigNumber;
      let subjectIntegrationName: string;
      let subjectCaller: Account;

      beforeEach(async () => {
        subjectSetToken = setToken.address;
        subjectUnderlyingToken = rgtToken.address;
        subjectWrappedToken = tribeToken.address;
        subjectUnderlyingUnits = BigNumber.from(10 ** 8);
        subjectIntegrationName = rgtMigrationWrapAdapterIntegrationName;
        subjectCaller = owner;
      });

      async function subject(): Promise<any> {
        return wrapModule.connect(subjectCaller.wallet).wrap(
          subjectSetToken,
          subjectUnderlyingToken,
          subjectWrappedToken,
          subjectUnderlyingUnits,
          subjectIntegrationName
        );
      }

      it("should convert underlying balance of RGT tokens to TRIBE tokens * 26705673430 / 10e9", async () => {
        const previousRgtTokenBalance = await rgtToken.balanceOf(setToken.address);
        const previousTribeTokenBalance = await tribeToken.balanceOf(setToken.address);
        expect(previousRgtTokenBalance).to.eq(BigNumber.from(10 ** 9));
        expect(previousTribeTokenBalance).to.eq(ZERO);

        await subject();

        const rgtTokenBalance = await rgtToken.balanceOf(setToken.address);
        const tribeTokenBalance = await tribeToken.balanceOf(setToken.address);
        const components = await setToken.getComponents();

        expect(rgtTokenBalance).to.eq(ZERO);
        expect(tribeTokenBalance).to.eq(previousRgtTokenBalance.mul(26705673430).div(10e9));
        expect(components.length).to.eq(1);
      });
    });

    describe("#unwrap", async () => {
      let subjectSetToken: Address;
      let subjectUnderlyingToken: Address;
      let subjectWrappedToken: Address;
      let subjectWrappedUnits: BigNumber;
      let subjectIntegrationName: string;
      let subjectCaller: Account;

      beforeEach(async () => {
        subjectSetToken = setToken.address;
        subjectUnderlyingToken = rgtToken.address;
        subjectWrappedToken = tribeToken.address;
        subjectWrappedUnits = BigNumber.from(10 ** 8);
        subjectIntegrationName = rgtMigrationWrapAdapterIntegrationName;
        subjectCaller = owner;

        await wrapModule.connect(subjectCaller.wallet).wrap(
          subjectSetToken,
          subjectUnderlyingToken,
          subjectWrappedToken,
          subjectWrappedUnits,
          subjectIntegrationName
        );
      });

      async function subject(): Promise<any> {
        return wrapModule.connect(subjectCaller.wallet).unwrap(
          subjectSetToken,
          subjectUnderlyingToken,
          subjectWrappedToken,
          subjectWrappedUnits,
          subjectIntegrationName
        );
      }

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("RGT migration cannot be reversed");
      });
    });
  });
});
