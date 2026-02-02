// SPDX-License-Identifier: MIT
pragma solidity ^0.8.17;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/security/ReentrancyGuard.sol";

import "../railgun/logic/Globals.sol";
import "./interfaces/IPrivacyPool.sol";

/**
 * @title PrivacyPoolRelayAdapt
 * @notice RelayAdapt-compatible contract for PrivacyPool
 * @dev Enables cross-contract calls pattern:
 *      1. Unshield tokens to this contract
 *      2. Execute arbitrary calls (e.g., deposit to vault)
 *      3. Shield resulting tokens back to user
 *
 *      Compatible with Railgun SDK's generateCrossContractCallsProof
 */
contract PrivacyPoolRelayAdapt is ReentrancyGuard {
    using SafeERC20 for IERC20;

    // Set to true if contract is executing
    bool private isExecuting = false;

    struct Call {
        address to;
        bytes data;
        uint256 value;
    }

    struct ActionData {
        bytes31 random; // Random value (prevents replay)
        bool requireSuccess; // If tx should require success on all sub calls
        uint256 minGasLimit; // Minimum gas required
        Call[] calls; // Array of calls to execute
    }

    struct TokenTransfer {
        TokenData token;
        address to;
        uint256 value; // 0 to send entire balance
    }

    // Custom errors
    error CallFailed(uint256 callIndex, bytes revertReason);

    // Events
    event CallError(uint256 callIndex, bytes revertReason);

    // External contract addresses
    IPrivacyPool public privacyPool;

    /**
     * @notice Only allows self calls if contract is executing
     */
    modifier onlySelfIfExecuting() {
        require(
            !isExecuting || msg.sender == address(this),
            "RelayAdapt: External call to onlySelf function"
        );
        isExecuting = true;
        _;
        isExecuting = false;
    }

    /**
     * @notice Sets PrivacyPool contract address
     */
    constructor(address _privacyPool) {
        require(_privacyPool != address(0), "RelayAdapt: zero address");
        privacyPool = IPrivacyPool(_privacyPool);
    }

    /**
     * @notice Executes a batch of shields
     * @param _shieldRequests - Tokens to shield
     */
    function shield(ShieldRequest[] calldata _shieldRequests) external onlySelfIfExecuting {
        uint256 numValidTokens = 0;
        uint120[] memory values = new uint120[](_shieldRequests.length);

        for (uint256 i = 0; i < _shieldRequests.length; i += 1) {
            if (_shieldRequests[i].preimage.token.tokenType == TokenType.ERC20) {
                IERC20 token = IERC20(_shieldRequests[i].preimage.token.tokenAddress);

                if (_shieldRequests[i].preimage.value == 0) {
                    // Shield entire balance if value is 0
                    values[i] = uint120(token.balanceOf(address(this)));
                } else {
                    values[i] = _shieldRequests[i].preimage.value;
                }

                // Approve for shield
                token.safeApprove(address(privacyPool), 0);
                token.safeApprove(address(privacyPool), values[i]);

                if (values[i] > 0) {
                    numValidTokens += 1;
                }
            } else {
                revert("RelayAdapt: Only ERC20 supported");
            }
        }

        // Noop if no tokens to shield
        if (numValidTokens == 0) {
            return;
        }

        // Filter out 0 balance shields
        ShieldRequest[] memory filteredShieldRequests = new ShieldRequest[](numValidTokens);
        uint256 filteredIndex = 0;

        for (uint256 i = 0; i < _shieldRequests.length; i += 1) {
            if (values[i] != 0) {
                filteredShieldRequests[filteredIndex] = _shieldRequests[i];
                filteredShieldRequests[filteredIndex].preimage.value = values[i];
                filteredIndex += 1;
            }
        }

        // Shield to PrivacyPool
        privacyPool.shield(filteredShieldRequests);
    }

    /**
     * @notice Sends tokens to particular address
     * @param _transfers - tokens to send
     */
    function transfer(TokenTransfer[] calldata _transfers) external onlySelfIfExecuting {
        for (uint256 i = 0; i < _transfers.length; i += 1) {
            if (
                _transfers[i].token.tokenType == TokenType.ERC20 &&
                _transfers[i].token.tokenAddress == address(0)
            ) {
                // Native token (ETH)
                uint256 amount = _transfers[i].value == 0 ? address(this).balance : _transfers[i].value;
                (bool success, ) = _transfers[i].to.call{ value: amount }("");
                require(success, "RelayAdapt: ETH transfer failed");
            } else if (_transfers[i].token.tokenType == TokenType.ERC20) {
                IERC20 token = IERC20(_transfers[i].token.tokenAddress);
                uint256 amount = _transfers[i].value == 0
                    ? token.balanceOf(address(this))
                    : _transfers[i].value;
                token.safeTransfer(_transfers[i].to, amount);
            } else {
                revert("RelayAdapt: Only ERC20 supported");
            }
        }
    }

    /**
     * @notice Executes multicall batch
     * @param _requireSuccess - Whether transaction should throw on call failure
     * @param _calls - multicall array
     */
    function _multicall(bool _requireSuccess, Call[] calldata _calls) internal {
        for (uint256 i = 0; i < _calls.length; i += 1) {
            Call calldata call = _calls[i];

            bool success = false;
            bytes memory returned;

            // Don't allow calls to PrivacyPool in multicall
            if (call.to != address(privacyPool)) {
                (success, returned) = call.to.call{ value: call.value }(call.data);
            }

            if (success) {
                continue;
            }

            if (_requireSuccess) {
                revert CallFailed(i, returned);
            } else {
                emit CallError(i, returned);
            }
        }
    }

    /**
     * @notice Executes multicall batch (public entry)
     * @param _requireSuccess - Whether transaction should throw on call failure
     * @param _calls - multicall array
     */
    function multicall(
        bool _requireSuccess,
        Call[] calldata _calls
    ) external payable onlySelfIfExecuting {
        _multicall(_requireSuccess, _calls);
    }

    /**
     * @notice Get adapt params value for a given set of transactions and action data
     * @param _transactions - Batch of Railgun transactions to execute
     * @param _actionData - Actions to take in transaction
     */
    function getAdaptParams(
        Transaction[] calldata _transactions,
        ActionData calldata _actionData
    ) public pure returns (bytes32) {
        bytes32[][] memory nullifiers = new bytes32[][](_transactions.length);

        for (uint256 i = 0; i < _transactions.length; i += 1) {
            nullifiers[i] = _transactions[i].nullifiers;
        }

        return keccak256(abi.encode(nullifiers, _transactions.length, _actionData));
    }

    /**
     * @notice Executes a batch of transactions followed by a multicall
     * @param _transactions - Batch of transactions to execute
     * @param _actionData - Actions to take in transaction
     */
    function relay(
        Transaction[] calldata _transactions,
        ActionData calldata _actionData
    ) external payable onlySelfIfExecuting {
        require(gasleft() > _actionData.minGasLimit, "RelayAdapt: Not enough gas supplied");

        // Get expected adapt parameters
        bytes32 expectedAdaptParameters = getAdaptParams(_transactions, _actionData);

        // Verify adapt parameters match
        for (uint256 i = 0; i < _transactions.length; i += 1) {
            require(
                _transactions[i].boundParams.adaptParams == expectedAdaptParameters ||
                    tx.origin == VERIFICATION_BYPASS,
                "RelayAdapt: AdaptID Parameters Mismatch"
            );
        }

        // Execute transactions via PrivacyPool
        privacyPool.transact(_transactions);

        // Execute multicall
        _multicall(_actionData.requireSuccess, _actionData.calls);
    }

    // Allow receiving ETH
    receive() external payable {}
}
