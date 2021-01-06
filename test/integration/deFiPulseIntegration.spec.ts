// import "module-alias/register";

// const _ = require("lodash");
// import { BigNumber } from "ethers/utils";

// import { Address, Account, Position, StreamingFeeState } from "@utils/types";
// import { ADDRESS_ZERO, ZERO, MAX_UINT_256, ONE_YEAR_IN_SECONDS } from "@utils/constants";
// import { SetToken } from "@utils/contracts";
// import DeployHelper from "@utils/deploys";
// import {
//   addSnapshotBeforeRestoreAfterEach,
//   ether,
//   getAccounts,
//   getPostFeePositionUnits,
//   getSystemFixture,
//   getStreamingFee,
//   getStreamingFeeInflationAmount,
//   getTransactionTimestamp,
//   getWaffleExpect,
//   increaseTimeAsync,
//   preciseMul,
// } from "@utils/index";
// import { SystemFixture } from "@utils/fixtures";
// import { ContractTransaction } from "ethers";

// const expect = getWaffleExpect();

// class TokenFixture {
//   [key: string]: any;
//   private _owner: Account;
//   private _deployer: DeployHelper;
//   public tokens: string[];

//   constructor(owner: Account) {
//     this._owner = owner;
//     this._deployer = new DeployHelper(owner.wallet);
//   }

//   public async deployTokensAndOracles(tokens: string[], prices: BigNumber[]): Promise<void> {
//     this.tokens = tokens;
//     for (let i = 0; i < tokens.length; i++) {
//       // Assumes all tokens are 18 decimals
//       this[tokens[i]] = await this._deployer.mocks.deployTokenMock(this._owner.address, ether(1000), BigNumber.from(18));
//       this[tokens[i] + "Oracle"] = await this._deployer.mocks.deployOracleMock(prices[i]);
//     }
//   }

//   public getTokenAddresses(): Address[] {
//     const addresses: Address[] = [];
//     for (let i = 0; i < this.tokens.length; i++) {
//       addresses.push(this[this.tokens[i]].address);
//     }

//     return addresses;
//   }

//   public async unlimitedApproveTokens(approver: Account, spender: Address, tokens?: string[]): Promise<void> {
//     const approvals = tokens ? tokens : this.tokens;

//     for (let i = 0; i < approvals.length; i++) {
//       await this[approvals[i]].connect(approver.wallet).approve(spender, MAX_UINT_256);
//     }
//   }
// }

// function determineInitialSetUnits(setPrice: BigNumber, tokenPrices: BigNumber[], tokenAllocations: BigNumber[]): BigNumber[] {
//   const newUnits: BigNumber[] = [];
//   for (let i = 0; i < tokenAllocations.length; i++) {
//     newUnits.push(setPrice.mul(tokenAllocations[i]).div(tokenPrices[i])); // Assumes all tokens are 18 decimals
//   }

//   return newUnits;
// }

// describe("DFP Integration Tests", () => {
//   let owner: Account;
//   let tokens: TokenFixture;
//   let setup: SystemFixture;
//   let protocolFee: BigNumber;

//   let manager: Account;
//   let streamingfeeSettings: StreamingFeeState;
//   let dfpSet: SetToken;

//   before(async () => {
//     [
//       owner,
//       manager,
//     ] = await getAccounts();

//     setup = getSystemFixture(owner.address);
//     tokens = new TokenFixture(owner);

//     await setup.initialize();

//     const tokenTickers = ["comp", "mkr", "snx", "zrx", "knc", "lend", "bal", "ren", "lrc", "bnt", "nmr"];
//     const tokenPrices = [
//       ether(136.02),
//       ether(596.12),
//       ether(4.56),
//       ether(.40),
//       ether(1.55),
//       ether(0.32),
//       ether(10.08),
//       ether(.2),
//       ether(.13),
//       ether(2.31),
//       ether(20.55),
//     ];
//     await tokens.deployTokensAndOracles(
//       tokenTickers,
//       tokenPrices
//     );

//     await tokens.unlimitedApproveTokens(owner, setup.controller.address);

//     const setPrice = ether(1);
//     const tokenAllocations = [
//       ether(.2776),
//       ether(.1941),
//       ether(.1027),
//       ether(.0926),
//       ether(.0836),
//       ether(.0671),
//       ether(.0562),
//       ether(.0442),
//       ether(.0342),
//       ether(.0245),
//       ether(.0232),
//     ];
//     const initialSetUnits = determineInitialSetUnits(setPrice, tokenPrices, tokenAllocations);
//     dfpSet = await setup.createSetToken(
//       tokens.getTokenAddresses(),
//       initialSetUnits,
//       [setup.issuanceModule.address, setup.streamingFeeModule.address],
//       manager.address,
//       "DFP Index Set",
//       "DFPI"
//     );

