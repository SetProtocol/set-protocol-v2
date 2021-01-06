import "module-alias/register";
import { BigNumber } from "@ethersproject/bignumber";

import { Address, Account } from "@utils/types";
import { ADDRESS_ZERO } from "@utils/constants";
import { AaveWrapAdapter, SetToken, WrapModule } from "@utils/contracts";
import DeployHelper from "@utils/deploys";
import {
  addSnapshotBeforeRestoreAfterEach,
  ether,
  getAccounts,
  getWaffleExpect,
  getSystemFixture,
  getAaveFixture, preciseMul,
} from "@utils/index";
import { AaveFixture, SystemFixture } from "@utils/fixtures";
import { AToken } from "@typechain/AToken";

const expect = getWaffleExpect();

describe("aaveWrapModule", () => {
  let owner: Account;
  let deployer: DeployHelper;
  let setup: SystemFixture;

  let aaveSetup: AaveFixture;
  let aDai: AToken;

  let wrapModule: WrapModule;
  let aaveWrapAdapter: AaveWrapAdapter;

  const aaveWrapAdapterIntegrationName: string = "AAVE_WRAPPER";

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
    aDai = await aaveSetup.deployAToken(setup.dai.address, await setup.dai.decimals());

    // WrapModule setup
    wrapModule = await deployer.modules.deployWrapModule(setup.controller.address, setup.weth.address);
    await setup.controller.addModule(wrapModule.address);

    // AaveWrapAdapter setup
    aaveWrapAdapter = await deployer.adapters.deployAaveWrapAdapter(aaveSetup.lendingPool.address);
    await setup.integrationRegistry.addIntegration(wrapModule.address, aaveWrapAdapterIntegrationName, aaveWrapAdapter.address);
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
        subjectWrappedToken = aDai.address;
        subjectUnderlyingUnits = ether(1);
        subjectIntegrationName = aaveWrapAdapterIntegrationName;
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
        const previousWrappedBalance = await aDai.balanceOf(setToken.address);

        await subject();

        const underlyingBalance = await setup.dai.balanceOf(setToken.address);
        const wrappedBalance = await aDai.balanceOf(setToken.address);

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
        subjectWrappedToken = aDai.address;
        subjectWrappedTokenUnits = ether(0.5);
        subjectIntegrationName = aaveWrapAdapterIntegrationName;
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

      it("should burn the wrapped asset to the SetToken and increase the underlying quantity", async () => {
        const previousUnderlyingBalance = await setup.dai.balanceOf(setToken.address);
        const previousWrappedBalance = await aDai.balanceOf(setToken.address);

        await subject();

        const underlyingBalance = await setup.dai.balanceOf(setToken.address);
        const wrappedBalance = await aDai.balanceOf(setToken.address);

        const delta = preciseMul(setTokensIssued, wrappedQuantity.sub(subjectWrappedTokenUnits));

        const expectedUnderlyingBalance = previousUnderlyingBalance.add(delta);
        expect(underlyingBalance).to.eq(expectedUnderlyingBalance);

        const expectedWrappedBalance = previousWrappedBalance.sub(delta);
        expect(wrappedBalance).to.eq(expectedWrappedBalance);
      });
    });
  });
});
