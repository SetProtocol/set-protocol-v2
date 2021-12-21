import "module-alias/register";
import { BigNumber } from "ethers";

import { Address } from "@utils/types";
import { Account } from "@utils/test/types";
import { ADDRESS_ZERO, ZERO, ONE } from "@utils/constants";
import { DgMigrationWrapV2Adapter, SetToken, WrapModuleV2 } from "@utils/contracts";
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

  let wrapModule: WrapModuleV2;

  let dgLight: DGLight;
  let dgToken: DgToken;
  let adapter: DgMigrationWrapV2Adapter;

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
    wrapModule = await deployer.modules.deployWrapModuleV2(setup.controller.address, setup.weth.address);
    await setup.controller.addModule(wrapModule.address);

    // Deploy DG V1 and DG V2 token
    dgToken = await deployer.external.deployDgToken();
    dgLight = await deployer.external.deployDGLight(dgToken.address);

    // DgMigrationWrapV2Adapter setup
    adapter = await deployer.adapters.deployDgMigrationWrapV2Adapter(
      dgToken.address,
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
        [dgToken.address],
        [BigNumber.from(10 ** 8)],
        [setup.issuanceModule.address, wrapModule.address]
      );

      // Initialize modules
      await setup.issuanceModule.initialize(setToken.address, ADDRESS_ZERO);
      await wrapModule.initialize(setToken.address);

      // Issue some Sets
      setTokensIssued = ether(10);
      const underlyingRequired = setTokensIssued.div(10 ** 10);
      await dgToken.approve(setup.issuanceModule.address, underlyingRequired);

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
        subjectUnderlyingToken = dgToken.address;
        subjectWrappedToken = dgLight.address;
        subjectUnderlyingUnits = BigNumber.from(10 ** 8);
        subjectIntegrationName = dgMigrationWrapAdapterIntegrationName;
        subjectCaller = owner;
      });

      async function subject(): Promise<any> {
        const wrapData = await adapter.getWrapCallData(subjectUnderlyingToken, subjectWrappedToken, subjectUnderlyingUnits);
        return wrapModule.connect(subjectCaller.wallet).wrap(
          subjectSetToken,
          subjectUnderlyingToken,
          subjectWrappedToken,
          subjectUnderlyingUnits,
          subjectIntegrationName,
          wrapData[2],
        );
      }

      it("should convert underlying balance of dg tokens to dgLight tokens * 1000", async () => {
        const previousUnderlyingBalance = await dgToken.balanceOf(setToken.address);

        await subject();

        const underlyingBalance = await dgToken.balanceOf(setToken.address);
        const dgTokenUnit = await setToken.getDefaultPositionRealUnit(dgToken.address);
        const dgLightUnit = await setToken.getDefaultPositionRealUnit(dgLight.address);
        const components = await setToken.getComponents();

        expect(underlyingBalance).to.eq(previousUnderlyingBalance);
        expect(dgTokenUnit).to.eq(ZERO);
        expect(dgLightUnit).to.eq(previousUnderlyingBalance.mul(1000));
        expect(components.length).to.eq(ONE);
      });
    });
  });
});
