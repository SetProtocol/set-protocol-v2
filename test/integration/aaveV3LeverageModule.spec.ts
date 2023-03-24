import "module-alias/register";

import { Account } from "@utils/test/types";
import { impersonateAccount } from "@utils/test/testingUtils";
import DeployHelper from "@utils/deploys";
import { getAccounts, getWaffleExpect } from "@utils/test/index";

import {
  AaveV3LeverageModule,
  IPoolAddressesProvider,
  IPoolAddressesProvider__factory,
  Controller,
  Controller__factory,
} from "@typechain/index";

const expect = getWaffleExpect();

// https://docs.aave.com/developers/deployed-contracts/v3-mainnet/ethereum-mainnet
const aaveV3AddressProviderAddress = "0x2f39d218133AFaB8F2B819B1066c7E434Ad94E9e";
const aaveV3ProtocolDataProviderAddress = "0x7B4EB56E7CD4b454BA8ff71E4518426369a138a3";
const controllerAddress = "0xD2463675a099101E36D85278494268261a66603A";

describe("AaveV3LeverageModule integration [ @forked-mainnet ]", () => {
  let owner: Account;
  let deployer: DeployHelper;
  let aaveLeverageModule: AaveV3LeverageModule;
  let poolAddressesProvider: IPoolAddressesProvider;
  let controller: Controller;
  before(async () => {
    [owner] = await getAccounts();

    poolAddressesProvider = IPoolAddressesProvider__factory.connect(
      aaveV3AddressProviderAddress,
      owner.wallet,
    );

    controller = Controller__factory.connect(controllerAddress, owner.wallet);

    const controllerOwner = await controller.owner();
    const controllerOwnerSigner = await impersonateAccount(controllerOwner);
    controller = controller.connect(controllerOwnerSigner);

    deployer = new DeployHelper(owner.wallet);
    const aaveV2Library = await deployer.libraries.deployAaveV2();

    aaveLeverageModule = await deployer.modules.deployAaveV3LeverageModule(
      controller.address,
      poolAddressesProvider.address,
      "contracts/protocol/integration/lib/AaveV2.sol:AaveV2",
      aaveV2Library.address,
    );
    await controller.addModule(aaveLeverageModule.address);
  });

  it("Should set protocolDataProvider correctly", async () => {
    expect(await aaveLeverageModule.protocolDataProvider()).to.eq(
      aaveV3ProtocolDataProviderAddress,
    );
  });

  it("Should set addressProvider correctly", async () => {
    expect(await aaveLeverageModule.lendingPoolAddressesProvider()).to.eq(
      aaveV3AddressProviderAddress,
    );
  });

});
