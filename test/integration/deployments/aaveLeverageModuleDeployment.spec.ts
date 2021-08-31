import "module-alias/register";

import { Address } from "@utils/types";
import { Account } from "@utils/test/types";
import {
  AaveV2,
} from "@utils/contracts";
import {
  AaveV2LendingPoolAddressesProvider,
  AaveV2ProtocolDataProvider
} from "@utils/contracts/aaveV2";
import DeployHelper from "@utils/deploys";
import {
  getAccounts,
  getSystemFixture,
  getWaffleExpect,
  getAaveV2Fixture,
} from "@utils/test/index";
import dependencies from "@utils/deploys/dependencies";

import { SystemFixture, AaveV2Fixture } from "@utils/fixtures";

const expect = getWaffleExpect();

describe("AaveLeverageModule Deployment Integration [ @forked-mainnet ]", () => {
  let owner: Account;

  let deployer: DeployHelper;

  let setup: SystemFixture;
  let aaveSetup: AaveV2Fixture;

  let aaveV2Library: AaveV2;
  let lendingPoolAddressesProvider: AaveV2LendingPoolAddressesProvider;
  let protocolDataProvider: AaveV2ProtocolDataProvider;

  before(async () => {
    [
      owner,
    ] = await getAccounts();


    deployer = new DeployHelper(owner.wallet);
    setup = getSystemFixture(owner.address);
    await setup.initialize();

    aaveSetup = getAaveV2Fixture(owner.address);

    aaveV2Library = await deployer.libraries.deployAaveV2();
    lendingPoolAddressesProvider = aaveSetup.getForkedAaveLendingPoolAddressesProvider();
    protocolDataProvider = aaveSetup.getForkedAaveV2ProtocolDataProvider();
  });

  describe("#constructor", function() {
    context("when deploying the AaveLeverageModule with mainnet dependencies", async () => {
      let subjectController: Address;
      let subjectLendingPoolAddressesProvider: Address;

      beforeEach(async () => {
        subjectController = setup.controller.address;
        subjectLendingPoolAddressesProvider = lendingPoolAddressesProvider.address;
      });

      async function subject(): Promise<any> {
        return await deployer.modules.deployAaveLeverageModule(
          subjectController,
          subjectLendingPoolAddressesProvider,
          "contracts/protocol/integration/lib/AaveV2.sol:AaveV2",
          aaveV2Library.address,
        );
      }

      it("should set the correct controller", async () => {
        const aaveLeverageModule = await subject();

        const controller = await aaveLeverageModule.controller();
        expect(controller).to.eq(subjectController);
      });

      it("should set the correct Aave contracts", async () => {
        const aaveLeverageModule = await subject();

        const returnedLendingPoolAddressesProvider = await aaveLeverageModule.lendingPoolAddressesProvider();
        const returnedProtocolDataProvider = await aaveLeverageModule.protocolDataProvider();

        expect(returnedLendingPoolAddressesProvider).to.eq(dependencies.AAVE_LENDING_POOL_ADDRESSES_PROVIDER[1]);
        expect(returnedProtocolDataProvider).to.eq(dependencies.AAVE_PROTOCOL_DATA_PROVIDER[1]);
      });

      it("should set the correct underlying to reserve tokens mappings (using a single asset USDC as our proxy)", async () => {
        const aaveLeverageModule = await subject();

        const returnedReserveTokens = await aaveLeverageModule.underlyingToReserveTokens(dependencies.USDC[1]);
        const actualReserveTokens = await protocolDataProvider.getReserveTokensAddresses(dependencies.USDC[1]);

        expect(returnedReserveTokens.aToken).to.eq(actualReserveTokens.aTokenAddress);
        expect(returnedReserveTokens.variableDebtToken).to.eq(actualReserveTokens.variableDebtTokenAddress);
      });
    });
  });
});
