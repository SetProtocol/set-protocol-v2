import "module-alias/register";
import { BigNumber } from "@ethersproject/bignumber";

import { Address, Account } from "@utils/types";
import { ADDRESS_ZERO } from "@utils/constants";
import { AaveMigrationWrapAdapter, SetToken, WrapModule } from "@utils/contracts";
import DeployHelper from "@utils/deploys";
import {
  addSnapshotBeforeRestoreAfterEach,
  ether,
  getAccounts,
  getWaffleExpect,
  getSystemFixture,
  getAaveFixture,
} from "@utils/index";
import { AaveFixture, SystemFixture } from "@utils/fixtures";

const expect = getWaffleExpect();

describe("AaveMigrationWrapModule", () => {
  let owner: Account;
  let deployer: DeployHelper;
  let setup: SystemFixture;

  let aaveSetup: AaveFixture;

  let wrapModule: WrapModule;
  let aaveMigrationWrapAdapter: AaveMigrationWrapAdapter;

  const aaveMigrationWrapAdapterIntegrationName: string = "AAVE_MIGRATION_WRAPPER";

  before(async () => {
    [
      owner,
    ] = await getAccounts();

    // System setup
    deployer = new DeployHelper(owner.wallet);
    setup = getSystemFixture(owner.address);
    await setup.initialize();

    // Aave setup
    aaveSetup = getAaveFixture(owner.address);
    await aaveSetup.initialize();

    // WrapModule setup
    wrapModule = await deployer.modules.deployWrapModule(setup.controller.address, setup.weth.address);
    await setup.controller.addModule(wrapModule.address);

    // AaveMigrationWrapAdapter setup
    aaveMigrationWrapAdapter = await deployer.adapters.deployAaveMigrationWrapAdapter(
      aaveSetup.lendToAaveMigrator.address,
      aaveSetup.lendToken.address,
      aaveSetup.aaveToken.address
    );

    await setup.integrationRegistry.addIntegration(wrapModule.address, aaveMigrationWrapAdapterIntegrationName, aaveMigrationWrapAdapter.address);
  });

  addSnapshotBeforeRestoreAfterEach();

  context("when a SetToken has been deployed and issued", async () => {
    let setToken: SetToken;
    let setTokensIssued: BigNumber;

    before(async () => {
      setToken = await setup.createSetToken(
        [aaveSetup.lendToken.address],
        [ether(1)],
        [setup.issuanceModule.address, wrapModule.address]
      );

      // Initialize modules
      await setup.issuanceModule.initialize(setToken.address, ADDRESS_ZERO);
      await wrapModule.initialize(setToken.address);

      // Issue some Sets
      setTokensIssued = ether(10);
      const underlyingRequired = setTokensIssued;
      await aaveSetup.lendToken.approve(setup.issuanceModule.address, underlyingRequired);

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
        subjectUnderlyingToken = aaveSetup.lendToken.address;
        subjectWrappedToken = aaveSetup.aaveToken.address;
        subjectUnderlyingUnits = ether(1);
        subjectIntegrationName = aaveMigrationWrapAdapterIntegrationName;
        subjectCaller = owner;
      });

      async function subject(): Promise<any> {
        return wrapModule.connect(subjectCaller.wallet).wrap(
          subjectSetToken,
          subjectUnderlyingToken,
          subjectWrappedToken,
          subjectUnderlyingUnits,
          subjectIntegrationName,
        );
      }

      it("should reduce the underlying quantity and mint the wrapped asset to the SetToken", async () => {
        const previousUnderlyingBalance = await aaveSetup.lendToken.balanceOf(setToken.address);
        const previousWrappedBalance = await aaveSetup.aaveToken.balanceOf(setToken.address);

        await subject();

        const underlyingBalance = await aaveSetup.lendToken.balanceOf(setToken.address);
        const wrappedBalance = await aaveSetup.aaveToken.balanceOf(setToken.address);

        const expectedUnderlyingBalance = previousUnderlyingBalance.sub(setTokensIssued);
        expect(underlyingBalance).to.eq(expectedUnderlyingBalance);

        const expectedWrappedBalance = previousWrappedBalance.add(setTokensIssued.div(aaveSetup.aaveExchangeRatio));
        expect(wrappedBalance).to.eq(expectedWrappedBalance);
      });
    });

    describe("#unwrap", () => {
      let subjectSetToken: Address;
      let subjectUnderlyingToken: Address;
      let subjectWrappedToken: Address;
      let subjectWrappedTokenUnits: BigNumber;
      let subjectIntegrationName: string;
      let subjectCaller: Account;

      let wrappedQuantity: BigNumber;

      beforeEach(async () => {
        subjectSetToken = setToken.address;
        subjectUnderlyingToken = aaveSetup.lendToken.address;
        subjectWrappedToken = aaveSetup.aaveToken.address;
        subjectWrappedTokenUnits = ether(0.01);
        subjectIntegrationName = aaveMigrationWrapAdapterIntegrationName;
        subjectCaller = owner;

        wrappedQuantity = ether(1);

        await wrapModule.wrap(
          subjectSetToken,
          subjectUnderlyingToken,
          subjectWrappedToken,
          wrappedQuantity,
          subjectIntegrationName,
        );
      });

      async function subject(): Promise<any> {
        return wrapModule.connect(subjectCaller.wallet).unwrap(
          subjectSetToken,
          subjectUnderlyingToken,
          subjectWrappedToken,
          subjectWrappedTokenUnits,
          subjectIntegrationName,
          {
            gasLimit: 5000000,
          }
        );
      }

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("AAVE migration cannot be reversed");
      });
    });
  });
});