//     await setup.issuanceModule.connect(manager.wallet).initialize(dfpSet.address, ADDRESS_ZERO);
//     streamingfeeSettings = {
//       feeRecipient: manager.address,
//       maxStreamingFeePercentage: ether(.1),
//       streamingFeePercentage: ether(.02),
//       lastStreamingFeeTimestamp: ZERO,
//     } as StreamingFeeState;
//     await setup.streamingFeeModule.connect(manager.wallet).initialize(dfpSet.address, streamingfeeSettings);

//     protocolFee = ether(.15);
//     await setup.controller.addFee(setup.streamingFeeModule.address, ZERO, protocolFee);
//   });

//   addSnapshotBeforeRestoreAfterEach();

//   describe("#issuance", async () => {
//     let subjectSetToken: Address;
//     let subjectIssueQuantity: BigNumber;
//     let subjectTo: Address;

//     beforeEach(async () => {
//       subjectSetToken = dfpSet.address;
//       subjectIssueQuantity = ether(100);
//       subjectTo = owner.address;
//     });

//     async function subject(): Promise<ContractTransaction> {
//       return setup.issuanceModule.connect(owner.wallet).issue(subjectSetToken, subjectIssueQuantity, subjectTo);
//     }

//     it("should issue the Set", async () => {
//       await subject();
//       const issuedBalance = await dfpSet.balanceOf(owner.address);
//       expect(issuedBalance).to.eq(subjectIssueQuantity);
//     });

//     it("should have deposited the components into the SetToken", async () => {
//       await subject();
//       const depositedBalances = await Promise.all(
//         _.map(tokens.tokens, async (token: string) => { return await tokens[token].balanceOf(dfpSet.address); })
//       );

//       const positions = await dfpSet.getPositions();
//       const expectedBalances = _.map(positions, (position: Position) => { return preciseMul(position.unit, subjectIssueQuantity); });

//       expect(JSON.stringify(depositedBalances)).to.eq(JSON.stringify(expectedBalances));
//     });

//     it("should have transferred the components from the caller", async () => {
//       const previousBalances: BigNumber[] = await Promise.all(
//         _.map(tokens.tokens, async (token: string) => { return await tokens[token].balanceOf(owner.address); })
//       );

//       await subject();

//       const postBalances = await Promise.all(
//         _.map(tokens.tokens, async (token: string) => { return await tokens[token].balanceOf(owner.address); })
//       );

//       const positions = await dfpSet.getPositions();
//       const expectedBalances = _.map(positions, (position: Position, index: number) => {
//         return previousBalances[index].sub(preciseMul(position.unit, subjectIssueQuantity));
//       });

//       expect(JSON.stringify(postBalances)).to.eq(JSON.stringify(expectedBalances));
//     });
//   });

//   describe("#redemption", async () => {
//     let subjectSetToken: Address;
//     let subjectRedeemQuantity: BigNumber;
//     let subjectTo: Address;

//     beforeEach(async () => {
//       subjectSetToken = dfpSet.address;
//       subjectRedeemQuantity = ether(50);
//       subjectTo = owner.address;

//       await setup.issuanceModule.connect(owner.wallet).issue(subjectSetToken, subjectRedeemQuantity, subjectTo);
//     });

//     async function subject(): Promise<ContractTransaction> {
//       return setup.issuanceModule.connect(owner.wallet).redeem(subjectSetToken, subjectRedeemQuantity, subjectTo);
//     }

//     it("should redeem the Set", async () => {
//       await subject();
//       const issuedBalance = await dfpSet.balanceOf(owner.address);
//       expect(issuedBalance).to.eq(ZERO);
//     });

//     it("should have removed the components from the SetToken", async () => {
//       await subject();
//       const setTokenBalances = await Promise.all(
//         _.map(tokens.tokens, async (token: string) => { return await tokens[token].balanceOf(dfpSet.address); })
//       );

//       const positions = await dfpSet.getPositions();
//       const expectedBalances = _.map(positions, (position: Position) => { return ZERO; });

//       expect(JSON.stringify(setTokenBalances)).to.eq(JSON.stringify(expectedBalances));
//     });

//     it("should have transferred the components to the recipient", async () => {
//       const previousBalances: BigNumber[] = await Promise.all(
//         _.map(tokens.tokens, async (token: string) => { return await tokens[token].balanceOf(subjectTo); })
//       );

