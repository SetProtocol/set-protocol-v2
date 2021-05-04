import { OptimismEnv } from "../utils/tasks/optimism/env";
import { task } from "hardhat/config";

task("set:optimism:depositEth", "Deposits Eth from L1 test accounts to L2")
  .setAction(async function(args, env) {
    const optimismEnv = await OptimismEnv.new(5000);

    for (const account of optimismEnv.accounts) {
      const l2Address = await account.l2Wallet.getAddress();
      const l2Balance = await account.l2Wallet.getBalance();
      console.log(`Verifying balance: ${l2Address}: ${l2Balance}`);
    }
  });