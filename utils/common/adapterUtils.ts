import { BigNumber, keccak256 } from "ethers/utils";

export const addressToData = (address: String) => address.replace("0x", "000000000000000000000000");
export const bigNumberToData = (number: BigNumber) => number.toHexString().replace("0x", "").padStart(64, "0");
export const hashAdapterName = (name: string) => keccak256(new Buffer(name));
