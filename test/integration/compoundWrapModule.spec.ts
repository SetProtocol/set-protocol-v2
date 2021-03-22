import "module-alias/register";
import { BigNumber } from "@ethersproject/bignumber";

import { Address } from "@utils/types";
import { Account } from "@utils/test/types";
import { ADDRESS_ZERO } from "@utils/constants";
import { CompoundWrapAdapter, SetToken, WrapModule } from "@utils/contracts";
import { CERc20 } from "@utils/contracts/compound";
import DeployHelper from "@utils/deploys";
import {
  ether,
  preciseMul,
} from "@utils/index";
import {
  getAccounts,
  getWaffleExpect,
  getSystemFixture,
  getCompoundFixture,
  addSnapshotBeforeRestoreAfterEach,
} from "@utils/test/index";
import { CompoundFixture, SystemFixture } from "@utils/fixtures";

const expect = getWaffleExpect();

describe("compoundWrapModule", () => {
  let owner: Account;
  let deployer: DeployHelper;
  let setup: SystemFixture;

  let compoundSetup: CompoundFixture;
  let cDai: CERc20;

  let wrapModule: WrapModule;

  const compoundWrapAdapterIntegrationName: string = "COMPOUND_WRAPPER";

  before(async () => {
    [
      owner,
    ] = await getAccounts();

    // System setup
    deployer = new DeployHelper(owner.wallet);
    setup = getSystemFixture(owner.address);
    await setup.initialize();

    // Compound setup
    compoundSetup = getCompoundFixture(owner.address);
    await compoundSetup.initialize();

    cDai = await compoundSetup.createAndEnableCToken(
      setup.dai.address,
      ether(1),
      compoundSetup.comptroller.address,
      compoundSetup.interestRateModel.address,
      "Compound DAI",
      "cDAI",
      8,
      ether(0.75), // 75% collateral factor
      ether(1)
    );

    // WrapModule setup
    wrapModule = await deployer.modules.deployWrapModule(setup.controller.address, setup.weth.address);
    await setup.controller.addModule(wrapModule.address);

    // compoundWrapAdapter setup
    const compoundLibrary = await deployer.libraries.deployCompound();
    const compoundWrapAdapter = await deployer.adapters.deployCompoundWrapAdapter("Compound", compoundLibrary.address);
    await setup.integrationRegistry.addIntegration(wrapModule.address, compoundWrapAdapterIntegrationName, compoundWrapAdapter.address);
  });

  addSnapshotBeforeRestoreAfterEach();

  context("when a SetToken has been deployed and issued", async () => {
    let setToken: SetToken;
    let setTokensIssued: BigNumber;

    before(async () => {
      setToken = await setup.createSetToken(
        [setup.dai.address],
        [ether(1)],
        [setup.issuanceModule.address, wrapModule.address]
      );

      // Initialize modules
      await setup.issuanceModule.initialize(setToken.address, ADDRESS_ZERO);
      await wrapModule.initialize(setToken.address);

      // Issue some Sets
      setTokensIssued = ether(10);
      const underlyingRequired = setTokensIssued;
      await setup.dai.approve(setup.issuanceModule.address, underlyingRequired);
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
        subjectUnderlyingToken = setup.dai.address;
        subjectWrappedToken = cDai.address;
        subjectUnderlyingUnits = ether(1);
        subjectIntegrationName = compoundWrapAdapterIntegrationName;
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
        const previousUnderlyingBalance = await setup.dai.balanceOf(setToken.address);
        const previousWrappedBalance = await cDai.balanceOf(setToken.address);

        await subject();

        const underlyingBalance = await setup.dai.balanceOf(setToken.address);

        const wrappedBalance = await cDai.balanceOf(setToken.address);

        const expectedUnderlyingBalance = previousUnderlyingBalance.sub(setTokensIssued);
        expect(underlyingBalance).to.eq(expectedUnderlyingBalance);

        const expectedWrappedBalance = previousWrappedBalance.add(setTokensIssued);
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
        subjectUnderlyingToken = setup.dai.address;
        subjectWrappedToken = cDai.address;
        subjectWrappedTokenUnits = ether(0.5);
        subjectIntegrationName = compoundWrapAdapterIntegrationName;
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
          subjectIntegrationName
        );
      }

      it("should burn the wrapped asset to the SetToken and increase the underlying quantity", async () => {
        const previousUnderlyingBalance = await setup.dai.balanceOf(setToken.address);
        const previousWrappedBalance = await cDai.balanceOf(setToken.address);

        await subject();

        const underlyingBalance = await setup.dai.balanceOf(setToken.address);
        const wrappedBalance = await cDai.balanceOf(setToken.address);

        const delta = preciseMul(setTokensIssued, wrappedQuantity.sub(subjectWrappedTokenUnits));

        const expectedUnderlyingBalance = previousUnderlyingBalance.add(delta);
        expect(underlyingBalance).to.eq(expectedUnderlyingBalance);

        const expectedWrappedBalance = previousWrappedBalance.sub(delta);
        expect(wrappedBalance).to.eq(expectedWrappedBalance);
      });
    });
  });
});
