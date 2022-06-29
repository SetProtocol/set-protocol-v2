import "module-alias/register";

import { BigNumber } from "ethers";
import { ethers, network } from "hardhat";

import { Address, Bytes } from "@utils/types";
import { Account } from "@utils/test/types";
import {
  SetToken,
  TradeModule,
  ManagerIssuanceHookMock,
  VelodromeExchangeAdapter,
} from "@utils/contracts";
import { ZERO } from "@utils/constants";
import DeployHelper from "@utils/deploys";
import { ether, usdc } from "@utils/index";
import { cacheBeforeEach, getAccounts, getSystemFixture, getWaffleExpect } from "@utils/test/index";

import { SystemFixture } from "@utils/fixtures";
import { parseUnits } from "ethers/lib/utils";
import { IVelodromeRouter } from "@typechain/IVelodromeRouter";
import { IERC20 } from "@typechain/IERC20";
import { IERC20__factory } from "@typechain/factories/IERC20__factory";

const expect = getWaffleExpect();

describe("Velodrome TradeModule Integration [@optimism]", () => {
  const velodromeAdapterName = "Velodrome";

  let owner: Account;
  let manager: Account;
  let deployer: DeployHelper;

  let velodromeExchangeAdapter: VelodromeExchangeAdapter;

  let setup: SystemFixture;
  let velodromeRouter: IVelodromeRouter;
  let tradeModule: TradeModule;

  before(async () => {
    await network.provider.request({
      method: "hardhat_reset",
      params: [
        {
          forking: {
            jsonRpcUrl: `https://opt-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_TOKEN}`,
            blockNumber: 13454300,
          },
        },
      ],
    });

    [owner, manager] = await getAccounts();

    deployer = new DeployHelper(owner.wallet);
    setup = getSystemFixture(owner.address);
    await setup.initialize();

    velodromeRouter = await ethers.getContractAt(
      "IVelodromeRouter",
      "0xa132DAB612dB5cB9fC9Ac426A0Cc215A3423F9c9",
    );

    velodromeExchangeAdapter = await deployer.adapters.deployVelodromeExchangeAdapter(
      velodromeRouter.address,
    );

    tradeModule = await deployer.modules.deployTradeModule(setup.controller.address);
    await setup.controller.addModule(tradeModule.address);

    await setup.integrationRegistry.addIntegration(
      tradeModule.address,
      velodromeAdapterName,
      velodromeExchangeAdapter.address,
    );
  });

  after(async () => {
    await network.provider.request({
      method: "hardhat_reset",
      params: [],
    });
  });

  describe("#trade", function () {
    let sourceToken: IERC20;
    let destinationToken: IERC20;
    let setToken: SetToken;
    let issueQuantity: BigNumber;

    context("when trading a Default component on Velodrome", async () => {
      let mockPreIssuanceHook: ManagerIssuanceHookMock;
      let sourceTokenQuantity: BigNumber;
      let destinationTokenQuantity: BigNumber;

      let subjectDestinationToken: Address;
      let subjectSourceToken: Address;
      let subjectSourceQuantity: BigNumber;
      let subjectAdapterName: string;
      let subjectSetToken: Address;
      let subjectMinDestinationQuantity: BigNumber;
      let subjectData: Bytes;
      let subjectCaller: Account;

      cacheBeforeEach(async () => {
        const whale = "0xAD7b4C162707E0B2b5f6fdDbD3f8538A5fbA0d60";
        // prepare WETH and USDC
        await network.provider.request({
          method: "hardhat_impersonateAccount",
          params: [whale],
        });

        await owner.wallet.sendTransaction({
          from: owner.address,
          to: whale,
          value: parseUnits("1"),
        });

        sourceToken = IERC20__factory.connect(
          "0x4200000000000000000000000000000000000006", // weth
          await ethers.getSigner(whale),
        );
        destinationToken = IERC20__factory.connect(
          "0x7F5c764cBc14f9669B88837ca1490cCa17c31607", // usdc
          await ethers.getSigner(whale),
        );

        // Create Set token
        setToken = await setup.createSetToken(
          [sourceToken.address],
          [ether(1)],
          [setup.issuanceModule.address, tradeModule.address],
          manager.address,
        );

        await sourceToken.approve(velodromeRouter.address, ether(10));
        await destinationToken.approve(velodromeRouter.address, usdc(10000));

        tradeModule = tradeModule.connect(manager.wallet);
        await tradeModule.initialize(setToken.address);

        sourceTokenQuantity = ether(1);
        [, destinationTokenQuantity] = await velodromeRouter.getAmountsOut(sourceTokenQuantity, [
          {
            from: sourceToken.address,
            to: destinationToken.address,
            stable: false,
          },
        ]);

        // Transfer from weth whale to manager
        await sourceToken.transfer(manager.address, sourceTokenQuantity);

        // Approve tokens to Controller and call issue
        sourceToken = sourceToken.connect(manager.wallet);
        await sourceToken.approve(setup.issuanceModule.address, ethers.constants.MaxUint256);

        // Deploy mock issuance hook and initialize issuance module
        setup.issuanceModule = setup.issuanceModule.connect(manager.wallet);
        mockPreIssuanceHook = await deployer.mocks.deployManagerIssuanceHookMock();
        await setup.issuanceModule.initialize(setToken.address, mockPreIssuanceHook.address);

        issueQuantity = ether(1);
        await setup.issuanceModule.issue(setToken.address, issueQuantity, owner.address);
      });

      beforeEach(async () => {
        subjectSourceToken = sourceToken.address;
        subjectDestinationToken = destinationToken.address;
        subjectSourceQuantity = sourceTokenQuantity;
        subjectSetToken = setToken.address;
        subjectMinDestinationQuantity = destinationTokenQuantity.sub(usdc(1));
        subjectAdapterName = velodromeAdapterName;

        subjectData = await velodromeExchangeAdapter.generateDataParam(
          [
            {
              from: subjectSourceToken,
              to: subjectDestinationToken,
              stable: false,
            },
          ],
          ethers.constants.MaxUint256,
        );

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
          subjectData,
        );
      }

      it("should transfer the correct components to the SetToken", async () => {
        const oldDestinationTokenBalance = await destinationToken.balanceOf(setToken.address);
        const [, expectedReceiveQuantity] = await velodromeRouter.getAmountsOut(
          subjectSourceQuantity,
          [
            {
              from: subjectSourceToken,
              to: subjectDestinationToken,
              stable: false,
            },
          ],
        );

        await subject();

        const expectedDestinationTokenBalance = oldDestinationTokenBalance.add(
          expectedReceiveQuantity,
        );
        const newDestinationTokenBalance = await destinationToken.balanceOf(setToken.address);
        expect(expectedReceiveQuantity).to.be.gt(ZERO);
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
    });
  });
});
