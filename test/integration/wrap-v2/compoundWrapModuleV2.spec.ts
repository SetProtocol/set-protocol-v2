import "module-alias/register";
import { BigNumber } from "ethers";

import { Address } from "@utils/types";
import { Account } from "@utils/test/types";
import { ADDRESS_ZERO, ZERO_BYTES } from "@utils/constants";
import { SetToken, WrapModuleV2 } from "@utils/contracts";
import { CERc20 } from "@utils/contracts/compound";
import DeployHelper from "@utils/deploys";
import {
  ether,
  preciseMul,
  preciseDiv
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
  let exchangeRate: BigNumber;

  let wrapModule: WrapModuleV2;

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

    exchangeRate = ether(0.5);
    cDai = await compoundSetup.createAndEnableCToken(
      setup.dai.address,
      exchangeRate,
      compoundSetup.comptroller.address,
      compoundSetup.interestRateModel.address,
      "Compound DAI",
      "cDAI",
      8,
      ether(0.75), // 75% collateral factor
      ether(1)
    );


    // WrapModule setup
    wrapModule = await deployer.modules.deployWrapModuleV2(setup.controller.address, setup.weth.address);
    await setup.controller.addModule(wrapModule.address);

    // compoundWrapAdapter setup
    const compoundLibrary = await deployer.libraries.deployCompound();
    const compoundWrapAdapter = await deployer.adapters.deployCompoundWrapV2Adapter(
      "contracts/protocol/integration/lib/Compound.sol:Compound",
      compoundLibrary.address
    );
    await setup.integrationRegistry.addIntegration(wrapModule.address, compoundWrapAdapterIntegrationName, compoundWrapAdapter.address);
  });

  addSnapshotBeforeRestoreAfterEach();

  context("when a SetToken has been deployed and issued", async () => {
    let setToken: SetToken;
    let setTokensIssued: BigNumber;

    beforeEach(async () => {
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
        subjectWrappedToken = cDai.address;
        subjectUnderlyingUnits = ether(1);
        subjectIntegrationName = compoundWrapAdapterIntegrationName;
        subjectCaller = owner;
        subjectWrapData = ZERO_BYTES;
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

        await subject();

        const underlyingBalance = await setup.dai.balanceOf(setToken.address);
        const wrappedBalance = await cDai.balanceOf(setToken.address);
        const expectedUnderlyingBalance = previousUnderlyingBalance.sub(setTokensIssued);

        expect(underlyingBalance).to.eq(expectedUnderlyingBalance);

        const expectedWrappedBalance = preciseDiv(previousUnderlyingBalance, exchangeRate);

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
      let subjectUnwrapData: string;

      let wrappedQuantity: BigNumber;

      beforeEach(async () => {
        subjectSetToken = setToken.address;
        subjectUnderlyingToken = setup.dai.address;
        subjectWrappedToken = cDai.address;
        subjectWrappedTokenUnits = BigNumber.from("5000000000");  // ctokens have 8 decimals
        subjectIntegrationName = compoundWrapAdapterIntegrationName;
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
          subjectUnwrapData
        );
      }

      it("should burn the wrapped asset to the SetToken and increase the underlying quantity", async () => {
        const previousWrappedBalance = await cDai.balanceOf(setToken.address);

        await subject();

        const underlyingBalance = await setup.dai.balanceOf(setToken.address);
        const wrappedBalance = await cDai.balanceOf(setToken.address);
        const delta = preciseMul(setTokensIssued, subjectWrappedTokenUnits);
        const expectedUnderlyingBalance = preciseMul(delta, exchangeRate);

        expect(underlyingBalance).to.eq(expectedUnderlyingBalance);

        const expectedWrappedBalance = previousWrappedBalance.sub(delta);

        expect(wrappedBalance).to.eq(expectedWrappedBalance);
      });
    });
  });
});
