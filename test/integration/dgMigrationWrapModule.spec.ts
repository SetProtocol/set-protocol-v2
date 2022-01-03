import "module-alias/register";
import { BigNumber } from "ethers";

import { Address } from "@utils/types";
import { Account } from "@utils/test/types";
import { ADDRESS_ZERO, ZERO } from "@utils/constants";
import { DgMigrationWrapAdapter, SetToken, WrapModule } from "@utils/contracts";
import DeployHelper from "@utils/deploys";
import {
  ether,
} from "@utils/index";
import { DGLight, DgToken } from "@utils/contracts/dg";
import {
  addSnapshotBeforeRestoreAfterEach,
  getAccounts,
  getWaffleExpect,
  getSystemFixture,
} from "@utils/test/index";
import { SystemFixture } from "@utils/fixtures";

const expect = getWaffleExpect();

describe("dgMigrationWrapModule", () => {
  let owner: Account;
  let deployer: DeployHelper;
  let setup: SystemFixture;

  let wrapModule: WrapModule;

  let dgClassic: DgToken;
  let dgLight: DGLight;
  let adapter: DgMigrationWrapAdapter;

  const dgMigrationWrapAdapterIntegrationName: string = "DG_MIGRATION_WRAPPER";

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

    // Deploy DG Classic Token (dgClassic) and DG V2 token (DGLight)
    dgClassic = await deployer.external.deployDgToken();
    dgLight = await deployer.external.deployDGLight(dgClassic.address);

    // DgMigrationWrapV2Adapter setup
    adapter = await deployer.adapters.deployDgMigrationWrapAdapter(
      dgClassic.address,
      dgLight.address
    );

    await setup.integrationRegistry.addIntegration(wrapModule.address, dgMigrationWrapAdapterIntegrationName, adapter.address);
  });

  addSnapshotBeforeRestoreAfterEach();

  context("when a SetToken has been deployed and issued", async () => {
    let setToken: SetToken;
    let setTokensIssued: BigNumber;

    before(async () => {
      setToken = await setup.createSetToken(
        [dgClassic.address],
        [BigNumber.from(10 ** 8)],
        [setup.issuanceModule.address, wrapModule.address]
      );

      // Initialize modules
      await setup.issuanceModule.initialize(setToken.address, ADDRESS_ZERO);
      await wrapModule.initialize(setToken.address);

      // Issue some Sets
      setTokensIssued = ether(10);
      const underlyingRequired = setTokensIssued.div(10 ** 9);
      await dgClassic.approve(setup.issuanceModule.address, underlyingRequired);
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
        subjectUnderlyingToken = dgClassic.address;
        subjectWrappedToken = dgLight.address;
        subjectUnderlyingUnits = BigNumber.from(10 ** 8);
        subjectIntegrationName = dgMigrationWrapAdapterIntegrationName;
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

      it("should convert underlying balance of dgClassic tokens to dgLight tokens * 1000", async () => {
        const previousDgTokenBalance = await dgClassic.balanceOf(setToken.address);
        const previousDGLightBalance = await dgLight.balanceOf(setToken.address);
        expect(previousDgTokenBalance).to.eq(BigNumber.from(10 ** 9));
        expect(previousDGLightBalance).to.eq(ZERO);

        await subject();

        const dgTokenBalance = await dgClassic.balanceOf(setToken.address);
        const DGLightBalance = await dgLight.balanceOf(setToken.address);
        const components = await setToken.getComponents();

        expect(dgTokenBalance).to.eq(ZERO);
        expect(DGLightBalance).to.eq(previousDgTokenBalance.mul(1000));
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
        subjectUnderlyingToken = dgClassic.address;
        subjectWrappedToken = dgLight.address;
        subjectWrappedUnits = BigNumber.from(10 ** 8);
        subjectIntegrationName = dgMigrationWrapAdapterIntegrationName;
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
        await expect(subject()).to.be.revertedWith("DG migration cannot be reversed");
      });
    });
  });
});
