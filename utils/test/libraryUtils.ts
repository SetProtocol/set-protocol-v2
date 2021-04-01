import { utils } from "ethers";
import { artifacts } from "hardhat";
import path from "path";

// If libraryName corresponds to more than one artifact (e.g there are
// duplicate contract names in the project), `readArtifactSync`
// will throw. In such cases it"s necessary to pass this method the fully qualified
// contract name. ex: `contracts/mocks/LibraryMock.sol:LibraryMock`
export function convertLibraryNameToLinkId(libraryName: string): string {
  let artifact;
  let fullyQualifiedName;

  if (libraryName.includes(path.sep) && libraryName.includes(":")) {
    fullyQualifiedName = libraryName;
  } else {
    artifact = artifacts.readArtifactSync(libraryName);
    fullyQualifiedName = `${artifact.sourceName}:${artifact.contractName}`;
  }

  const hashedName = utils.keccak256(utils.toUtf8Bytes(fullyQualifiedName));
  return `__$${hashedName.slice(2).slice(0, 34)}$__`;
}
