// Source @eth-optimism/optimism/integration-test helpers
// Adapted to fund 10 accounts on L2 w/ 5000 eth
const { getContractFactory } = require("@eth-optimism/contracts/dist/contract-defs.js");
import { utils, Wallet, providers } from "ethers";
import {
  getAddressManager,
  fundUser,
  getOvmEth,
  getGateway,
  env,
  optimismPrivateKeys
} from "./utils";
import { initWatcher } from "./watcher-utils";

/// Helper class for instantiating a test environment with a funded account
export class OptimismEnv {
  accounts: any[];

  constructor(accounts: any[]) {
    this.accounts = accounts;
  }

  static async new(amountToFund: number): Promise<OptimismEnv> {
    const accounts: any[] = [];

    // Providers
    const l1Provider = new providers.JsonRpcProvider(env.L1_URL);
    l1Provider.pollingInterval = env.L1_POLLING_INTERVAL;

    const l2Provider = new providers.JsonRpcProvider(env.L2_URL);
    l2Provider.pollingInterval = env.L2_POLLING_INTERVAL;

    for (const privateKey of optimismPrivateKeys) {
      const l1Wallet = new Wallet(privateKey, l1Provider);
      const l2Wallet = l1Wallet.connect(l2Provider);

      const addressManager = getAddressManager(l1Wallet);
      const watcher = await initWatcher(l1Provider, l2Provider, addressManager);
      const gateway = await getGateway(l1Wallet, addressManager);

      // fund the user if needed
      const balance = await l2Wallet.getBalance();
      if (balance.isZero()) {
        const address = await l1Wallet.getAddress();
        console.log(`Funding ${address} with ${amountToFund}`);
        try {
          await fundUser(watcher, gateway, utils.parseEther(amountToFund.toString()));
        } catch (e) {
          console.log("Errored with: " + e.message);
        }
      }

      const ovmEth = getOvmEth(l2Wallet);

      const l1Messenger = getContractFactory("iOVM_L1CrossDomainMessenger")
        .connect(l1Wallet)
        .attach(watcher.l1.messengerAddress);

      const l2Messenger = getContractFactory("iOVM_L2CrossDomainMessenger")
        .connect(l2Wallet)
        .attach(watcher.l2.messengerAddress);

      const ctcAddress = await addressManager.getAddress(
        "OVM_CanonicalTransactionChain"
      );
      const ctc = getContractFactory("OVM_CanonicalTransactionChain")
        .connect(l1Wallet)
        .attach(ctcAddress);

      accounts.push({
        addressManager,
        gateway,
        ctc,
        l1Messenger,
        ovmEth,
        l2Messenger,
        watcher,
        l1Wallet,
        l2Wallet,
      });
    }

    return new OptimismEnv(accounts);
  }
}
