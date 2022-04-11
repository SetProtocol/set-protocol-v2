// Deploy Hardhat Network State for Subgraph Tests
// -----------------------------------------------
// This script is intended for use with the set-protocol-v2-subgraph repository
// for deploying a containerized local Hardhat node and test environment for
// subgraph development. See command `task deploy-hardhat` in that repo for
// more information.
//
// Standalone execution against a local Hardhat node deployed from this
// repository is possible via the following command:
//
//   npx hardhat run --no-compile $(pwd)/subgraph/test/deploy-state-multi-token.ts --network localhost
//
// The following deployment state is executed:
//
// - Deploy system
// - Deploy SetToken with 1 WBTC
// - Basic Issue 10
// - Basic Redeem 5
// - Trade 0.5 WBTC for WETH on kyber
// - Accrue fee
// - Change fee recipient
// - Update streaming fee
// - Update SetToken manager

import "module-alias/register";
import { BigNumber } from "@ethersproject/bignumber";
import { ethers } from "hardhat";
import { EMPTY_BYTES, ONE_YEAR_IN_SECONDS, ZERO } from "@utils/constants";
import DeployHelper from "@utils/deploys";
import { ether } from "@utils/index";
import { getAccounts, getSystemFixture, increaseTimeAsync } from "@utils/test/index";
import { StreamingFeeState } from "@utils/types";

