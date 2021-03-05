import "module-alias/register";
import { Address, Bytes } from "@utils/types";
import { Account } from "@utils/test/types";
import {
  Compound,
  CompoundLeverageModule,
  DebtIssuanceMock,
  SetToken,
  TradeAdapterMock
} from "@utils/contracts";
import { CEther, CERc20 } from "@utils/contracts/compound";
import DeployHelper from "@utils/deploys";
import {
  ether,
  preciseDiv,
} from "@utils/index";
import {
  cacheBeforeEach,
  getAccounts,
  getWaffleExpect,
  getSystemFixture,
  getCompoundFixture,
  getRandomAccount,
  getRandomAddress
} from "@utils/test/index";
import { CompoundFixture, SystemFixture } from "@utils/fixtures";
import { BigNumber } from "@ethersproject/bignumber";
import { ADDRESS_ZERO, ZERO, EMPTY_BYTES } from "@utils/constants";

const expect = getWaffleExpect();

describe("CompoundLeverageModule TestSuite 2", () => {
  let owner: Account;
  let deployer: DeployHelper;
  let setup: SystemFixture;
  let compoundSetup: CompoundFixture;

  let compoundLibrary: Compound;
  let compoundLeverageModule: CompoundLeverageModule;
  let debtIssuanceMock: DebtIssuanceMock;
  let cEther: CEther;
  let cDai: CERc20;
  let cComp: CERc20;

  const tradeAdapterName = "TRADEMOCK";
  let tradeMock: TradeAdapterMock;

  let cTokenInitialMantissa: BigNumber;

  cacheBeforeEach(async () => {
    [
      owner,
    ] = await getAccounts();

    deployer = new DeployHelper(owner.wallet);

    setup = getSystemFixture(owner.address);
    await setup.initialize();

    compoundSetup = getCompoundFixture(owner.address);
    await compoundSetup.initialize();

    cTokenInitialMantissa = ether(200000000);
    cEther = await compoundSetup.createAndEnableCEther(
      cTokenInitialMantissa,
      compoundSetup.comptroller.address,
      compoundSetup.interestRateModel.address,
      "Compound ether",
      "cETH",
      8,
      ether(0.75), // 75% collateral factor
      ether(590)
    );

    cDai = await compoundSetup.createAndEnableCToken(
      setup.dai.address,
      cTokenInitialMantissa,
      compoundSetup.comptroller.address,
      compoundSetup.interestRateModel.address,
      "Compound Dai",
      "cDAI",
      8,
      ether(0.75), // 75% collateral factor
      ether(1)
    );

    cComp = await compoundSetup.createAndEnableCToken(
      compoundSetup.comp.address,
      cTokenInitialMantissa,
      compoundSetup.comptroller.address,
      compoundSetup.interestRateModel.address,
      "Compound COMP",
      "cCOMP",
      8,
      ether(0.75), // 75% collateral factor
      ether(1)
    );

    await compoundSetup.comptroller._setCompRate(ether(1));
    await compoundSetup.comptroller._addCompMarkets([cEther.address, cDai.address, cComp.address]);

    debtIssuanceMock = await deployer.mocks.deployDebtIssuanceMock();
    await setup.controller.addModule(debtIssuanceMock.address);

    compoundLibrary = await deployer.libraries.deployCompound();
    compoundLeverageModule = await deployer.modules.deployCompoundLeverageModule(
      setup.controller.address,
      compoundSetup.comp.address,
      compoundSetup.comptroller.address,
      cEther.address,
      setup.weth.address,
      "Compound",
      compoundLibrary.address,
    );
    await setup.controller.addModule(compoundLeverageModule.address);

    // Deploy Trade Mock

    tradeMock = await deployer.mocks.deployTradeAdapterMock();

    await setup.integrationRegistry.addIntegration(
      compoundLeverageModule.address,
      tradeAdapterName,
      tradeMock.address
    );

    // Add debt issuance address to integration
    await setup.integrationRegistry.addIntegration(
      compoundLeverageModule.address,
      "DefaultIssuanceModule",
      debtIssuanceMock.address
    );
  });

  describe("#deleverToZeroBorrowBalance", async () => {
    let setToken: SetToken;
    let isInitialized: boolean;

    let subjectSetToken: Address;
    let subjectCollateralAsset: Address;
    let subjectRepayAsset: Address;
    let subjectRedeemQuantity: BigNumber;
    let subjectTradeAdapterName: string;
    let subjectTradeData: Bytes;
    let subjectCaller: Account;

    context("when cETH is collateral asset", async () => {

      const initializeContracts = async () => {
        setToken = await setup.createSetToken(
          [cEther.address],
          [BigNumber.from(10000000000)],
          [compoundLeverageModule.address, debtIssuanceMock.address, setup.issuanceModule.address]
        );
        await debtIssuanceMock.initialize(setToken.address);
        // Add SetToken to allow list
        await compoundLeverageModule.updateAllowedSetToken(setToken.address, true);
        // Initialize module if set to true
        if (isInitialized) {
          await compoundLeverageModule.initialize(
            setToken.address,
            [setup.weth.address, setup.dai.address],
            [setup.dai.address, setup.weth.address]
          );
        }
        await setup.issuanceModule.initialize(setToken.address, ADDRESS_ZERO);

        // Fund TradeAdapter with destinationToken WETH and DAI
        await setup.weth.transfer(tradeMock.address, ether(10));
        await setup.dai.transfer(tradeMock.address, ether(10000));

        // Mint cTokens
        await setup.weth.approve(cEther.address, ether(1000));
        await cEther.mint({value: ether(1000)});
        await setup.dai.approve(cDai.address, ether(100000));
        await cDai.mint(ether(100000));

        // Approve tokens to issuance module and call issue
        await cEther.approve(setup.issuanceModule.address, ether(1000));

        // Issue 1 SetToken.
        const issueQuantity = ether(1);
        await setup.issuanceModule.issue(setToken.address, issueQuantity, owner.address);

        // Lever SetToken
        if (isInitialized) {
          await compoundLeverageModule.lever(
            setToken.address,
            setup.dai.address,
            setup.weth.address,
            ether(590),
            ether(1),
            tradeAdapterName,
            EMPTY_BYTES
          );
        }
      };

      const initializeSubjectVariables = () => {
        subjectSetToken = setToken.address;
        subjectCollateralAsset = setup.weth.address;
        subjectRepayAsset = setup.dai.address;
        subjectRedeemQuantity = ether(1);
        subjectTradeAdapterName = tradeAdapterName;
        subjectTradeData = EMPTY_BYTES;
        subjectCaller = owner;
      };

      async function subject(): Promise<any> {
        return compoundLeverageModule.connect(subjectCaller.wallet).deleverToZeroBorrowBalance(
          subjectSetToken,
          subjectCollateralAsset,
          subjectRepayAsset,
          subjectRedeemQuantity,
          subjectTradeAdapterName,
          subjectTradeData
        );
      }

      describe("when module is initialized", async () => {
        before(async () => {
          isInitialized = true;
        });

        cacheBeforeEach(initializeContracts);
        beforeEach(initializeSubjectVariables);

        it("should update the collateral position on the SetToken correctly", async () => {
          const initialPositions = await setToken.getPositions();

          await subject();

          // cEther position is decreased
          const currentPositions = await setToken.getPositions();
          const newFirstPosition = (await setToken.getPositions())[0];

          // Get expected cTokens minted
          const removedUnits = preciseDiv(subjectRedeemQuantity, cTokenInitialMantissa);
          const expectedFirstPositionUnit = initialPositions[0].unit.sub(removedUnits);

          expect(initialPositions.length).to.eq(2);
          expect(currentPositions.length).to.eq(2);
          shouldBeExpectedDefaultPosition(newFirstPosition, cEther.address, expectedFirstPositionUnit);
        });

        it("should wipe out the debt on Compound", async () => {
          await subject();

          const borrowDebt = (await cDai.borrowBalanceStored(setToken.address)).mul(-1);

          expect(borrowDebt).to.eq(ZERO);
        });

        it("should remove any external positions on the borrow asset", async () => {
          await subject();

          const borrowAssetExternalModules = await setToken.getExternalPositionModules(setup.dai.address);
          const borrowExternalUnit = await setToken.getExternalPositionRealUnit(
            setup.dai.address,
            compoundLeverageModule.address
          );
          const isPositionModule = await setToken.isExternalPositionModule(
            setup.dai.address,
            compoundLeverageModule.address
          );

          expect(borrowAssetExternalModules.length).to.eq(0);
          expect(borrowExternalUnit).to.eq(ZERO);
          expect(isPositionModule).to.eq(false);
        });

        it("should update the borrow asset equity on the SetToken correctly", async () => {
          await subject();

          // The DAI position is positive and represents equity
          const newSecondPosition = (await setToken.getPositions())[1];

          expect(newSecondPosition.component).to.eq(setup.dai.address);
          expect(newSecondPosition.positionState).to.eq(0); // Default
          expect(BigNumber.from(newSecondPosition.unit)).to.gt(ZERO);
          expect(newSecondPosition.module).to.eq(ADDRESS_ZERO);
        });

        it("should transfer the correct components to the exchange", async () => {
          const oldSourceTokenBalance = await setup.weth.balanceOf(tradeMock.address);

          await subject();
          const totalSourceQuantity = subjectRedeemQuantity;
          const expectedSourceTokenBalance = oldSourceTokenBalance.add(totalSourceQuantity);
          const newSourceTokenBalance = await setup.weth.balanceOf(tradeMock.address);
          expect(newSourceTokenBalance).to.eq(expectedSourceTokenBalance);
        });

        it("should transfer the correct components from the exchange", async () => {
          await subject();
          const expectedDestinationTokenBalance = ZERO;
          const newDestinationTokenBalance = await setup.dai.balanceOf(tradeMock.address);
          expect(newDestinationTokenBalance).to.eq(expectedDestinationTokenBalance);
        });

        // Need to find a way to test the repay quantity
        // it("should emit the LeverageDecreased event", async () => {
        //   const expectedProtocolFee = ZERO;
        //   const expectedRepayQuantity = (await cDai.borrowBalanceStored(setToken.address)).mul(-1);

        //   await expect(subject()).to.emit(compoundLeverageModule, "LeverageDecreased").withArgs(
        //       setToken.address,
        //       subjectCollateralAsset,
        //       subjectRepayAsset,
        //       tradeMock.address,
        //       subjectRedeemQuantity,
        //       expectedRepayQuantity,
        //       expectedProtocolFee
        //   );
        // });

        // When a third party

        describe("when the exchange is not valid", async () => {
          beforeEach(async () => {
            subjectTradeAdapterName = "UNISWAP";
          });

          it("should revert", async () => {
            await expect(subject()).to.be.revertedWith("Must be valid adapter");
          });
        });

        describe("when quantity of token to sell is 0", async () => {
          beforeEach(async () => {
            subjectRedeemQuantity = ZERO;
          });

          it("should revert", async () => {
            await expect(subject()).to.be.revertedWith("Quantity is 0");
          });
        });

        describe("when redeeming return data is a nonzero value", async () => {
          beforeEach(async () => {
            // Set redeem quantity to more than account liquidity
            subjectRedeemQuantity = ether(100001);
          });

          it("should revert", async () => {
            await expect(subject()).to.be.revertedWith("Redeem failed");
          });
        });

        describe("when repay return data is a nonzero value", async () => {
          beforeEach(async () => {
            const newComptroller = await deployer.external.deployComptroller();

            await cDai._setComptroller(newComptroller.address);
          });

          afterEach(async () => {
            await cDai._setComptroller(compoundSetup.comptroller.address);
          });

          it("should revert", async () => {
            await expect(subject()).to.be.revertedWith("Repay failed");
          });
        });

        describe("when borrow / repay asset is not enabled", async () => {
          beforeEach(async () => {
            subjectRepayAsset = setup.wbtc.address;
          });

          it("should revert", async () => {
            await expect(subject()).to.be.revertedWith("Borrow not enabled");
          });
        });

        describe("when collateral asset is not enabled", async () => {
          beforeEach(async () => {
            subjectCollateralAsset = await getRandomAddress();
          });

          it("should revert", async () => {
            await expect(subject()).to.be.revertedWith("Collateral not enabled");
          });
        });

        describe("when borrow asset is same as collateral asset", async () => {
          beforeEach(async () => {
            subjectRepayAsset = setup.weth.address;
          });

          it("should revert", async () => {
            await expect(subject()).to.be.revertedWith("Must be different");
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

        describe("when SetToken is not valid", async () => {
          beforeEach(async () => {
            const nonEnabledSetToken = await setup.createNonControllerEnabledSetToken(
              [setup.weth.address],
              [ether(1)],
              [compoundLeverageModule.address],
              owner.address
            );

            subjectSetToken = nonEnabledSetToken.address;
          });

          it("should revert", async () => {
            await expect(subject()).to.be.revertedWith("Must be a valid and initialized SetToken");
          });
        });
      });

      describe("when module is not initialized", async () => {
        beforeEach(async () => {
          isInitialized = false;
          await initializeContracts();
          initializeSubjectVariables();
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("Must be a valid and initialized SetToken");
        });
      });
    });

    context("when cETH is borrow asset", async () => {
      before(async () => {
        isInitialized = true;
      });

      cacheBeforeEach(async () => {
        setToken = await setup.createSetToken(
          [cDai.address],
          [BigNumber.from(10000000000000)],
          [compoundLeverageModule.address, debtIssuanceMock.address, setup.issuanceModule.address]
        );
        await debtIssuanceMock.initialize(setToken.address);
        // Add SetToken to allow list
        await compoundLeverageModule.updateAllowedSetToken(setToken.address, true);
        // Initialize module if set to true
        if (isInitialized) {
          await compoundLeverageModule.initialize(
            setToken.address,
            [setup.weth.address, setup.dai.address],
            [setup.dai.address, setup.weth.address]
          );
        }
        await setup.issuanceModule.initialize(setToken.address, ADDRESS_ZERO);

        // Fund One Inch exchange with destinationToken WETH and DAI
        await setup.weth.transfer(tradeMock.address, ether(10));
        await setup.dai.transfer(tradeMock.address, ether(10000));

        // Mint cTokens
        await setup.weth.approve(cEther.address, ether(1000));
        await cEther.mint({value: ether(1000)});
        await setup.dai.approve(cDai.address, ether(100000));
        await cDai.mint(ether(100000));

        // Approve tokens to issuance module and call issue
        await cDai.approve(setup.issuanceModule.address, ether(1000));

        // Issue 1 SetToken.
        const issueQuantity = ether(1);
        await setup.issuanceModule.issue(setToken.address, issueQuantity, owner.address);

        // Lever SetToken
        if (isInitialized) {
          const leverTradeData = tradeMock.interface.encodeFunctionData("trade", [
            setup.dai.address, // Send token
            setup.weth.address, // Receive token
            setToken.address, // Destination address
            ether(1), // Send quantity
            ether(590), // Min receive quantity
          ]);

          await compoundLeverageModule.lever(
            setToken.address,
            setup.weth.address,
            setup.dai.address,
            ether(1),
            ether(590),
            tradeAdapterName,
            leverTradeData
          );
        }
      });

      beforeEach(() => {
        subjectSetToken = setToken.address;
        subjectCollateralAsset = setup.dai.address;
        subjectRepayAsset = setup.weth.address;
        subjectRedeemQuantity = ether(590);
        subjectTradeAdapterName = tradeAdapterName;
        subjectTradeData = EMPTY_BYTES;
        subjectCaller = owner;
      });

      async function subject(): Promise<any> {
        return compoundLeverageModule.connect(subjectCaller.wallet).deleverToZeroBorrowBalance(
          subjectSetToken,
          subjectCollateralAsset,
          subjectRepayAsset,
          subjectRedeemQuantity,
          subjectTradeAdapterName,
          subjectTradeData
        );
      }

      it("should update the collateral position on the SetToken correctly", async () => {
        const initialPositions = await setToken.getPositions();

        await subject();

        // cEther position is decreased
        const currentPositions = await setToken.getPositions();
        const newFirstPosition = (await setToken.getPositions())[0];

        // Get expected cTokens minted
        const removedUnits = preciseDiv(subjectRedeemQuantity, cTokenInitialMantissa);
        const expectedFirstPositionUnit = initialPositions[0].unit.sub(removedUnits);

        expect(initialPositions.length).to.eq(2);
        expect(currentPositions.length).to.eq(2);
        shouldBeExpectedDefaultPosition(newFirstPosition, cDai.address, expectedFirstPositionUnit);
      });

      it("should wipe out the debt on Compound", async () => {
        await subject();

        const borrowDebt = (await cEther.borrowBalanceStored(setToken.address)).mul(-1);

        expect(borrowDebt).to.eq(ZERO);
      });

      it("should update the borrow asset equity on the SetToken correctly", async () => {
        await subject();

        // The DAI position is positive and represents equity
        const newSecondPosition = (await setToken.getPositions())[1];

        expect(newSecondPosition.component).to.eq(setup.weth.address);
        expect(newSecondPosition.positionState).to.eq(0); // Default
        expect(BigNumber.from(newSecondPosition.unit)).to.gt(ZERO);
        expect(newSecondPosition.module).to.eq(ADDRESS_ZERO);
      });

      it("should remove any external positions on the borrow asset", async () => {
        await subject();

        const borrowAssetExternalModules = await setToken.getExternalPositionModules(setup.weth.address);
        const borrowExternalUnit = await setToken.getExternalPositionRealUnit(
          setup.weth.address,
          compoundLeverageModule.address
        );
        const isPositionModule = await setToken.isExternalPositionModule(
          setup.weth.address,
          compoundLeverageModule.address
        );

        expect(borrowAssetExternalModules.length).to.eq(0);
        expect(borrowExternalUnit).to.eq(ZERO);
        expect(isPositionModule).to.eq(false);
      });

      it("should transfer the correct components to the exchange", async () => {
        const oldSourceTokenBalance = await setup.dai.balanceOf(tradeMock.address);

        await subject();
        const totalSourceQuantity = subjectRedeemQuantity;
        const expectedSourceTokenBalance = oldSourceTokenBalance.add(totalSourceQuantity);
        const newSourceTokenBalance = await setup.dai.balanceOf(tradeMock.address);
        expect(newSourceTokenBalance).to.eq(expectedSourceTokenBalance);
      });

      it("should transfer the correct components from the exchange", async () => {
        await subject();
        const expectedDestinationTokenBalance = ZERO;
        const newDestinationTokenBalance = await setup.weth.balanceOf(tradeMock.address);
        expect(newDestinationTokenBalance).to.eq(expectedDestinationTokenBalance);
      });
    });

  });
});

function shouldBeExpectedDefaultPosition(position: any, component: Address, expectedDefaultUnit: BigNumber) {
  expect(position.component).to.eq(component);
  expect(position.positionState).to.eq(0); // Default
  expect(position.unit).to.eq(expectedDefaultUnit);
  expect(position.module).to.eq(ADDRESS_ZERO);
}
