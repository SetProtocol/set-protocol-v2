pragma solidity 0.6.10;
pragma experimental "ABIEncoderV2";

import { IController } from "../../interfaces/IController.sol";
import { ISetToken } from "../../interfaces/ISetToken.sol";
import { ModuleBase } from "../lib/ModuleBase.sol";
import { DelegateRegistry } from "../../../external/contracts/snapshot/DelegateRegistry.sol";


contract SnapshotDelegationModule is ModuleBase {

    event Delegated(bytes32 _id, address _to);

    DelegateRegistry delegateRegistry;

    constructor(
        IController _controller, 
        DelegateRegistry _delegateRegistry
    ) 
        public
        ModuleBase(_controller) 
    {
        delegateRegistry = _delegateRegistry;
    }

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

    function delegate(ISetToken _setToken, bytes32 _id, address _to) external onlyManagerAndValidSet(_setToken) {

        bytes memory data = abi.encodeWithSignature("setDelegate(bytes32,address)", _id, _to);
        _setToken.invoke(address(delegateRegistry), 0, data);

        emit Delegated(_id, _to);
    }
}