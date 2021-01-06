import "module-alias/register";
import Web3 from "web3";
import { BigNumber } from "@ethersproject/bignumber";
import { ethers } from "hardhat";

import { Address, Account, Bytes } from "@utils/types";
import {
  KyberExchangeAdapter,
  KyberNetworkProxyMock,
  ManagerIssuanceHookMock,
  OneInchExchangeAdapter,
  OneInchExchangeMock,
  TradeModule,
  SetToken,
  StandardTokenMock,
  WETH9
} from "@utils/contracts";
import { ADDRESS_ZERO, EMPTY_BYTES, ZERO } from "@utils/constants";
import DeployHelper from "@utils/deploys";
import {
  addSnapshotBeforeRestoreAfterEach,
  getAccounts,
  getRandomAccount,
  getSystemFixture,
  getWaffleExpect,
  ether,
} from "@utils/index";

import { SystemFixture } from "@utils/fixtures";

const web3 = new Web3();
const expect = getWaffleExpect();

describe("TradeModule", () => {
  let owner: Account;
  let manager: Account;
  let mockModule: Account;

  let deployer: DeployHelper;

  let kyberNetworkProxy: KyberNetworkProxyMock;
  let kyberExchangeAdapter: KyberExchangeAdapter;
  let oneInchExchangeMock: OneInchExchangeMock;
  let oneInchExchangeAdapter: OneInchExchangeAdapter;
  let kyberAdapterName: string;
  let oneInchAdapterName: string;
  let wbtcRate: BigNumber;
  let setup: SystemFixture;
  let tradeModule: TradeModule;

  before(async () => {
    [
      owner,
      manager,
      mockModule,
    ] = await getAccounts();

    deployer = new DeployHelper(owner.wallet);
    setup = getSystemFixture(owner.address);
    await setup.initialize();

    wbtcRate = ether(33); // 1 WBTC = 33 ETH

    // Mock Kyber reserve only allows trading from/to WETH
    kyberNetworkProxy = await deployer.mocks.deployKyberNetworkProxyMock(setup.weth.address);
    await kyberNetworkProxy.addToken(
      setup.wbtc.address,
      wbtcRate,
      8
    );
    kyberExchangeAdapter = await deployer.adapters.deployKyberExchangeAdapter(kyberNetworkProxy.address);

    // Mock OneInch exchange that allows for only fixed exchange amounts
    oneInchExchangeMock = await deployer.mocks.deployOneInchExchangeMock(
      setup.wbtc.address,
      setup.weth.address,
      BigNumber.from(100000000), // 1 WBTC
      wbtcRate, // Trades for 33 WETH
    );
    // 1inch function signature
    const oneInchFunctionSignature = web3.eth.abi.encodeFunctionSignature(
      "swap(address,address,uint256,uint256,uint256,address,address[],bytes,uint256[],uint256[])"
    );
    oneInchExchangeAdapter = await deployer.adapters.deployOneInchExchangeAdapter(
      oneInchExchangeMock.address,
      oneInchExchangeMock.address,
      oneInchFunctionSignature
    );

    kyberAdapterName = "KYBER";
    oneInchAdapterName = "ONEINCH";

    tradeModule = await deployer.modules.deployTradeModule(setup.controller.address);
    await setup.controller.addModule(tradeModule.address);

    await setup.integrationRegistry.batchAddIntegration(
      [tradeModule.address, tradeModule.address],
      [kyberAdapterName, oneInchAdapterName],
      [kyberExchangeAdapter.address, oneInchExchangeAdapter.address]
    );
  });

  addSnapshotBeforeRestoreAfterEach();

  describe("#constructor", async () => {
    let subjectTradeModule: TradeModule;

    async function subject(): Promise<TradeModule> {
      return deployer.modules.deployTradeModule(setup.controller.address);
    }

    it("should have the correct controller", async () => {
      subjectTradeModule = await subject();
      const expectedController = await subjectTradeModule.controller();
      expect(expectedController).to.eq(setup.controller.address);
    });
  });

  context("when there is a deployed SetToken with enabled TradeModule", async () => {
    let sourceToken: StandardTokenMock;
    let wbtcUnits: BigNumber;
    let destinationToken: WETH9;
    let setToken: SetToken;
    let issueQuantity: BigNumber;
    let mockPreIssuanceHook: ManagerIssuanceHookMock;

    beforeEach(async () => {
      // Selling WBTC
      sourceToken = setup.wbtc;
      destinationToken = setup.weth;
      wbtcUnits = BigNumber.from(100000000); // 1 WBTC in base units 1 * 10 ** 8

      // Create Set token
      setToken = await setup.createSetToken(
        [sourceToken.address],
        [wbtcUnits],
        [setup.issuanceModule.address, tradeModule.address],
        manager.address
      );
    });

    describe("#initialize", async () => {
      let subjectSetToken: Address;
      let subjectCaller: Account;

      beforeEach(async () => {
        subjectSetToken = setToken.address;
        subjectCaller = manager;
      });

      async function subject(): Promise<any> {
        tradeModule = tradeModule.connect(subjectCaller.wallet);
        return tradeModule.initialize(subjectSetToken);
      }

      it("should enable the Module on the SetToken", async () => {
        await subject();
        const isModuleEnabled = await setToken.isInitializedModule(tradeModule.address);
        expect(isModuleEnabled).to.eq(true);
      });

      describe("when the caller is not the SetToken manager", async () => {
        beforeEach(async () => {
          subjectCaller = await getRandomAccount();
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("Must be the SetToken manager");
        });
      });

      describe("when the module is not pending", async () => {
        beforeEach(async () => {
          await subject();
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("Must be pending initialization");
        });
      });

      describe("when the SetToken is not enabled on the controller", async () => {
        beforeEach(async () => {
          const nonEnabledSetToken = await setup.createNonControllerEnabledSetToken(
            [setup.dai.address],
            [ether(1)],
            [tradeModule.address],
            manager.address
          );

          subjectSetToken = nonEnabledSetToken.address;
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("Must be controller-enabled SetToken");
        });
      });
    });

    describe("#trade", async () => {
      let sourceTokenQuantity: BigNumber;
      let destinationTokenQuantity: BigNumber;
      let isInitialized: boolean;

      let subjectDestinationToken: Address;
      let subjectSourceToken: Address;
      let subjectSourceQuantity: BigNumber;
      let subjectAdapterName: string;
      let subjectSetToken: Address;
      let subjectMinDestinationQuantity: BigNumber;
      let subjectData: Bytes;
      let subjectCaller: Account;

      context("when trading a Default component on Kyber", async () => {
        before(async () => {
          isInitialized = true;
        });

        beforeEach(async () => {
          // Fund Kyber reserve with destinationToken WETH
          destinationToken = destinationToken.connect(owner.wallet);
          await destinationToken.transfer(kyberNetworkProxy.address, ether(1000));

          // Initialize module if set to true
          if (isInitialized) {
            tradeModule = tradeModule.connect(manager.wallet);
            await tradeModule.initialize(setToken.address);
          }

          sourceTokenQuantity = wbtcUnits.div(2); // Trade 0.5 WBTC
          const sourceTokenDecimals = await sourceToken.decimals();
          destinationTokenQuantity = wbtcRate.mul(sourceTokenQuantity).div(10 ** sourceTokenDecimals);

          // Transfer sourceToken from owner to manager for issuance
          sourceToken = sourceToken.connect(owner.wallet);
          await sourceToken.transfer(manager.address, wbtcUnits.mul(100));

          // Approve tokens to Controller and call issue
          sourceToken = sourceToken.connect(manager.wallet);
          await sourceToken.approve(setup.issuanceModule.address, ethers.constants.MaxUint256);
          // Deploy mock issuance hook and initialize issuance module
          setup.issuanceModule = setup.issuanceModule.connect(manager.wallet);
          mockPreIssuanceHook = await deployer.mocks.deployManagerIssuanceHookMock();
          await setup.issuanceModule.initialize(setToken.address, mockPreIssuanceHook.address);

          // Issue 10 SetTokens
          issueQuantity = ether(10);
          await setup.issuanceModule.issue(setToken.address, issueQuantity, owner.address);
          subjectSourceToken = sourceToken.address;
          subjectDestinationToken = destinationToken.address;
          subjectSourceQuantity = sourceTokenQuantity;
          subjectSetToken = setToken.address;
          subjectAdapterName = kyberAdapterName;
          subjectData = EMPTY_BYTES;
          subjectMinDestinationQuantity = destinationTokenQuantity.sub(ether(0.5)); // Receive a min of 16 WETH for 0.5 WBTC
          subjectCaller = manager;
        });

        async function subject(): Promise<any> {
          tradeModule = tradeModule.connect(subjectCaller.wallet);
          return tradeModule.trade(
            subjectSetToken,
            subjectAdapterName,
            subjectSourceToken,
            subjectSourceQuantity,
            subjectDestinationToken,
            subjectMinDestinationQuantity,
            subjectData
          );
        }

        it("should transfer the correct components to the SetToken", async () => {
          const oldDestinationTokenBalance = await destinationToken.balanceOf(setToken.address);

          await subject();
          const totalDestinationQuantity = issueQuantity.mul(destinationTokenQuantity).div(ether(1));
          const expectedDestinationTokenBalance = oldDestinationTokenBalance.add(totalDestinationQuantity);
          const newDestinationTokenBalance = await destinationToken.balanceOf(setToken.address);
          expect(newDestinationTokenBalance).to.eq(expectedDestinationTokenBalance);
        });

        it("should transfer the correct components from the SetToken", async () => {
          const oldSourceTokenBalance = await sourceToken.balanceOf(setToken.address);

          await subject();
          const totalSourceQuantity = issueQuantity.mul(sourceTokenQuantity).div(ether(1));
          const expectedSourceTokenBalance = oldSourceTokenBalance.sub(totalSourceQuantity);
          const newSourceTokenBalance = await sourceToken.balanceOf(setToken.address);
          expect(newSourceTokenBalance).to.eq(expectedSourceTokenBalance);
        });

        it("should transfer the correct components to the exchange", async () => {
          const oldSourceTokenBalance = await sourceToken.balanceOf(kyberNetworkProxy.address);

          await subject();
          const totalSourceQuantity = issueQuantity.mul(sourceTokenQuantity).div(ether(1));
          const expectedSourceTokenBalance = oldSourceTokenBalance.add(totalSourceQuantity);
          const newSourceTokenBalance = await sourceToken.balanceOf(kyberNetworkProxy.address);
          expect(newSourceTokenBalance).to.eq(expectedSourceTokenBalance);
        });

        it("should transfer the correct components from the exchange", async () => {
          const oldDestinationTokenBalance = await destinationToken.balanceOf(kyberNetworkProxy.address);

          await subject();
          const totalDestinationQuantity = issueQuantity.mul(destinationTokenQuantity).div(ether(1));
          const expectedDestinationTokenBalance = oldDestinationTokenBalance.sub(totalDestinationQuantity);
          const newDestinationTokenBalance = await destinationToken.balanceOf(kyberNetworkProxy.address);
          expect(newDestinationTokenBalance).to.eq(expectedDestinationTokenBalance);
        });

        it("should update the positions on the SetToken correctly", async () => {
          const initialPositions = await setToken.getPositions();
          const initialFirstPosition = (await setToken.getPositions())[0];

          await subject();

          const currentPositions = await setToken.getPositions();
          const newFirstPosition = (await setToken.getPositions())[0];
          const newSecondPosition = (await setToken.getPositions())[1];

          expect(initialPositions.length).to.eq(1);
          expect(currentPositions.length).to.eq(2);
          expect(newFirstPosition.component).to.eq(sourceToken.address);
          expect(newFirstPosition.unit).to.eq(initialFirstPosition.unit.sub(sourceTokenQuantity));
          expect(newFirstPosition.module).to.eq(ADDRESS_ZERO);
          expect(newSecondPosition.component).to.eq(destinationToken.address);
          expect(newSecondPosition.unit).to.eq(destinationTokenQuantity);
          expect(newSecondPosition.module).to.eq(ADDRESS_ZERO);
        });

        describe("when there is a protocol fee charged", async () => {
          let feePercentage: BigNumber;

          beforeEach(async () => {
            feePercentage = ether(0.05);
            setup.controller = setup.controller.connect(owner.wallet);
            await setup.controller.addFee(
              tradeModule.address,
              ZERO, // Fee type on trade function denoted as 0
              feePercentage // Set fee to 5 bps
            );
          });

          it("should transfer the correct components minus fee to the SetToken", async () => {
            const oldDestinationTokenBalance = await destinationToken.balanceOf(setToken.address);

            await subject();
            const totalDestinationQuantity = issueQuantity.mul(destinationTokenQuantity).div(ether(1));
            const totalProtocolFee = feePercentage.mul(totalDestinationQuantity).div(ether(1));
            const expectedDestinationTokenBalance = oldDestinationTokenBalance
              .add(totalDestinationQuantity)
              .sub(totalProtocolFee);

            const newDestinationTokenBalance = await destinationToken.balanceOf(setToken.address);
            expect(newDestinationTokenBalance).to.eq(expectedDestinationTokenBalance);
          });

          it("should transfer the correct components from the SetToken to the exchange", async () => {
            const oldSourceTokenBalance = await sourceToken.balanceOf(setToken.address);
            await subject();
            const totalSourceQuantity = issueQuantity.mul(sourceTokenQuantity).div(ether(1));
            const expectedSourceTokenBalance = oldSourceTokenBalance.sub(totalSourceQuantity);
            const newSourceTokenBalance = await sourceToken.balanceOf(setToken.address);
            expect(newSourceTokenBalance).to.eq(expectedSourceTokenBalance);
          });

          it("should update the positions on the SetToken correctly", async () => {
            const initialPositions = await setToken.getPositions();
            const initialFirstPosition = (await setToken.getPositions())[0];

            await subject();

            const currentPositions = await setToken.getPositions();
            const newFirstPosition = (await setToken.getPositions())[0];
            const newSecondPosition = (await setToken.getPositions())[1];

            const unitProtocolFee = feePercentage.mul(destinationTokenQuantity).div(ether(1));
            expect(initialPositions.length).to.eq(1);
            expect(currentPositions.length).to.eq(2);
            expect(newFirstPosition.component).to.eq(sourceToken.address);
            expect(newFirstPosition.unit).to.eq(initialFirstPosition.unit.sub(sourceTokenQuantity));
            expect(newFirstPosition.module).to.eq(ADDRESS_ZERO);
            expect(newSecondPosition.component).to.eq(destinationToken.address);
            expect(newSecondPosition.unit).to.eq(destinationTokenQuantity.sub(unitProtocolFee));
            expect(newSecondPosition.module).to.eq(ADDRESS_ZERO);
          });

          it("should emit the correct ComponentExchanged event", async () => {
            const totalSourceQuantity = issueQuantity.mul(sourceTokenQuantity).div(ether(1));
            const totalDestinationQuantity = issueQuantity.mul(destinationTokenQuantity).div(ether(1));
            const totalProtocolFee = feePercentage.mul(totalDestinationQuantity).div(ether(1));

            await expect(subject()).to.emit(tradeModule, "ComponentExchanged").withArgs(
              setToken.address,
              subjectSourceToken,
              subjectDestinationToken,
              kyberExchangeAdapter.address,
              totalSourceQuantity,
              totalDestinationQuantity.sub(totalProtocolFee),
              totalProtocolFee
            );
          });

          describe("when receive token is more than total position units tracked on SetToken", async () => {
            let extraTokenQuantity: BigNumber;

            beforeEach(async () => {
              extraTokenQuantity = ether(1);
              destinationToken = destinationToken.connect(owner.wallet);
              // Transfer destination token to SetToken
              await destinationToken.transfer(setToken.address, extraTokenQuantity);
            });

            it("should transfer the correct components minus fee to the SetToken", async () => {
              const oldDestinationTokenBalance = await destinationToken.balanceOf(setToken.address);

              await subject();

              const totalDestinationQuantity = issueQuantity.mul(destinationTokenQuantity).div(ether(1));
              const totalProtocolFee = feePercentage.mul(totalDestinationQuantity).div(ether(1));
              const expectedDestinationTokenBalance = oldDestinationTokenBalance
                .add(totalDestinationQuantity)
                .sub(totalProtocolFee);

              const newDestinationTokenBalance = await destinationToken.balanceOf(setToken.address);
              expect(newDestinationTokenBalance).to.eq(expectedDestinationTokenBalance);
            });

            it("should update the positions on the SetToken correctly", async () => {
              const initialPositions = await setToken.getPositions();
              const initialFirstPosition = (await setToken.getPositions())[0];

              await subject();

              const currentPositions = await setToken.getPositions();
              const newFirstPosition = (await setToken.getPositions())[0];
              const newSecondPosition = (await setToken.getPositions())[1];

              const unitProtocolFee = feePercentage.mul(destinationTokenQuantity).div(ether(1));
              expect(initialPositions.length).to.eq(1);
              expect(currentPositions.length).to.eq(2);
              expect(newFirstPosition.component).to.eq(sourceToken.address);
              expect(newFirstPosition.unit).to.eq(initialFirstPosition.unit.sub(sourceTokenQuantity));
              expect(newFirstPosition.module).to.eq(ADDRESS_ZERO);
              expect(newSecondPosition.component).to.eq(destinationToken.address);
              expect(newSecondPosition.unit).to.eq(destinationTokenQuantity.sub(unitProtocolFee));
              expect(newSecondPosition.module).to.eq(ADDRESS_ZERO);
            });
          });

          describe("when send token is more than total position units tracked on SetToken", async () => {
            let extraTokenQuantity: BigNumber;

            beforeEach(async () => {
              extraTokenQuantity = ether(1);
              sourceToken = sourceToken.connect(owner.wallet);
              // Transfer source token to SetToken
              await sourceToken.transfer(setToken.address, extraTokenQuantity);
            });

            it("should transfer the correct components from the SetToken", async () => {
              const oldSourceTokenBalance = await sourceToken.balanceOf(setToken.address);

              await subject();
              const totalSourceQuantity = issueQuantity.mul(sourceTokenQuantity).div(ether(1));
              const expectedSourceTokenBalance = oldSourceTokenBalance.sub(totalSourceQuantity);

              const newSourceTokenBalance = await sourceToken.balanceOf(setToken.address);
              expect(newSourceTokenBalance).to.eq(expectedSourceTokenBalance);
            });

            it("should update the positions on the SetToken correctly", async () => {
              const initialPositions = await setToken.getPositions();
              const initialFirstPosition = (await setToken.getPositions())[0];
              await subject();

              const currentPositions = await setToken.getPositions();
              const newFirstPosition = (await setToken.getPositions())[0];
              const newSecondPosition = (await setToken.getPositions())[1];

              const unitProtocolFee = feePercentage.mul(destinationTokenQuantity).div(ether(1));
              expect(initialPositions.length).to.eq(1);
              expect(currentPositions.length).to.eq(2);
              expect(newFirstPosition.component).to.eq(sourceToken.address);
              expect(newFirstPosition.unit).to.eq(initialFirstPosition.unit.sub(sourceTokenQuantity));
              expect(newFirstPosition.module).to.eq(ADDRESS_ZERO);
              expect(newSecondPosition.component).to.eq(destinationToken.address);
              expect(newSecondPosition.unit).to.eq(destinationTokenQuantity.sub(unitProtocolFee));
              expect(newSecondPosition.module).to.eq(ADDRESS_ZERO);
            });
          });
        });

        describe("when SetToken is locked", async () => {
          beforeEach(async () => {
            // Add mock module to controller
            setup.controller = setup.controller.connect(owner.wallet);
            await setup.controller.addModule(mockModule.address);

            // Add new mock module to SetToken
            setToken = setToken.connect(manager.wallet);
            await setToken.addModule(mockModule.address);

            // Lock SetToken
            setToken = setToken.connect(mockModule.wallet);
            await setToken.initializeModule();
            await setToken.lock();
          });

          it("should revert", async () => {
            await expect(subject()).to.be.revertedWith("When locked, only the locker can call");
          });
        });

        describe("when the exchange is not valid", async () => {
          beforeEach(async () => {
            subjectAdapterName = "UNISWAP";
          });

          it("should revert", async () => {
            await expect(subject()).to.be.revertedWith("Must be valid adapter");
          });
        });

        describe("when quantity of token to sell is 0", async () => {
          beforeEach(async () => {
            subjectSourceQuantity = ZERO;
          });

          it("should revert", async () => {
            await expect(subject()).to.be.revertedWith("Token to sell must be nonzero");
          });
        });

        describe("when quantity sold is more than total units available", async () => {
          beforeEach(async () => {
            // Set to 1 base unit more WBTC
            subjectSourceQuantity = wbtcUnits.add(1);
          });

          it("should revert", async () => {
            await expect(subject()).to.be.revertedWith("Unit cant be greater than existing");
          });
        });

        describe("when slippage is greater than allowed", async () => {
          beforeEach(async () => {
            // Set to 1 base unit above the exchange rate
            subjectMinDestinationQuantity = wbtcRate.add(1);
          });

          it("should revert", async () => {
            await expect(subject()).to.be.revertedWith("Slippage greater than allowed");
          });
        });

        describe("when the caller is not the SetToken manager", async () => {
          beforeEach(async () => {
            subjectCaller = await getRandomAccount();
          });

          it("should revert", async () => {
            await expect(subject()).to.be.revertedWith("Must be the SetToken manager");
          });
        });

        describe("when module is not initialized", async () => {
          before(async () => {
            isInitialized = false;
          });

          after(async () => {
            isInitialized = true;
          });

          it("should revert", async () => {
            await expect(subject()).to.be.revertedWith("Must be a valid and initialized SetToken");
          });
        });

        describe("when SetToken is not valid", async () => {
          beforeEach(async () => {
            const nonEnabledSetToken = await setup.createNonControllerEnabledSetToken(
              [setup.weth.address],
              [ether(1)],
              [tradeModule.address],
              manager.address
            );

            subjectSetToken = nonEnabledSetToken.address;
          });

          it("should revert", async () => {
            await expect(subject()).to.be.revertedWith("Must be a valid and initialized SetToken");
          });
        });
      });

      context("when trading a Default component on One Inch", async () => {
        beforeEach(async () => {
          // Add Set token as token sender / recipient
          oneInchExchangeMock = oneInchExchangeMock.connect(owner.wallet);
          await oneInchExchangeMock.addSetTokenAddress(setToken.address);

          // Fund One Inch exchange with destinationToken WETH
          await destinationToken.transfer(oneInchExchangeMock.address, ether(1000));

          tradeModule = tradeModule.connect(manager.wallet);
          await tradeModule.initialize(setToken.address);

          // Trade 1 WBTC. Note: 1inch mock is hardcoded to trade 1 WBTC unit regardless of Set supply
          sourceTokenQuantity = wbtcUnits;
          const sourceTokenDecimals = await sourceToken.decimals();
          destinationTokenQuantity = wbtcRate.mul(sourceTokenQuantity).div(10 ** sourceTokenDecimals);

          // Transfer sourceToken from owner to manager for issuance
          sourceToken = sourceToken.connect(owner.wallet);
          await sourceToken.transfer(manager.address, wbtcUnits.mul(100));

          // Approve tokens to Controller and call issue
          sourceToken = sourceToken.connect(manager.wallet);
          await sourceToken.approve(setup.issuanceModule.address, ethers.constants.MaxUint256);

          // Deploy mock issuance hook and initialize issuance module
          setup.issuanceModule = setup.issuanceModule.connect(manager.wallet);
          mockPreIssuanceHook = await deployer.mocks.deployManagerIssuanceHookMock();
          await setup.issuanceModule.initialize(setToken.address, mockPreIssuanceHook.address);

          // Issue 1 SetToken. Note: 1inch mock is hardcoded to trade 1 WBTC unit regardless of Set supply
          issueQuantity = ether(1);
          await setup.issuanceModule.issue(setToken.address, issueQuantity, owner.address);

          subjectSourceToken = sourceToken.address;
          subjectDestinationToken = destinationToken.address;
          subjectSourceQuantity = sourceTokenQuantity;
          subjectSetToken = setToken.address;
          subjectAdapterName = oneInchAdapterName;
          // Encode function data. Inputs are unused in the mock One Inch contract
          subjectData = oneInchExchangeMock.interface.encodeFunctionData("swap", [
            sourceToken.address, // Send token
            destinationToken.address, // Receive token
            sourceTokenQuantity, // Send quantity
            destinationTokenQuantity.sub(ether(1)), // Min receive quantity
            ZERO,
            ADDRESS_ZERO,
            [ADDRESS_ZERO],
            EMPTY_BYTES,
            [ZERO],
            [ZERO],
          ]);
          subjectMinDestinationQuantity = destinationTokenQuantity.sub(ether(1)); // Receive a min of 32 WETH for 1 WBTC
          subjectCaller = manager;
        });

        async function subject(): Promise<any> {
          tradeModule = tradeModule.connect(subjectCaller.wallet);
          return tradeModule.trade(
            subjectSetToken,
            subjectAdapterName,
            subjectSourceToken,
            subjectSourceQuantity,
            subjectDestinationToken,
            subjectMinDestinationQuantity,
            subjectData
          );
        }

        it("should transfer the correct components to the SetToken", async () => {
          const oldDestinationTokenBalance = await destinationToken.balanceOf(setToken.address);

          await subject();
          const totalDestinationQuantity = issueQuantity.mul(destinationTokenQuantity).div(ether(1));
          const expectedDestinationTokenBalance = oldDestinationTokenBalance.add(totalDestinationQuantity);
          const newDestinationTokenBalance = await destinationToken.balanceOf(setToken.address);
          expect(newDestinationTokenBalance).to.eq(expectedDestinationTokenBalance);
        });

        it("should transfer the correct components from the SetToken", async () => {
          const oldSourceTokenBalance = await sourceToken.balanceOf(setToken.address);

          await subject();
          const totalSourceQuantity = issueQuantity.mul(sourceTokenQuantity).div(ether(1));
          const expectedSourceTokenBalance = oldSourceTokenBalance.sub(totalSourceQuantity);
          const newSourceTokenBalance = await sourceToken.balanceOf(setToken.address);
          expect(newSourceTokenBalance).to.eq(expectedSourceTokenBalance);
        });

        it("should transfer the correct components to the exchange", async () => {
          const oldSourceTokenBalance = await sourceToken.balanceOf(oneInchExchangeMock.address);

          await subject();
          const totalSourceQuantity = issueQuantity.mul(sourceTokenQuantity).div(ether(1));
          const expectedSourceTokenBalance = oldSourceTokenBalance.add(totalSourceQuantity);
          const newSourceTokenBalance = await sourceToken.balanceOf(oneInchExchangeMock.address);
          expect(newSourceTokenBalance).to.eq(expectedSourceTokenBalance);
        });

        it("should transfer the correct components from the exchange", async () => {
          const oldDestinationTokenBalance = await destinationToken.balanceOf(oneInchExchangeMock.address);

          await subject();
          const totalDestinationQuantity = issueQuantity.mul(destinationTokenQuantity).div(ether(1));
          const expectedDestinationTokenBalance = oldDestinationTokenBalance.sub(totalDestinationQuantity);
          const newDestinationTokenBalance = await destinationToken.balanceOf(oneInchExchangeMock.address);
          expect(newDestinationTokenBalance).to.eq(expectedDestinationTokenBalance);
        });

        it("should update the positions on the SetToken correctly", async () => {
          const initialPositions = await setToken.getPositions();

          await subject();

          // All WBTC is sold for WETH
          const currentPositions = await setToken.getPositions();
          const newFirstPosition = (await setToken.getPositions())[0];

          expect(initialPositions.length).to.eq(1);
          expect(currentPositions.length).to.eq(1);
          expect(newFirstPosition.component).to.eq(destinationToken.address);
          expect(newFirstPosition.unit).to.eq(destinationTokenQuantity);
          expect(newFirstPosition.module).to.eq(ADDRESS_ZERO);
        });

        describe("when function signature does not match 1inch", async () => {
          beforeEach(async () => {
            // Encode random function
            subjectData = oneInchExchangeMock.interface.encodeFunctionData("addSetTokenAddress", [ADDRESS_ZERO]);
          });

          it("should revert", async () => {
            await expect(subject()).to.be.revertedWith("Not One Inch Swap Function");
          });
        });

        describe("when send token does not match calldata", async () => {
          beforeEach(async () => {
            // Get random source token
            const randomToken = await getRandomAccount();
            subjectData = oneInchExchangeMock.interface.encodeFunctionData("swap", [
              randomToken.address, // Send token
              destinationToken.address, // Receive token
              sourceTokenQuantity, // Send quantity
              destinationTokenQuantity.sub(ether(1)), // Min receive quantity
              ZERO,
              ADDRESS_ZERO,
              [ADDRESS_ZERO],
              EMPTY_BYTES,
              [ZERO],
              [ZERO],
            ]);
          });

          it("should revert", async () => {
            await expect(subject()).to.be.revertedWith("Invalid send token");
          });
        });

        describe("when receive token does not match calldata", async () => {
          beforeEach(async () => {
            // Get random source token
            const randomToken = await getRandomAccount();
            subjectData = oneInchExchangeMock.interface.encodeFunctionData("swap", [
              sourceToken.address, // Send token
              randomToken.address, // Receive token
              sourceTokenQuantity, // Send quantity
              destinationTokenQuantity.sub(ether(1)), // Min receive quantity
              ZERO,
              ADDRESS_ZERO,
              [ADDRESS_ZERO],
              EMPTY_BYTES,
              [ZERO],
              [ZERO],
            ]);
          });

          it("should revert", async () => {
            await expect(subject()).to.be.revertedWith("Invalid receive token");
          });
        });

        describe("when send token quantity does not match calldata", async () => {
          beforeEach(async () => {
            subjectData = oneInchExchangeMock.interface.encodeFunctionData("swap", [
              sourceToken.address, // Send token
              destinationToken.address, // Receive token
              ZERO, // Send quantity
              destinationTokenQuantity.sub(ether(1)), // Min receive quantity
              ZERO,
              ADDRESS_ZERO,
              [ADDRESS_ZERO],
              EMPTY_BYTES,
              [ZERO],
              [ZERO],
            ]);
          });

          it("should revert", async () => {
            await expect(subject()).to.be.revertedWith("Source quantity mismatch");
          });
        });

        describe("when min receive token quantity does not match calldata", async () => {
          beforeEach(async () => {
            subjectData = oneInchExchangeMock.interface.encodeFunctionData("swap", [
              sourceToken.address, // Send token
              destinationToken.address, // Receive token
              sourceTokenQuantity, // Send quantity
              ZERO, // Min receive quantity
              ZERO,
              ADDRESS_ZERO,
              [ADDRESS_ZERO],
              EMPTY_BYTES,
              [ZERO],
              [ZERO],
            ]);
          });

          it("should revert", async () => {
            await expect(subject()).to.be.revertedWith("Min destination quantity mismatch");
          });
        });
      });
    });

    describe("#removeModule", async () => {
      let subjectModule: Address;

      beforeEach(async () => {
        tradeModule = tradeModule.connect(manager.wallet);
        await tradeModule.initialize(setToken.address);

        subjectModule = tradeModule.address;
      });

      async function subject(): Promise<any> {
        setToken = setToken.connect(manager.wallet);
        return setToken.removeModule(subjectModule);
      }

      it("should remove the module", async () => {
        await subject();
        const isModuleEnabled = await setToken.isInitializedModule(tradeModule.address);
        expect(isModuleEnabled).to.eq(false);
      });
    });
  });
});