async function main() {

  console.log("Starting deployment");

  const [owner, manager1, manager2, manager3] = await getAccounts();

  const wbtcRate = ether(33); // 1 WBTC = 33 ETH
  const wbtcUnits = BigNumber.from(100000000); // 1 WBTC in base units 1 * 10 ** 8

  // Deploy system
  const deployer = new DeployHelper(owner.wallet);
  const setup = getSystemFixture(owner.address);
  await setup.initialize();

  // StreamingFeeModule Deployment
  let streamingFeeModule = await deployer.modules.deployStreamingFeeModule(setup.controller.address);
  await setup.controller.addModule(streamingFeeModule.address);

  // TradeModule Deployment
  let tradeModule = await deployer.modules.deployTradeModule(setup.controller.address);
  await setup.controller.addModule(tradeModule.address);

  // Deploy Mock Kyber reserve. Only allows trading from/to WETH
  const kyberNetworkProxy = await deployer.mocks.deployKyberNetworkProxyMock(setup.weth.address);
  await kyberNetworkProxy.addToken(setup.wbtc.address, wbtcRate, 8);
  const kyberExchangeAdapter = await deployer.adapters.deployKyberExchangeAdapter(
    kyberNetworkProxy.address,
  );
  const kyberAdapterName = "KYBER";

  await setup.integrationRegistry.batchAddIntegration(
    [tradeModule.address],
    [kyberAdapterName],
    [kyberExchangeAdapter.address],
  );

  // DEPLOY A SETTOKEN (with issuanceModule, TradeModule, and StreamingFeeModule)

  let setToken = await setup.createSetToken(
    [setup.wbtc.address],
    [wbtcUnits],
    [
      setup.issuanceModule.address,
      tradeModule.address,
      streamingFeeModule.address
    ],
    manager1.address,
    "SetToken",
    "SET"
  );

  // Initialize StreamingFeeModule
  let streamingFeePercentage = ether(.02);
  let subjectSettings = {
    feeRecipient: manager1.address,
    maxStreamingFeePercentage: ether(.1),
    streamingFeePercentage: streamingFeePercentage,
    lastStreamingFeeTimestamp: ZERO,
  } as StreamingFeeState;
  streamingFeeModule = streamingFeeModule.connect(manager1.wallet);
  await streamingFeeModule.initialize(setToken.address, subjectSettings);
  await setToken.isInitializedModule(streamingFeeModule.address);

  // Initialize TradeModule
  tradeModule = tradeModule.connect(manager1.wallet);
  await tradeModule.initialize(setToken.address);
  await setToken.isInitializedModule(tradeModule.address);

  // Deploy mock issuance hook and initialize issuance module
  setup.issuanceModule = setup.issuanceModule.connect(manager1.wallet);
  const mockPreIssuanceHook = await deployer.mocks.deployManagerIssuanceHookMock();
  await setup.issuanceModule.initialize(setToken.address, mockPreIssuanceHook.address);

  // Transfer WBTC from owner to manager for issuance
  setup.wbtc = setup.wbtc.connect(owner.wallet);
  await setup.wbtc.transfer(manager1.address, wbtcUnits.mul(100));

  // Approve WBTC to IssuanceModule
  setup.wbtc = setup.wbtc.connect(manager1.wallet);
  await setup.wbtc.approve(setup.issuanceModule.address, ethers.constants.MaxUint256);

  // Issue 10 SetTokens
  setup.issuanceModule = setup.issuanceModule.connect(owner.wallet);
  const issueQuantity = ether(10);
  await setup.issuanceModule.issue(setToken.address, issueQuantity, owner.address);

  // Redeem 5 SetTokens
  const redeemQuantity = ether(5);
  setToken = setToken.connect(owner.wallet);
  await setToken.approve(setup.issuanceModule.address, ethers.constants.MaxUint256);
  await setup.issuanceModule.redeem(setToken.address, redeemQuantity, owner.address);

  // Trade on Kyber

  // Fund Kyber reserve with WETH
  setup.weth = setup.weth.connect(owner.wallet);
  await setup.weth.transfer(kyberNetworkProxy.address, ether(1000));

  const sourceTokenQuantity = wbtcUnits.div(2); // Trade 0.5 WBTC
  const sourceTokenDecimals = await setup.wbtc.decimals();
  const destinationTokenQuantity = wbtcRate.mul(sourceTokenQuantity).div(10 ** sourceTokenDecimals);
  const subjectData = EMPTY_BYTES;
  const subjectMinDestinationQuantity = destinationTokenQuantity.sub(ether(0.5)); // Receive a min of 16 WETH for 0.5 WBTC

  await tradeModule.trade(
    setToken.address,
    kyberAdapterName,
    setup.wbtc.address,
    sourceTokenQuantity,
    setup.weth.address,
    subjectMinDestinationQuantity,
    subjectData
  );

  // Accrue streaming fee (fast-forward one year)
  const subjectTimeFastForward = ONE_YEAR_IN_SECONDS;
  await increaseTimeAsync(subjectTimeFastForward);
  await streamingFeeModule.accrueFee(setToken.address);

  // Change fee recipient
  let newFeeRecipient = manager2.address;
  await streamingFeeModule.updateFeeRecipient(setToken.address, newFeeRecipient);

  // Update streaming fee
  streamingFeePercentage = ether(.03);
  await streamingFeeModule.updateStreamingFee(setToken.address, streamingFeePercentage);

  // Update Manager
  setToken = setToken.connect(manager1.wallet);
  await setToken.setManager(manager2.address);


  // DEPLOY A SECOND SETTOKEN

  let setToken2 = await setup.createSetToken(
    [setup.wbtc.address],
    [wbtcUnits],
    [
      setup.issuanceModule.address,
      tradeModule.address,
      streamingFeeModule.address
    ],
    manager3.address,
    "SetToken2",
    "SET2"
  );

  // Update Manager
  setToken2 = setToken2.connect(manager3.wallet);
  await setToken2.setManager(manager1.address);

  // Initialize StreamingFeeModule
  streamingFeePercentage = ether(.015);
  subjectSettings = {
    feeRecipient: manager1.address,
    maxStreamingFeePercentage: ether(.05),
    streamingFeePercentage: streamingFeePercentage,
    lastStreamingFeeTimestamp: ZERO,
  } as StreamingFeeState;
  streamingFeeModule = streamingFeeModule.connect(manager1.wallet);
  await streamingFeeModule.initialize(setToken2.address, subjectSettings);
  await setToken2.isInitializedModule(streamingFeeModule.address);

  // Initialize TradeModule
  tradeModule = tradeModule.connect(manager1.wallet);
  await tradeModule.initialize(setToken2.address);
  await setToken2.isInitializedModule(tradeModule.address);

  // Deploy mock issuance hook and initialize issuance module
  setup.issuanceModule = setup.issuanceModule.connect(manager1.wallet);
  // mockPreIssuanceHook = await deployer.mocks.deployManagerIssuanceHookMock();
  await setup.issuanceModule.initialize(setToken2.address, mockPreIssuanceHook.address);

  // Transfer WBTC from owner to manager for issuance
  setup.wbtc = setup.wbtc.connect(owner.wallet);
  await setup.wbtc.transfer(manager1.address, wbtcUnits.mul(100));

  // Approve WBTC to IssuanceModule
  setup.wbtc = setup.wbtc.connect(manager1.wallet);
  await setup.wbtc.approve(setup.issuanceModule.address, ethers.constants.MaxUint256);

  // Issue SetTokens
  setup.issuanceModule = setup.issuanceModule.connect(owner.wallet);
  await setup.issuanceModule.issue(setToken2.address, ether(8), owner.address);

  // Redeem SetTokens
  setToken2 = setToken2.connect(owner.wallet);
  await setToken2.approve(setup.issuanceModule.address, ethers.constants.MaxUint256);
  await setup.issuanceModule.redeem(setToken2.address, ether(2), owner.address);

  // Trade on Kyber
  await tradeModule.trade(
    setToken2.address,
    kyberAdapterName,
    setup.wbtc.address,
    sourceTokenQuantity,
    setup.weth.address,
    subjectMinDestinationQuantity,
    subjectData
  );

  // Accrue streaming fee (fast-forward one year)
  await increaseTimeAsync(subjectTimeFastForward);
  await streamingFeeModule.accrueFee(setToken2.address);

  // Change fee recipient
  newFeeRecipient = manager3.address;
  await streamingFeeModule.updateFeeRecipient(setToken2.address, newFeeRecipient);

  // Update streaming fee
  streamingFeePercentage = ether(.025);
  await streamingFeeModule.updateStreamingFee(setToken2.address, streamingFeePercentage);

}

main().catch(e => {
  console.error(e);
  process.exit(1);
});