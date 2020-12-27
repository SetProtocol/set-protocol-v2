/*
    Copyright 2020 Set Labs Inc.

    Licensed under the Apache License, Version 2.0 (the "License");
    you may not use this file except in compliance with the License.
    You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

    Unless required by applicable law or agreed to in writing, software
    distributed under the License is distributed on an "AS IS" BASIS,
    WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
    See the License for the specific language governing permissions and
    limitations under the License.

    SPDX-License-Identifier: Apache License, Version 2.0
*/

pragma solidity 0.6.10;
pragma experimental "ABIEncoderV2";


/**
 * @title MakerPollingGovernanceAdapter
 * @author Set Protocol
 *
 * Governance adapter for Maker community polling that returns data for voting
 */
contract MakerPollingGovernanceAdapter {

    /* ============ State Variables ============ */

    // Address of MKR proto governance contract
    address public immutable makerPollingEmitter;

    // Address of MKR token
    address public immutable mkrToken;

    /* ============ Constructor ============ */

    /**
     * Set state variables
     *
     * @param _makerPollingEmitter   Address of MKR proto governance contract
     * @param _mkrToken              Address of MKR token
     */
    constructor(address _makerPollingEmitter, address _mkrToken) public {
        makerPollingEmitter = _makerPollingEmitter;
        mkrToken = _mkrToken;
    }

    /* ============ External Getter Functions ============ */

    /**
     * Generates the calldata to vote on a proposal. If byte data is empty, then vote using MKR token, otherwise, vote using the asset passed
     * into the function
     *
     * @param _proposalId           ID of the proposal to vote on
     * @param _data                 Byte data containing the asset to vote with
     *
     * @return address              Target contract address
     * @return uint256              Total quantity of ETH (Set to 0)
     * @return bytes                Propose calldata
     */
    function getVoteCalldata(uint256 _proposalId, bool /* _support */, bytes memory _data) external view returns (address, uint256, bytes memory) {
        uint256 optionId = abi.decode(_data, (uint256));

        // vote(uint256 pollId, uint256 optionId)
        bytes memory callData = abi.encodeWithSignature("vote(uint256,uint256)", _proposalId, optionId);

        return (makerPollingEmitter, 0, callData);
    }

    /**
     * Reverts as MKR currently does not have a delegation mechanism in governance
     */
    function getDelegateCalldata(address /* _delegatee */) external view returns (address, uint256, bytes memory) {
        revert("No delegation available in MKR community polling");
    }

    /**
     * Reverts as MKR currently does not have a register mechanism in governance
     */
    function getRegisterCalldata(address /* _setToken */) external view returns (address, uint256, bytes memory) {
        revert("No register available in MKR community polling");
    }

    /**
     * Reverts as MKR currently does not have a revoke mechanism in governance
     */
    function getRevokeCalldata() external view returns (address, uint256, bytes memory) {
        revert("No revoke available in MKR community polling");
    }

    /**
     * Reverts as creating a proposal is only available to MKR genesis team
     */
    function getProposeCalldata(bytes memory /* _proposalData */) external view returns (address, uint256, bytes memory) {
        revert("Creation of new proposal only available to MKR genesis team");
    }

}
