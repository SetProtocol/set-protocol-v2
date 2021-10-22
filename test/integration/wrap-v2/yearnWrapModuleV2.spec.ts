import "module-alias/register";
import { BigNumber } from "ethers";

import { Address } from "@utils/types";
import { Account } from "@utils/test/types";
import { ADDRESS_ZERO, ZERO_BYTES } from "@utils/constants";
import { YearnWrapV2Adapter, SetToken, WrapModuleV2 } from "@utils/contracts";
import DeployHelper from "@utils/deploys";
import {
  ether,
  preciseMul,
} from "@utils/index";
import {
  getAccounts,
  getWaffleExpect,
  getSystemFixture,
  getYearnFixture,
  addSnapshotBeforeRestoreAfterEach,
} from "@utils/test/index";
import { YearnFixture, SystemFixture } from "@utils/fixtures";
import { Vault } from "@utils/contracts/yearn";


const expect = getWaffleExpect();

describe("yearnWrapModule", () => {
  let owner: Account;
  let deployer: DeployHelper;
  let setup: SystemFixture;

  let yearnSetup: YearnFixture;
  let daiVault: Vault;

  let wrapModule: WrapModuleV2;
  let yearnWrapAdapter: YearnWrapV2Adapter;

  const yearnWrapAdapterIntegrationName: string = "YEARN_WRAPPER";

  before(async () => {
    [
      owner,
    ] = await getAccounts();

    // System setup
    deployer = new DeployHelper(owner.wallet);
    setup = getSystemFixture(owner.address);
    await setup.initialize();

    // Yearn setup
    yearnSetup = getYearnFixture(owner.address);
    await yearnSetup.initialize();

    daiVault =  await yearnSetup.createAndEnableVaultWithStrategyMock(
      setup.dai.address, owner.address, owner.address, owner.address, "daiMockStrategy", "yvDAI", ether(100)
    );

    // WrapModule setup
    wrapModule = await deployer.modules.deployWrapModuleV2(setup.controller.address, setup.weth.address);
    await setup.controller.addModule(wrapModule.address);

    // YearnWrapAdapter setup
    yearnWrapAdapter = await deployer.adapters.deployYearnWrapV2Adapter();
    await setup.integrationRegistry.addIntegration(wrapModule.address, yearnWrapAdapterIntegrationName, yearnWrapAdapter.address);
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
      let subjectWrapData: string;
      let subjectCaller: Account;

      beforeEach(async () => {
        subjectSetToken = setToken.address;
        subjectUnderlyingToken = setup.dai.address;
        subjectWrappedToken = daiVault.address;
        subjectUnderlyingUnits = ether(1);
        subjectIntegrationName = yearnWrapAdapterIntegrationName;
        subjectWrapData = ZERO_BYTES;
        subjectCaller = owner;
      });

      async function subject(): Promise<any> {
        return wrapModule.connect(subjectCaller.wallet).wrap(
          subjectSetToken,
          subjectUnderlyingToken,
          subjectWrappedToken,
          subjectUnderlyingUnits,
          subjectIntegrationName,
          subjectWrapData
        );
      }

      it("should reduce the underlying quantity and mint the wrapped asset to the SetToken", async () => {
        const previousUnderlyingBalance = await setup.dai.balanceOf(setToken.address);
        const previousWrappedBalance = await daiVault.balanceOf(setToken.address);

        await subject();

        const underlyingBalance = await setup.dai.balanceOf(setToken.address);
        const wrappedBalance = await daiVault.balanceOf(setToken.address);

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
      let subjectUnwrapData: string;
      let subjectCaller: Account;

      let wrappedQuantity: BigNumber;

      beforeEach(async () => {
        subjectSetToken = setToken.address;
        subjectUnderlyingToken = setup.dai.address;
        subjectWrappedToken = daiVault.address;
        subjectWrappedTokenUnits = ether(0.5);
        subjectIntegrationName = yearnWrapAdapterIntegrationName;
        subjectUnwrapData = ZERO_BYTES;
        subjectCaller = owner;

        wrappedQuantity = ether(1);

        await wrapModule.wrap(
          subjectSetToken,
          subjectUnderlyingToken,
          subjectWrappedToken,
          wrappedQuantity,
          subjectIntegrationName,
          ZERO_BYTES
        );
      });

      async function subject(): Promise<any> {
        return wrapModule.connect(subjectCaller.wallet).unwrap(
          subjectSetToken,
          subjectUnderlyingToken,
          subjectWrappedToken,
          subjectWrappedTokenUnits,
          subjectIntegrationName,
          subjectUnwrapData,
          {
            gasLimit: 5000000,
          }
        );
      }

      it("should burn the wrapped asset to the SetToken and increase the underlying quantity", async () => {
        const previousUnderlyingBalance = await setup.dai.balanceOf(setToken.address);
        const previousWrappedBalance = await daiVault.balanceOf(setToken.address);

        await subject();

        const underlyingBalance = await setup.dai.balanceOf(setToken.address);
        const wrappedBalance = await daiVault.balanceOf(setToken.address);

        const delta = preciseMul(setTokensIssued, wrappedQuantity.sub(subjectWrappedTokenUnits));

        const expectedUnderlyingBalance = previousUnderlyingBalance.add(delta);
        expect(underlyingBalance).to.eq(expectedUnderlyingBalance);

        const expectedWrappedBalance = previousWrappedBalance.sub(delta);
        expect(wrappedBalance).to.eq(expectedWrappedBalance);
      });

      describe("when it is an invalid vault - underlying token", async () => {
        beforeEach(async () => {
          subjectUnderlyingToken = setup.usdc.address;
        });

        it("should revert as it the vault holds a different underlying token", async () => {
          await expect(subject()).to.be.revertedWith("Must be a valid token pair");
        });
      });

    });
  });
});
