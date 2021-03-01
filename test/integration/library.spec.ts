import "module-alias/register";
import { BigNumber } from "@ethersproject/bignumber";
import { Address, Bytes } from "@utils/types";
import { Account } from "@utils/test/types";
import DeployHelper from "@utils/deploys";
import {
  ether,
} from "@utils/index";
import {
  getAccounts,
  getWaffleExpect,
} from "@utils/test/index";

const expect = getWaffleExpect();

describe.only("Library example", () => {
  let owner: Account;
  let deployer: DeployHelper;
  let libraryConsumerMock: any;

  before(async () => {
    [
      owner,
    ] = await getAccounts();

    deployer = new DeployHelper(owner.wallet);

    const libraryMock = await deployer.mocks.deployLibraryMock();
    libraryConsumerMock = await deployer.mocks.deployLibraryConsumerMock(
      "contracts/mocks/LibraryMock.sol:LibraryMock",
      libraryMock.address
    );
  });

  it('should link a library...', async() => {
    const val = await libraryConsumerMock.plus();
    expect(val).to.equal(1);
  });
})
