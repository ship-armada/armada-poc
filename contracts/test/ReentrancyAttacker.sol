// SPDX-License-Identifier: MIT
pragma solidity ^0.8.17;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

interface ICrowdfundClaim {
    function claim() external;
    function claimRefund() external;
}

interface IVotingLockerAttack {
    function lock(uint256 amount) external;
    function unlock(uint256 amount) external;
}

/// @title ReentrancyAttacker — Test contract that attempts reentrancy on claim/refund
/// @dev Used in adversarial tests. Deploys a malicious ERC20 that calls back into
///      the target contract during transfer. Since ArmadaCrowdfund uses SafeERC20
///      with standard ERC20 tokens, reentrancy via token transfer hooks is the attack vector.
///      This contract instead tries to re-enter from a receive() callback or directly.

/// @notice Attacker that tries to re-enter ArmadaCrowdfund.claim()
contract CrowdfundClaimAttacker {
    ICrowdfundClaim public target;
    uint256 public attackCount;

    constructor(address _target) {
        target = ICrowdfundClaim(_target);
    }

    function attack() external {
        target.claim();
    }

    // This would only be called if the crowdfund sent ETH, which it doesn't.
    // For ERC20 reentrancy, the token itself would need a callback hook (like ERC777).
    // Standard ERC20 (which our MockUSDCV2 and ArmadaToken are) don't have transfer hooks.
    // This test verifies the ReentrancyGuard works if such hooks existed.
    receive() external payable {
        if (attackCount < 1) {
            attackCount++;
            target.claim();
        }
    }
}

/// @notice Attacker that tries to re-enter ArmadaCrowdfund.claimRefund()
contract CrowdfundRefundAttacker {
    ICrowdfundClaim public target;
    uint256 public attackCount;

    constructor(address _target) {
        target = ICrowdfundClaim(_target);
    }

    function attack() external {
        target.claimRefund();
    }

    receive() external payable {
        if (attackCount < 1) {
            attackCount++;
            target.claimRefund();
        }
    }
}

/// @notice Attacker that tries to re-enter VotingLocker.unlock() during unlock
contract VotingLockerAttacker {
    IVotingLockerAttack public target;
    IERC20 public armToken;
    uint256 public attackCount;

    constructor(address _target, address _armToken) {
        target = IVotingLockerAttack(_target);
        armToken = IERC20(_armToken);
    }

    function lockTokens(uint256 amount) external {
        armToken.approve(address(target), amount);
        target.lock(amount);
    }

    function attackUnlock(uint256 amount) external {
        target.unlock(amount);
    }

    receive() external payable {
        if (attackCount < 1) {
            attackCount++;
            target.unlock(1);
        }
    }
}
