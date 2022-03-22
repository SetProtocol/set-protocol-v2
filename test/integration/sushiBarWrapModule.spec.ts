import "module-alias/register";
import { BigNumber } from "@ethersproject/bignumber";

import { Address } from "@utils/types";
import { Account } from "@utils/test/types";
import { ADDRESS_ZERO } from "@utils/constants";
import {
  SushiBar,
  SushiBarWrapAdapter,
  SetToken,
  StandardTokenMock,
  WrapModule
} from "@utils/contracts";
import DeployHelper from "@utils/deploys";
import {
  ether,
  preciseMul
} from "@utils/index";
import {
  addSnapshotBeforeRestoreAfterEach,
  getAccounts,
  getWaffleExpect,
  getSystemFixture,
} from "@utils/test/index";
import { SystemFixture } from "@utils/fixtures";

const expect = getWaffleExpect();

describe("SushiBarWrapModule", () => {
  let owner: Account;
  let deployer: DeployHelper;
  let setup: SystemFixture;

  let wrapModule: WrapModule;
  let sushiBarWrapAdapter: SushiBarWrapAdapter;
  let sushiToken: StandardTokenMock;
  let xSushiToken: SushiBar;

  const sushiBarWrapAdapterIntegrationName: string = "SUSHI_BAR_WRAP_ADAPTER";

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

    // Deploy SUSHI and xSUSHI tokens
    sushiToken = await deployer.mocks.deployTokenMock(owner.address);
    xSushiToken = await deployer.external.deploySushiBar(sushiToken.address);

    // AaveMigrationWrapAdapter setup
    sushiBarWrapAdapter = await deployer.adapters.deploySushiBarWrapAdapter(
      sushiToken.address,
      xSushiToken.address
    );

    await setup.integrationRegistry.addIntegration(wrapModule.address, sushiBarWrapAdapterIntegrationName, sushiBarWrapAdapter.address);
  });

  addSnapshotBeforeRestoreAfterEach();

  context("when a SetToken has been deployed and issued", async () => {
    let setToken: SetToken;
    let setTokensIssued: BigNumber;

    before(async () => {
      setToken = await setup.createSetToken(
        [sushiToken.address],
        [ether(1)],
        [setup.issuanceModule.address, wrapModule.address]
      );

      // Initialize modules
      await setup.issuanceModule.initialize(setToken.address, ADDRESS_ZERO);
      await wrapModule.initialize(setToken.address);

      // Issue some Sets
      setTokensIssued = ether(10);
      await sushiToken.approve(setup.issuanceModule.address, setTokensIssued);

      await setup.issuanceModule.issue(setToken.address, setTokensIssued, owner.address);

      // Mint initial xSUSHI and send extra
      await sushiToken.approve(xSushiToken.address, ether(10000));
      await xSushiToken.enter(ether(1));
      await sushiToken.transfer(xSushiToken.address, ether(1));
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
        subjectUnderlyingToken = sushiToken.address;
        subjectWrappedToken = xSushiToken.address;
        subjectUnderlyingUnits = ether(0.4);
        subjectIntegrationName = sushiBarWrapAdapterIntegrationName;
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

      it("should wrap SUSHI into xSUSHI", async () => {
        const previousUnderlyingBalance = await sushiToken.balanceOf(setToken.address);
        const previousSushiTokenUnit = await setToken.getDefaultPositionRealUnit(sushiToken.address);
        const totalXSushiSupply = await xSushiToken.totalSupply();
        const totalSushiBalance = await sushiToken.balanceOf(xSushiToken.address);

        await subject();

        const underlyingBalance = await sushiToken.balanceOf(setToken.address);
        const currentSushiTokenUnit = await setToken.getDefaultPositionRealUnit(sushiToken.address);
        const currentXSushiTokenUnit = await setToken.getDefaultPositionRealUnit(xSushiToken.address);

        const expectedUnderlyingBalance = previousUnderlyingBalance.sub(preciseMul(setTokensIssued, subjectUnderlyingUnits));
        expect(underlyingBalance).to.eq(expectedUnderlyingBalance);
        expect(currentSushiTokenUnit).to.eq(previousSushiTokenUnit.sub(subjectUnderlyingUnits));
        expect(currentXSushiTokenUnit).to.eq(subjectUnderlyingUnits.mul(totalXSushiSupply).div(totalSushiBalance));
      });
    });

    describe("#unwrap", () => {
      let subjectSetToken: Address;
      let subjectUnderlyingToken: Address;
      let subjectWrappedToken: Address;
      let subjectWrappedTokenUnits: BigNumber;
      let subjectIntegrationName: string;
      let subjectCaller: Account;

      beforeEach(async () => {
        subjectSetToken = setToken.address;
        subjectUnderlyingToken = sushiToken.address;
        subjectWrappedToken = xSushiToken.address;
        subjectWrappedTokenUnits = ether(0.1);
        subjectIntegrationName = sushiBarWrapAdapterIntegrationName;
        subjectCaller = owner;

        // Mint initial xSUSHI and send extra
        await sushiToken.approve(xSushiToken.address, ether(10000));
        await xSushiToken.enter(ether(1));
        await sushiToken.transfer(xSushiToken.address, ether(1));

        // Wrap xSUSHI
        await wrapModule.wrap(
          subjectSetToken,
          subjectUnderlyingToken,
          subjectWrappedToken,
          ether(1),
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

      it("should unwrap xSUSHI into SUSHI", async () => {
        const previousXSushiBalance = await xSushiToken.balanceOf(setToken.address);
        const previousXSushiTokenUnit = await setToken.getDefaultPositionRealUnit(xSushiToken.address);
        const totalXSushiSupply = await xSushiToken.totalSupply();
        const totalSushiBalance = await sushiToken.balanceOf(xSushiToken.address);

        await subject();

        const xSushiBalance = await xSushiToken.balanceOf(setToken.address);
        const currentSushiTokenUnit = await setToken.getDefaultPositionRealUnit(sushiToken.address);
        const currentXSushiTokenUnit = await setToken.getDefaultPositionRealUnit(xSushiToken.address);

        const expectedXSushiBalance = previousXSushiBalance.sub(preciseMul(setTokensIssued, subjectWrappedTokenUnits));

        expect(xSushiBalance).to.eq(expectedXSushiBalance);
        expect(currentXSushiTokenUnit).to.eq(previousXSushiTokenUnit.sub(subjectWrappedTokenUnits));
        expect(currentSushiTokenUnit).to.eq(subjectWrappedTokenUnits.mul(totalSushiBalance).div(totalXSushiSupply));
      });
    });
  });
});
