import "module-alias/register";
import { BigNumber } from "ethers";

import { Address } from "@utils/types";
import { Account } from "@utils/test/types";
import { ADDRESS_ZERO, MAX_UINT_256, ZERO_BYTES } from "@utils/constants";
import { AaveV2WrapV2Adapter, SetToken, StandardTokenMock, WrapModuleV2 } from "@utils/contracts";
import DeployHelper from "@utils/deploys";
import {
  ether,
  preciseMul,
} from "@utils/index";
import {
  getAccounts,
  getWaffleExpect,
  getSystemFixture,
  addSnapshotBeforeRestoreAfterEach,
  getAaveV2Fixture,
} from "@utils/test/index";
import { AaveV2Fixture, SystemFixture } from "@utils/fixtures";
import {
  AaveV2AToken
} from "@utils/contracts/aaveV2";

const expect = getWaffleExpect();

describe("AaveV2WrapModule", () => {

  let owner: Account;
  let deployer: DeployHelper;

  let setV2Setup: SystemFixture;
  let aaveV2Setup: AaveV2Fixture;

  let aaveV2WrapAdapter: AaveV2WrapV2Adapter;
  let wrapModule: WrapModuleV2;

  let underlyingToken: StandardTokenMock;
  let wrappedToken: AaveV2AToken;

  const aaveV2WrapAdapterIntegrationName: string = "AAVE_V2_WRAPPER";

  before(async () => {
    [ owner ] = await getAccounts();

    // System setup
    deployer = new DeployHelper(owner.wallet);
    setV2Setup = getSystemFixture(owner.address);
    await setV2Setup.initialize();

    // Aave setup
    aaveV2Setup = getAaveV2Fixture(owner.address);
    await aaveV2Setup.initialize(setV2Setup.weth.address, setV2Setup.dai.address);

    underlyingToken = setV2Setup.dai;
    wrappedToken = aaveV2Setup.daiReserveTokens.aToken;

    // WrapModule setup
    wrapModule = await deployer.modules.deployWrapModuleV2(setV2Setup.controller.address, setV2Setup.weth.address);
    await setV2Setup.controller.addModule(wrapModule.address);

    // AaveV2WrapAdapter setup
    aaveV2WrapAdapter = await deployer.adapters.deployAaveV2WrapV2Adapter(aaveV2Setup.lendingPool.address);
    await setV2Setup.integrationRegistry.addIntegration(wrapModule.address, aaveV2WrapAdapterIntegrationName, aaveV2WrapAdapter.address);
  });

  addSnapshotBeforeRestoreAfterEach();

  context("when a SetToken has been deployed and issued", async () => {
    let setToken: SetToken;
    let setTokensIssued: BigNumber;

    before(async () => {
      setToken = await setV2Setup.createSetToken(
        [setV2Setup.dai.address],
        [ether(1)],
        [setV2Setup.issuanceModule.address, wrapModule.address]
      );

      // Initialize modules
      await setV2Setup.issuanceModule.initialize(setToken.address, ADDRESS_ZERO);
      await wrapModule.initialize(setToken.address);

      // Issue some Sets
      setTokensIssued = ether(10);
      const underlyingRequired = setTokensIssued;
      await setV2Setup.dai.approve(setV2Setup.issuanceModule.address, underlyingRequired);
      await setV2Setup.issuanceModule.issue(setToken.address, setTokensIssued, owner.address);
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
        subjectUnderlyingToken = underlyingToken.address;
        subjectWrappedToken = wrappedToken.address;
        subjectUnderlyingUnits = ether(1);
        subjectIntegrationName = aaveV2WrapAdapterIntegrationName;
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
        const previousUnderlyingBalance = await underlyingToken.balanceOf(setToken.address);
        const previousWrappedBalance = await wrappedToken.balanceOf(setToken.address);

        await subject();

        const underlyingBalance = await underlyingToken.balanceOf(setToken.address);
        const wrappedBalance = await wrappedToken.balanceOf(setToken.address);

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
        subjectUnderlyingToken = underlyingToken.address;
        subjectWrappedToken = wrappedToken.address;
        subjectWrappedTokenUnits = ether(0.5);
        subjectIntegrationName = aaveV2WrapAdapterIntegrationName;
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

        await underlyingToken.approve(aaveV2Setup.lendingPool.address, MAX_UINT_256);
        await aaveV2Setup.lendingPool.deposit(underlyingToken.address, ether(100000), owner.address, 0);
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
        const previousUnderlyingBalance = await underlyingToken.balanceOf(setToken.address);
        const previousWrappedBalance = await wrappedToken.balanceOf(setToken.address);

        await subject();

        const underlyingBalance = await underlyingToken.balanceOf(setToken.address);
        const wrappedBalance = await wrappedToken.balanceOf(setToken.address);

        const delta = preciseMul(setTokensIssued, wrappedQuantity.sub(subjectWrappedTokenUnits));

        const expectedUnderlyingBalance = previousUnderlyingBalance.add(delta);
        expect(underlyingBalance).to.eq(expectedUnderlyingBalance);

        const expectedWrappedBalance = previousWrappedBalance.sub(delta);
        expect(wrappedBalance).to.eq(expectedWrappedBalance);
      });
    });
  });
});
