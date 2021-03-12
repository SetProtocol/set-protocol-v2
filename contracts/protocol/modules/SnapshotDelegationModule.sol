pragma solidity 0.6.10;
pragma experimental "ABIEncoderV2";

import { IController } from "../../interfaces/IController.sol";
import { ISetToken } from "../../interfaces/ISetToken.sol";
import { ModuleBase } from "../lib/ModuleBase.sol";


contract SnapshotDelegationModule is ModuleBase {

    event Delegated(address _to);

    constructor(IController _controller) public ModuleBase(_controller) {}

    function initialize(
        ISetToken _setToken
    )
        external
        onlyValidAndPendingSet(_setToken)
        onlySetManager(_setToken, msg.sender)
    {
        _setToken.initializeModule();
    }

    function removeModule() external override {}

    function delegate(ISetToken _setToken, address _to) external onlyManagerAndValidSet(_setToken) {
        emit Delegated(_to);
    }
}