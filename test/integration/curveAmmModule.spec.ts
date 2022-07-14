import "module-alias/register";

import { ethers, network } from "hardhat";
import { Address } from "@utils/types";
import { Account } from "@utils/test/types";
import { AmmModule, SetToken } from "@utils/contracts";
import DeployHelper from "@utils/deploys";
import {
  addSnapshotBeforeRestoreAfterEach,
  getAccounts,
  getSystemFixture,
  getWaffleExpect,
} from "@utils/test/index";
import { ether } from "@utils/index";
import { SystemFixture } from "@utils/fixtures";
import { BigNumber } from "ethers";
import { CurveAmmAdapter } from "../../typechain/CurveAmmAdapter";
import { IERC20Metadata } from "../../typechain/IERC20Metadata";
import { IERC20Metadata__factory } from "../../typechain/factories/IERC20Metadata__factory";
import { parseUnits } from "ethers/lib/utils";

const expect = getWaffleExpect();

const getTokenFromWhale = async (
  token: IERC20Metadata,
  whaleAddress: Address,
  recipient: Account,
  amount: BigNumber,
) => {
  expect(amount).to.gt(0);

  await network.provider.request({
    method: "hardhat_impersonateAccount",
    params: [whaleAddress],
  });
  await recipient.wallet.sendTransaction({
    from: recipient.address,
    to: whaleAddress,
    value: ether("0.1"),
  });
  const whale = await ethers.getSigner(whaleAddress);
  await token.connect(whale).transfer(recipient.address, amount);
};

