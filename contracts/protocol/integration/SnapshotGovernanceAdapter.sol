pragma solidity 0.6.10;
pragma experimental "ABIEncoderV2";

import { DelegateRegistry } from "../../../external/contracts/snapshot/DelegateRegistry.sol";


contract SnapshotGovernanceAdapter {

    /* ============ Constants ============ */
    
    // Signature of the delegate function for Snapshot
    string public constant SET_DELEGATE_SIGNATURE = "setDelegate(bytes32,address)";

    // Signature of the clear delegate function for Snapshot
    string public constant CLEAR_DELEGATE_SIGNATURE = "clearDelegate(bytes32)";

    // Zero bytes32 is used as the id paramet for DelegateRegistry to denote delegating for all spaces
    bytes32 private constant ZERO_BYTES32 = bytes32(0);

    /* ============ State Variables ============ */

    DelegateRegistry public delegateRegistry;

    /* ============ Constructor ============ */

    /**
     * Set state variables
     *
     * @param _delegateRegistry    Address of the Snapshot DelegateRegistry
     */
    constructor(DelegateRegistry _delegateRegistry) public {
        delegateRegistry = _delegateRegistry;
    }

    /* ============ External Getter Functions ============ */

    /**
     * Generates the calldata to deletgate Snapshot votes to another ETH address
     *
     * @param _delegatee            Address of the delegatee
     *
     * @return address              Target contract address
     * @return uint256              Total quantity of ETH (Set to 0)
     * @return bytes                Propose calldata
     */
    function getDelegateCalldata(address _delegatee) external view returns (address, uint256, bytes memory) {
        // setDelegate(bytes32 _id, address _delegatee)
        bytes memory callData = abi.encodeWithSignature(SET_DELEGATE_SIGNATURE, ZERO_BYTES32, _delegatee);

        return (address(delegateRegistry), 0, callData);
    }

    /**
     * Generates the calldata to remove delegate
     *
     * @return address              Target contract address
     * @return uint256              Total quantity of ETH (Set to 0)
     * @return bytes                Propose calldata
     */
     function getRevokeCalldata() external view returns (address, uint256, bytes memory) {
         // clearDelegate(bytes32 _id)
         bytes memory callData = abi.encodeWithSignature(CLEAR_DELEGATE_SIGNATURE, ZERO_BYTES32);

         return (address(delegateRegistry), 0, callData);
     }
}