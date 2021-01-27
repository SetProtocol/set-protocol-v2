pragma solidity 0.6.10;
pragma experimental "ABIEncoderV2";

/**
 * @title AaveV2GovernanceAdapter
 * @author Yash Sinha // Set Protocol
 *
 * Governance adapter for Aave V2 governance that returns data for voting
 * TOOD: 
 * -decide how to handle delegateByType() - https://docs.aave.com/developers/v/2.0/protocol-governance/governance#delegation
 * -clean up docs
 * -figure out how to handle register/revoke
 */
contract AaveV2GovernanceAdapter {

    /* ============ Constants ============ */

    // 1 is a vote for in AAVE
    uint256 public constant VOTE_FOR = 1;

    // 2 represents a vote against in AAVE
    uint256 public constant VOTE_AGAINST = 2;

    /* ============ State Variables ============ */

    // Address of Aave proto governance contract
    address public immutable aaveGovernanceV2;

    // Address of Aave token
    address public immutable aaveToken;

    /* ============ Constructor ============ */

    /**
     * Set state variables
     *
     * @param _aaveProtoGovernance    Address of AAVE proto governance contract
     * @param _aaveToken              Address of AAVE token
     */
    constructor(address _aaveGovernanceV2, address _aaveToken) public {
        aaveGovernanceV2 = _aaveGovernanceV2;
        aaveToken = _aaveToken;
    }

    /* ============ External Getter Functions ============ */

    /**
     * Generates the calldata to vote on a proposal. If byte data is empty, then vote using AAVE token, otherwise, vote using the asset passed
     * into the function
     *
     * @param _proposalId           ID of the proposal to vote on
     * @param _support              Boolean indicating whether to support proposal
     * @param _data                 Byte data containing the asset to vote with
     *
     * @return address              Target contract address
     * @return uint256              Total quantity of ETH (Set to 0)
     * @return bytes                Propose calldata
     */
    function getVoteCalldata(uint256 _proposalId, bool _support, bytes memory _data) external view returns (address, uint256, bytes memory) {
        bytes memory callData = abi.encodeWithSignature("submitVote(uint256,bool)", _proposalId, _support);
        return (aaveGovernanceV2, 0, callData);
    }

    /**
     * Reverts as AAVE currently does not have a delegation mechanism in governance
     */
    function getDelegateCalldata(address _delegatee) external view returns (address, uint256, bytes memory) {
        bytes memory callData = abi.encodeWithSignature("delegate(address)", _delegatee);
        return (aaveToken, 0, callData);
    }

    /**
     * Reverts as AAVE currently does not have a register mechanism in governance
     */
    function getRegisterCalldata(address /* _setToken */) external view returns (address, uint256, bytes memory) {
        revert("No register available in AAVE governance");
    }

    /**
     * Reverts as AAVE currently does not have a revoke mechanism in governance
     */
    function getRevokeCalldata() external view returns (address, uint256, bytes memory) {
        revert("No revoke available in AAVE governance");
    }

    /**
     * Generates the calldata to create a proposal for a specific executor. A proposal includes a list of underlying transactions.
     * 
     * @param executor              Address of the time-locked executor           
     * @param targets               List of the targeted addresses by proposal transactions
     * @param values                List of the Ether values of proposal transactions
     * @param signatures            list of function signatures (can be empty) to be used when creating the callDatas of proposal transactions
     * @param calldatas             list of callDatas: if associated signature empty, encoded callData, else arguments for the function signature
     * @param withDelegatecalls     List of bool determining if the proposal transactions should execute the transaction via direct or delegate call
     * @param ipfsHash              ipfsHash of the associated AIP
     *
     * @return address              Target contract address
     * @return uint256              Total quantity of ETH (Set to 0)
     * @return bytes                Propose calldata
     */
    function getProposeCalldata(bytes memory _proposalData) external view returns (address, uint256, bytes memory) {
        // Decode proposal data
        (
            address executor,
            address[] memory targets,
            uint256[] memory values,
            string[] memory signatures,
            bytes[] memory calldatas,
            bool[] memory withDelegatecalls,
            bytes32 ipfsHash
        ) = abi.decode(_proposalData, (address, address[], uint256[], string[], bytes[], bool[], bytes32));

        //function create(address executor, address[] memory targets, uint256[] memory values, string[] memory signatures, bytes[] memory calldatas, bool[] memory withDelegatecalls, bytes32 ipfsHash)
        bytes memory callData = abi.encodeWithSignature("create(address, address[], uint256[], string[], bytes[], bool[], bytes32)", executor, targets, values, signatures, calldatas, withDelegatecalls, ipfsHash);
    }
}