describe("CurveAmmAdapter [ @forked-mainnet ]", () => {
  let setToken: SetToken;
  let owner: Account, manager: Account;
  let deployer: DeployHelper;
  let setup: SystemFixture;
  let ammModule: AmmModule;

  before(async () => {
    await network.provider.request({
      method: "hardhat_reset",
      params: [
        {
          forking: {
            jsonRpcUrl: `https://eth-mainnet.alchemyapi.io/v2/${process.env.ALCHEMY_TOKEN}`,
            blockNumber: 15118000,
          },
        },
      ],
    });

    [owner, manager] = await getAccounts();

    deployer = new DeployHelper(owner.wallet);
    setup = getSystemFixture(owner.address);
    await setup.initialize();

    ammModule = await deployer.modules.deployAmmModule(setup.controller.address);
    await setup.controller.addModule(ammModule.address);
  });

  after(async () => {
    await network.provider.request({
      method: "hardhat_reset",
      params: [],
    });
  });

  const runTestScenarioForCurveLP = ({
    scenarioName,
    poolTokenAddress,
    poolMinterAddress,
    isCurveV1,
    coinCount,
    coinAddresses,
    poolTokenWhale,
    coinWhales,
  }: {
    scenarioName: string;
    poolTokenAddress: Address;
    poolMinterAddress: Address;
    isCurveV1: boolean;
    coinCount: number;
    coinAddresses: Address[];
    poolTokenWhale: Address;
    coinWhales: Address[];
  }) => {
    describe(scenarioName, () => {
      const coins: IERC20Metadata[] = [];
      let poolToken: IERC20Metadata;
      let curveAmmAdapter: CurveAmmAdapter;
      let curveAmmAdapterName: string;
      const coinBalances: BigNumber[] = [];

      before(async () => {
        // prepare lpToken / each coins from whales
        poolToken = await IERC20Metadata__factory.connect(poolTokenAddress, owner.wallet);
        await getTokenFromWhale(
          poolToken,
          poolTokenWhale,
          manager,
          await poolToken.balanceOf(poolTokenWhale),
        );
        for (let i = 0; i < coinCount; i++) {
          coins.push(await IERC20Metadata__factory.connect(coinAddresses[i], owner.wallet));
          coinBalances.push(parseUnits("1", await coins[i].decimals()));
          await coins[i]
            .connect(manager.wallet)
            .approve(setup.issuanceModule.address, coinBalances[i]);
          await getTokenFromWhale(coins[i], coinWhales[i], manager, coinBalances[i]);
        }

        curveAmmAdapter = await deployer.adapters.deployCurveAmmAdapter(
          poolTokenAddress,
          poolMinterAddress,
          isCurveV1,
          coinCount,
        );
        curveAmmAdapterName = "CURVEAMM" + scenarioName;

        await setup.integrationRegistry.addIntegration(
          ammModule.address,
          curveAmmAdapterName,
          curveAmmAdapter.address,
        );

        // Create Set token
        setToken = await setup.createSetToken(
          coinAddresses,
          coinBalances,
          [setup.issuanceModule.address, ammModule.address],
          manager.address,
        );

        await ammModule.connect(manager.wallet).initialize(setToken.address);

        // Deploy mock issuance hook and initialize issuance module
        const mockPreIssuanceHook = await deployer.mocks.deployManagerIssuanceHookMock();
        await setup.issuanceModule
          .connect(manager.wallet)
          .initialize(setToken.address, mockPreIssuanceHook.address);

        const issueQuantity = ether(1);
        await setup.issuanceModule
          .connect(manager.wallet)
          .issue(setToken.address, issueQuantity, owner.address);
      });

      addSnapshotBeforeRestoreAfterEach();

      it.only("should transfer correct components and get LP tokens", async () => {
        const balanceBefore = await poolToken.balanceOf(setToken.address);

        await ammModule
          .connect(manager.wallet)
          .addLiquidity(
            setToken.address,
            curveAmmAdapterName,
            poolTokenAddress,
            1,
            coinAddresses,
            coinBalances,
          );

        expect(await poolToken.balanceOf(setToken.address)).to.gt(balanceBefore);
      });

      it.only("should transfer LP tokens and get component tokens", async () => {
        await ammModule
          .connect(manager.wallet)
          .addLiquidity(
            setToken.address,
            curveAmmAdapterName,
            poolTokenAddress,
            1,
            coinAddresses,
            coinBalances,
          );

        const lpBalanceBefore = await poolToken.balanceOf(setToken.address);
        for (let i = 0; i < coinCount; i++) {
          expect(await coins[i].balanceOf(setToken.address)).to.eq(0);
        }

        await ammModule
          .connect(manager.wallet)
          .removeLiquidity(
            setToken.address,
            curveAmmAdapterName,
            poolTokenAddress,
            lpBalanceBefore,
            coinAddresses,
            Array(coinCount).fill(1),
          );

        expect(await poolToken.balanceOf(setToken.address)).to.eq(0);
        for (let i = 0; i < coinCount; i++) {
          expect(await coins[i].balanceOf(setToken.address)).to.gt(0);
        }
      });

      it.only("should transfer LP tokens and get only one component token", async () => {
        await ammModule
          .connect(manager.wallet)
          .addLiquidity(
            setToken.address,
            curveAmmAdapterName,
            poolTokenAddress,
            1,
            coinAddresses,
            coinBalances,
          );

        const lpBalanceBefore = await poolToken.balanceOf(setToken.address);
        for (let i = 0; i < coinCount; i++) {
          expect(await coins[i].balanceOf(setToken.address)).to.eq(0);
        }

        const withdrawCoin = coinAddresses[1];
        await ammModule
          .connect(manager.wallet)
          .removeLiquiditySingleAsset(
            setToken.address,
            curveAmmAdapterName,
            poolTokenAddress,
            lpBalanceBefore,
            withdrawCoin,
            1,
          );

        expect(await poolToken.balanceOf(setToken.address)).to.eq(0);
        for (let i = 0; i < coinCount; i++) {
          if (coinAddresses[i] === withdrawCoin) {
            expect(await coins[i].balanceOf(setToken.address)).to.gt(0);
          } else {
            expect(await coins[i].balanceOf(setToken.address)).to.eq(0);
          }
        }
      });
    });
  };

  const testScenarios = [
    {
      scenarioName: "Curve LP with 2 coins (v1) - MIM/3CRV",
      poolTokenAddress: "0x5a6A4D54456819380173272A5E8E9B9904BdF41B",
      poolMinterAddress: "0x5a6A4D54456819380173272A5E8E9B9904BdF41B",
      isCurveV1: true,
      coinCount: 2,
      coinAddresses: [
        "0x99D8a9C45b2ecA8864373A26D1459e3Dff1e17F3", // MIM
        "0x6c3F90f043a72FA612cbac8115EE7e52BDe6E490", // 3CRV
      ],
      poolTokenWhale: "0x11B49699aa0462a0488d93aEFdE435D4D6608469", // Curve MIM/3CRV whale
      coinWhales: [
        "0x4240781A9ebDB2EB14a183466E8820978b7DA4e2", // MIM whale
        "0x5438649eE5B0150B2cd218004aA324075e2f292C", // 3CRV whale
      ],
    },
    {
      scenarioName: "Curve LP with 3 coins (v2) - USDT/WBTC/WETH",
      poolTokenAddress: "0xc4AD29ba4B3c580e6D59105FFf484999997675Ff",
      poolMinterAddress: "0xD51a44d3FaE010294C616388b506AcdA1bfAAE46",
      isCurveV1: false,
      coinCount: 3,
      coinAddresses: [
        "0xdAC17F958D2ee523a2206206994597C13D831ec7", // USDT
        "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599", // WBTC
        "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2", // WETH
      ],
      poolTokenWhale: "0xfE4d9D4F102b40193EeD8aA6C52BD87a328177fc", // Curve USDT/WBTC/WETH whale
      coinWhales: [
        "0x5a52E96BAcdaBb82fd05763E25335261B270Efcb", // USDT whale
        "0xf584F8728B874a6a5c7A8d4d387C9aae9172D621", // WBTC whale
        "0x06920C9fC643De77B99cB7670A944AD31eaAA260", // WETH whale
      ],
    },
  ];

  testScenarios.forEach(scenario => runTestScenarioForCurveLP(scenario));
});
