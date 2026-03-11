// SPDX-License-Identifier: MIT
pragma solidity ^0.8.17;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/math/SafeCast.sol";
import "./IArmadaGovernance.sol";
import "./EmergencyPausable.sol";

/// @title VotingLocker — Lock ARM tokens to gain voting power
/// @notice Holds ARM tokens on behalf of voters with per-user checkpointing.
///         The ArmadaGovernor reads voting power from this contract via getPastLockedBalance().
///         Checkpoint pattern adapted from OpenZeppelin ERC20Votes.
contract VotingLocker is ReentrancyGuard, IVotingLocker, EmergencyPausable {
    using SafeERC20 for IERC20;
    using SafeCast for uint256;

    // ============ Types ============

    struct Checkpoint {
        uint32 fromBlock;
        uint224 lockedAmount;
    }

    // ============ State ============

    IERC20 public immutable armToken;

    /// @notice Per-user checkpoint history
    mapping(address => Checkpoint[]) private _checkpoints;

    /// @notice Total locked checkpoint history
    Checkpoint[] private _totalLockedCheckpoints;

    /// @notice Authorized governor contract that can extend vote locks
    address public governor;

    /// @notice Earliest timestamp at which a user can unlock (set when they vote)
    mapping(address => uint256) public lockUntil;

    // ============ Events ============

    event TokensLocked(address indexed user, uint256 amount, uint256 newLockedBalance);
    event TokensUnlocked(address indexed user, uint256 amount, uint256 newLockedBalance);
    event VoteLockExtended(address indexed user, uint256 until);
    event GovernorSet(address indexed governor);

    // ============ Constructor ============

    constructor(
        address _armToken,
        address _guardian,
        uint256 _maxPauseDuration,
        address _pauseTimelock
    ) EmergencyPausable(_guardian, _maxPauseDuration, _pauseTimelock) {
        armToken = IERC20(_armToken);
    }

    // ============ Admin Functions ============

    /// @notice Set the governor contract address (one-time, deployer-only)
    /// @param _governor Address of the ArmadaGovernor contract
    function setGovernor(address _governor) external {
        require(governor == address(0), "VotingLocker: governor already set");
        require(_governor != address(0), "VotingLocker: zero address");
        // Only the guardian (deployer) can set the governor during setup
        require(msg.sender == guardian, "VotingLocker: not guardian");
        governor = _governor;
        emit GovernorSet(_governor);
    }

    /// @notice Extend a voter's lock until at least the given timestamp.
    /// @dev Called by the governor when a user casts a vote. Only extends, never shortens.
    /// @param voter Address of the voter
    /// @param until Timestamp until which the voter's tokens should remain locked
    function extendLockUntil(address voter, uint256 until) external {
        require(msg.sender == governor, "VotingLocker: not governor");
        if (until > lockUntil[voter]) {
            lockUntil[voter] = until;
            emit VoteLockExtended(voter, until);
        }
    }

    // ============ External Functions ============

    /// @notice Lock ARM tokens to gain voting power
    /// @param amount Amount of ARM to lock
    function lock(uint256 amount) external nonReentrant {
        require(amount > 0, "VotingLocker: zero amount");

        // CEI: update state before external call
        uint256 oldBalance = _getLatestLockedBalance(msg.sender);
        uint256 newBalance = oldBalance + amount;

        _writeCheckpoint(_checkpoints[msg.sender], newBalance);
        _writeCheckpoint(_totalLockedCheckpoints, _getLatestTotalLocked() + amount);

        armToken.safeTransferFrom(msg.sender, address(this), amount);

        emit TokensLocked(msg.sender, amount, newBalance);
    }

    /// @notice Unlock ARM tokens
    /// @param amount Amount of ARM to unlock
    /// @dev Enforces a vote cooldown: if the user voted on any active proposal,
    ///      they cannot unlock until after that proposal's voting period ends.
    function unlock(uint256 amount) external nonReentrant whenNotPaused {
        require(amount > 0, "VotingLocker: zero amount");
        require(
            block.timestamp >= lockUntil[msg.sender],
            "VotingLocker: vote cooldown active"
        );

        uint256 oldBalance = _getLatestLockedBalance(msg.sender);
        require(oldBalance >= amount, "VotingLocker: insufficient locked");

        uint256 newBalance = oldBalance - amount;

        _writeCheckpoint(_checkpoints[msg.sender], newBalance);
        _writeCheckpoint(_totalLockedCheckpoints, _getLatestTotalLocked() - amount);

        armToken.safeTransfer(msg.sender, amount);

        emit TokensUnlocked(msg.sender, amount, newBalance);
    }

    // ============ View Functions ============

    /// @notice Get current locked balance for an account
    function getLockedBalance(address account) external view returns (uint256) {
        return _getLatestLockedBalance(account);
    }

    /// @notice Get locked balance at a past block number (for voting snapshots)
    /// @dev Binary search through checkpoints, same pattern as OZ ERC20Votes
    function getPastLockedBalance(address account, uint256 blockNumber) external view returns (uint256) {
        require(blockNumber < block.number, "VotingLocker: block not yet mined");
        return _checkpointsLookup(_checkpoints[account], blockNumber);
    }

    /// @notice Get total locked tokens across all users
    function totalLocked() external view returns (uint256) {
        return _getLatestTotalLocked();
    }

    /// @notice Get total locked at a past block number
    function getPastTotalLocked(uint256 blockNumber) external view returns (uint256) {
        require(blockNumber < block.number, "VotingLocker: block not yet mined");
        return _checkpointsLookup(_totalLockedCheckpoints, blockNumber);
    }

    /// @notice Get number of checkpoints for an account (useful for debugging)
    function numCheckpoints(address account) external view returns (uint256) {
        return _checkpoints[account].length;
    }

    // ============ Internal ============

    /// @dev Write a new checkpoint. If one already exists for this block, overwrite it.
    function _writeCheckpoint(Checkpoint[] storage ckpts, uint256 newValue) private {
        uint256 len = ckpts.length;
        uint32 currentBlock = block.number.toUint32();

        if (len > 0 && ckpts[len - 1].fromBlock == currentBlock) {
            // Overwrite existing checkpoint for this block
            ckpts[len - 1].lockedAmount = newValue.toUint224();
        } else {
            // Append new checkpoint
            ckpts.push(Checkpoint({
                fromBlock: currentBlock,
                lockedAmount: newValue.toUint224()
            }));
        }
    }

    /// @dev Binary search: find the checkpoint value at or before the given block
    function _checkpointsLookup(Checkpoint[] storage ckpts, uint256 blockNumber) private view returns (uint256) {
        uint256 len = ckpts.length;
        if (len == 0) return 0;

        // Optimization: check most recent checkpoint first
        if (ckpts[len - 1].fromBlock <= blockNumber) {
            return ckpts[len - 1].lockedAmount;
        }
        if (ckpts[0].fromBlock > blockNumber) {
            return 0;
        }

        // Binary search
        uint256 low = 0;
        uint256 high = len - 1;
        while (low < high) {
            uint256 mid = (low + high + 1) / 2;
            if (ckpts[mid].fromBlock <= blockNumber) {
                low = mid;
            } else {
                high = mid - 1;
            }
        }
        return ckpts[low].lockedAmount;
    }

    /// @dev Get the latest locked balance for an account (from most recent checkpoint)
    function _getLatestLockedBalance(address account) private view returns (uint256) {
        uint256 len = _checkpoints[account].length;
        return len == 0 ? 0 : _checkpoints[account][len - 1].lockedAmount;
    }

    /// @dev Get the latest total locked (from most recent checkpoint)
    function _getLatestTotalLocked() private view returns (uint256) {
        uint256 len = _totalLockedCheckpoints.length;
        return len == 0 ? 0 : _totalLockedCheckpoints[len - 1].lockedAmount;
    }
}