//       await subject();

//       const postBalances = await Promise.all(
//         _.map(tokens.tokens, async (token: string) => { return await tokens[token].balanceOf(subjectTo); })
//       );

//       const positions = await dfpSet.getPositions();
//       const expectedBalances = _.map(positions, (position: Position, index: number) => {
//         return previousBalances[index].add(preciseMul(position.unit, subjectRedeemQuantity));
//       });
//       expect(JSON.stringify(postBalances)).to.eq(JSON.stringify(expectedBalances));
//     });
//   });

//   describe("#accrueFees", async () => {
//     let subjectSetToken: Address;
//     let subjectTimeFastForward: BigNumber;

//     beforeEach(async () => {
//       await setup.issuanceModule.connect(owner.wallet).issue(dfpSet.address, ether(100), owner.address);

//       subjectSetToken = dfpSet.address;
//       subjectTimeFastForward = ONE_YEAR_IN_SECONDS;
//     });

//     async function subject(): Promise<ContractTransaction> {
//       await increaseTimeAsync(subjectTimeFastForward);
//       return setup.streamingFeeModule.connect(owner.wallet).accrueFee(subjectSetToken);
//     }

//     it("increases the totalSupply by the correct amount", async () => {
//       const feeState = await setup.streamingFeeModule.feeStates(subjectSetToken);
//       const preTotalSupply = await dfpSet.totalSupply();

//       const txnTimestamp = await getTransactionTimestamp(subject());

//       const expectedFeeInflation = await getStreamingFee(
//         setup.streamingFeeModule,
//         subjectSetToken,
//         feeState.lastStreamingFeeTimestamp,
//         txnTimestamp
//       );

//       const feeInflation = getStreamingFeeInflationAmount(expectedFeeInflation, preTotalSupply);
//       const totalSupply = await dfpSet.totalSupply();

//       expect(totalSupply).to.eq(feeInflation.add(preTotalSupply));
//     });

//     it("mints the correct amount of new Sets to the feeRecipient", async () => {
//       const feeState = await setup.streamingFeeModule.feeStates(subjectSetToken);
//       const totalSupply = await dfpSet.totalSupply();

//       const txnTimestamp = await getTransactionTimestamp(subject());

//       const expectedFeeInflation = await getStreamingFee(
//         setup.streamingFeeModule,
//         subjectSetToken,
//         feeState.lastStreamingFeeTimestamp,
//         txnTimestamp
//       );

//       const feeInflation = getStreamingFeeInflationAmount(expectedFeeInflation, totalSupply);
//       const protocolFeeAmount = preciseMul(feeInflation, protocolFee);
//       const feeRecipientBalance = await dfpSet.balanceOf(feeState.feeRecipient);

//       expect(feeRecipientBalance).to.eq(feeInflation.sub(protocolFeeAmount));
//     });

//     it("mints the correct amount of new Sets to the protocol feeRecipient", async () => {
//       const feeState = await setup.streamingFeeModule.feeStates(subjectSetToken);
//       const totalSupply = await dfpSet.totalSupply();

//       const txnTimestamp = await getTransactionTimestamp(subject());

//       const expectedFeeInflation = await getStreamingFee(
//         setup.streamingFeeModule,
//         subjectSetToken,
//         feeState.lastStreamingFeeTimestamp,
//         txnTimestamp
//       );

//       const feeInflation = getStreamingFeeInflationAmount(expectedFeeInflation, totalSupply);

//       const feeRecipientBalance = await dfpSet.balanceOf(setup.feeRecipient);
//       expect(feeRecipientBalance).to.eq(preciseMul(feeInflation, protocolFee));
//     });

//     it("update position units correctly", async () => {
//       const feeState = await setup.streamingFeeModule.feeStates(subjectSetToken);
//       const oldPositions = await dfpSet.getPositions();
//       const oldPositionUnits = _.map(oldPositions, (position: Position) => { return position.unit; });
//       const txnTimestamp = await getTransactionTimestamp(subject());

//       const expectedFeeInflation = await getStreamingFee(
//         setup.streamingFeeModule,
//         subjectSetToken,
//         feeState.lastStreamingFeeTimestamp,
//         txnTimestamp
//       );

//       const expectedNewUnits = getPostFeePositionUnits(oldPositionUnits, expectedFeeInflation);
//       const newPositions = await dfpSet.getPositions();
//       const newPositionUnits = _.map(newPositions, (position: Position) => { return position.unit; });

//       expect(JSON.stringify(newPositionUnits)).to.eq(JSON.stringify(expectedNewUnits));
//     });
//   });
// });


