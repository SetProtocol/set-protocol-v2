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

const tokenAddresses = {
  weth: "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2",
  aWethV3: "0x4d5F47FA6A74757f35C14fD3a6Ef8E3C9BC514E8",
  aWethVariableDebtTokenV3: "0xeA51d7853EEFb32b6ee06b1C12E6dcCA88Be0fFE",
  dai: "0x6B175474E89094C44Da98b954EedeAC495271d0F",
  aDaiV3: "0x018008bfb33d285247A21d44E50697654f754e63",
  aDaiVariableDebtTokenV3: "0xcF8d0c70c850859266f5C338b38F9D663181C314",
};

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

  it("Should set the correct aave contracts", async () => {
    expect(await aaveLeverageModule.protocolDataProvider()).to.eq(
      aaveV3ProtocolDataProviderAddress,
    );
    expect(await aaveLeverageModule.lendingPoolAddressesProvider()).to.eq(
      aaveV3AddressProviderAddress,
    );
  });

  it("should set the correct controller", async () => {
    const returnController = await aaveLeverageModule.controller();
    expect(returnController).to.eq(controllerAddress);
  });

  it("should set the correct underlying to reserve tokens mappings for weth", async () => {
    const wethReserveTokens = await aaveLeverageModule.underlyingToReserveTokens(
      tokenAddresses.weth,
    );
    expect(wethReserveTokens.aToken).to.eq(tokenAddresses.aWethV3);
    expect(wethReserveTokens.variableDebtToken).to.eq(tokenAddresses.aWethVariableDebtTokenV3);
  });

  it("should set the correct underlying to reserve tokens mappings for dai", async () => {
    const daiReserveTokens = await aaveLeverageModule.underlyingToReserveTokens(tokenAddresses.dai);
    expect(daiReserveTokens.aToken).to.eq(tokenAddresses.aDaiV3);
    expect(daiReserveTokens.variableDebtToken).to.eq(tokenAddresses.aDaiVariableDebtTokenV3);
  });

});
