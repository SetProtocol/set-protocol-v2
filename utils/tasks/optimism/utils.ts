// Source @eth-optimism/optimism/integration-test helpers
import { Direction, waitForXDomainTransaction } from "./watcher-utils";

const {
  getContractFactory,
  getContractInterface,
} = require("@eth-optimism/contracts/dist/contract-defs.js");
import { Watcher } from "@eth-optimism/core-utils";
import {
  Contract,
  Wallet,
  constants,
  BigNumberish,
  BigNumber,
} from "ethers";
import { cleanEnv, str, num } from "envalid";

export const GWEI = BigNumber.from(1e9);

export const env = cleanEnv(process.env, {
  L1_URL: str({ default: "http://localhost:9545" }),
  L2_URL: str({ default: "http://localhost:8545" }),
  L1_POLLING_INTERVAL: num({ default: 10 }),
  L2_POLLING_INTERVAL: num({ default: 10 }),
  ADDRESS_MANAGER: str({
    default: "0x5FbDB2315678afecb367f032d93F642f64180aa3",
  }),
});

// Default Hardhat wallet keys
export const optimismPrivateKeys = [
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  // This address is unfunded on Optimism L1 / Sequencer Private Key
  // "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
  "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
  "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6",
  "0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a",
  "0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba",
  "0x92db14e403b83dfe3df233f83dfa3a0d7096f21ca9b0d6d6b8d88b2b4ec1564e",
  "0x4bbbf85ce3377467afe5d46f804f221813b2bb87f24d81f60f1fcdbf7cbf4356",
  "0xdbda1821b80551c9d65939329250298aa3472ba22feea921c0cf5d620ea67b97",
  "0x2a871d0798f97d79848a013d4936a73bf4cc922c825d33c1cf7073dff6d409c6",
];

// Predeploys
export const PROXY_SEQUENCER_ENTRYPOINT_ADDRESS =
  "0x4200000000000000000000000000000000000004";
export const OVM_ETH_ADDRESS = "0x4200000000000000000000000000000000000006";

export const getAddressManager = (provider: any) => {
  return getContractFactory("Lib_AddressManager")
    .connect(provider)
    .attach(env.ADDRESS_MANAGER);
};

// Gets the gateway using the proxy if available
export const getGateway = async (wallet: Wallet, AddressManager: Contract) => {
  const l1GatewayInterface = getContractInterface("OVM_L1ETHGateway");
  const ProxyGatewayAddress = await AddressManager.getAddress(
    "Proxy__OVM_L1ETHGateway"
  );
  const addressToUse =
    ProxyGatewayAddress !== constants.AddressZero
      ? ProxyGatewayAddress
      : await AddressManager.getAddress("OVM_L1ETHGateway");

  const OVM_L1ETHGateway = new Contract(
    addressToUse,
    l1GatewayInterface,
    wallet
  );

  return OVM_L1ETHGateway;
};

export const getOvmEth = (wallet: Wallet) => {
  const OVM_ETH = new Contract(
    OVM_ETH_ADDRESS,
    getContractInterface("OVM_ETH"),
    wallet
  );

  return OVM_ETH;
};

export const fundUser = async (
  watcher: Watcher,
  gateway: Contract,
  amount: BigNumberish,
  recipient?: string
) => {
  const value = BigNumber.from(amount);
  const tx = recipient
    ? gateway.depositTo(recipient, { value })
    : gateway.deposit({ value });
  await waitForXDomainTransaction(watcher, tx, Direction.L1ToL2);
};

export const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
