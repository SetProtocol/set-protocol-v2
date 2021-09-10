import "module-alias/register";
import { BigNumber } from "ethers";

import { Address } from "@utils/types";
import { Account } from "@utils/test/types";
import { ADDRESS_ZERO, ZERO } from "@utils/constants";
import {
  AGIMigrationWrapAdapter,
  SetToken,
  SingularityNetToken,
  StandardTokenMock,
  WrapModule
} from "@utils/contracts";
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

describe("AGIMigrationWrapModule", () => {
  let owner: Account;
  let deployer: DeployHelper;
  let setup: SystemFixture;

  let wrapModule: WrapModule;
  let agiMigrationWrapAdapter: AGIMigrationWrapAdapter;
  let agiToken: SingularityNetToken;
  let agixToken: StandardTokenMock;

  const agiMigrationWrapAdapterIntegrationName: string = "AGI_MIGRATION_WRAPPER";

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

    // Deploy AGI and AGIX token
    agiToken = await deployer.external.deploySingularityNetToken();
    agixToken = await deployer.mocks.deployTokenMock(owner.address);

    // AaveMigrationWrapAdapter setup
    agiMigrationWrapAdapter = await deployer.adapters.deployAGIMigrationWrapAdapter(
      agiToken.address,
      agixToken.address
    );

    await setup.integrationRegistry.addIntegration(wrapModule.address, agiMigrationWrapAdapterIntegrationName, agiMigrationWrapAdapter.address);
  });

  addSnapshotBeforeRestoreAfterEach();

  context("when a SetToken has been deployed and issued", async () => {
    let setToken: SetToken;
    let setTokensIssued: BigNumber;

    before(async () => {
      setToken = await setup.createSetToken(
        [agiToken.address],
        [BigNumber.from(10 ** 8)],
        [setup.issuanceModule.address, wrapModule.address]
      );

      // Initialize modules
      await setup.issuanceModule.initialize(setToken.address, ADDRESS_ZERO);
      await wrapModule.initialize(setToken.address);

      // Issue some Sets
      setTokensIssued = ether(10);
      const underlyingRequired = setTokensIssued.div(10 ** 10);
      await agiToken.approve(setup.issuanceModule.address, underlyingRequired);

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
        subjectUnderlyingToken = agiToken.address;
        subjectWrappedToken = agixToken.address;
        subjectUnderlyingUnits = BigNumber.from(10 ** 8);
        subjectIntegrationName = agiMigrationWrapAdapterIntegrationName;
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

      it("should reduce the zero out the AGI unit and remove token from components", async () => {
        const previousUnderlyingBalance = await agiToken.balanceOf(setToken.address);

        await subject();

        const underlyingBalance = await agiToken.balanceOf(setToken.address);
        const agiTokenUnit = await setToken.getDefaultPositionRealUnit(agiToken.address);
        const agxTokenUnit = await setToken.getDefaultPositionRealUnit(agixToken.address);
        const components = await setToken.getComponents();

        const expectedUnderlyingBalance = previousUnderlyingBalance.sub(setTokensIssued.div(10 ** 10));
        expect(underlyingBalance).to.eq(expectedUnderlyingBalance);
        expect(agiTokenUnit).to.eq(ZERO);
        expect(agxTokenUnit).to.eq(ZERO);
        expect(components.length).to.eq(ZERO);
      });
    });
  });
});
