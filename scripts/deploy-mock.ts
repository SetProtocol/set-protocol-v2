/*
  Deploy a test environment to hardhat for subgraph development
  Steps:
  Deploy system
  Deploy setToken with 1 WBTC
  Basic Issue 10
  Basic Redeem 5
  Trade 0.5 WBTC for WETH on kyber
  -- TODO Below ---
  NAV Issue 10
  NAV Redeem 5
  Accrue streaming fees
*/

import "module-alias/register";
import Web3 from "web3";
import { BigNumber } from "@ethersproject/bignumber";
import { ethers } from "hardhat";
import { ADDRESS_ZERO, EMPTY_BYTES, MAX_UINT_256, ZERO } from "@utils/constants";
import DeployHelper from "@utils/deploys";
import { ether, bitcoin } from "@utils/index";
import { getAccounts, getSystemFixture, getUniswapFixture } from "@utils/test/index";

const web3 = new Web3();

async function main() {
  console.log("Starting deployment");
  const [owner, manager, mockModule] = await getAccounts();

  // Deploy system
  const deployer = new DeployHelper(owner.wallet);
  const setup = getSystemFixture(owner.address);
  await setup.initialize();

  const wbtcRate = ether(33); // 1 WBTC = 33 ETH

  // Deploy Mock Kyber reserve. Only allows trading from/to WETH
  const kyberNetworkProxy = await deployer.mocks.deployKyberNetworkProxyMock(setup.weth.address);
  await kyberNetworkProxy.addToken(setup.wbtc.address, wbtcRate, 8);
  const kyberExchangeAdapter = await deployer.adapters.deployKyberExchangeAdapter(
    kyberNetworkProxy.address,
  );
  const kyberAdapterName = "KYBER";

  let tradeModule = await deployer.modules.deployTradeModule(setup.controller.address);
  await setup.controller.addModule(tradeModule.address);

  await setup.integrationRegistry.batchAddIntegration(
    [tradeModule.address],
    [kyberAdapterName],
    [kyberExchangeAdapter.address],
  );

  // deploy SetToken with BasicIssuanceModule and TradeModule
  const wbtcUnits = BigNumber.from(100000000); // 1 WBTC in base units 1 * 10 ** 8

  let setToken = await setup.createSetToken(
    [setup.wbtc.address],
    [wbtcUnits],
    [setup.issuanceModule.address, tradeModule.address],
    manager.address,
  );

  tradeModule = tradeModule.connect(manager.wallet);
  await tradeModule.initialize(setToken.address);
  await setToken.isInitializedModule(tradeModule.address);

  // Deploy mock issuance hook and initialize issuance module
  setup.issuanceModule = setup.issuanceModule.connect(manager.wallet);
  const mockPreIssuanceHook = await deployer.mocks.deployManagerIssuanceHookMock();
  await setup.issuanceModule.initialize(setToken.address, mockPreIssuanceHook.address);

  // Transfer WBTC from owner to manager for issuance
  setup.wbtc = setup.wbtc.connect(owner.wallet);
  await setup.wbtc.transfer(manager.address, wbtcUnits.mul(100));

  // Approve WBTC to IssuanceModule
  setup.wbtc = setup.wbtc.connect(manager.wallet);
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
    subjectData,
  );
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});