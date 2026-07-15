// ABOUTME: Test-only ERC20 whose transfer/transferFrom re-enter the PrivacyPool, to exercise the
// ABOUTME: nonReentrant guard on shield / transact / atomicCrossChainUnshield (#369).

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.17;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IPrivacyPool} from "../privacy-pool/interfaces/IPrivacyPool.sol";
import {ShieldRequest, Transaction} from "../railgun/logic/Globals.sol";

/**
 * @title MaliciousReentrantToken
 * @notice A "weird" ERC20 that attempts to re-enter the PrivacyPool from inside its transfer hooks —
 *         the exact vector the #369 reentrancy guard defends against. `target` selects which guarded
 *         entry to re-enter; the guard fires before any validation, so the re-entry args can be empty.
 */
contract MaliciousReentrantToken is ERC20 {
    address public pool;
    uint8 public target; // 0 = off, 1 = shield, 2 = transact, 3 = atomicCrossChainUnshield
    bool private _attacking;

    constructor() ERC20("Malicious", "EVIL") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function setAttack(address _pool, uint8 _target) external {
        pool = _pool;
        target = _target;
    }

    function _reenter() internal {
        if (_attacking || target == 0 || pool == address(0)) return;
        _attacking = true;
        if (target == 1) {
            IPrivacyPool(pool).shield(new ShieldRequest[](0), address(0));
        } else if (target == 2) {
            IPrivacyPool(pool).transact(new Transaction[](0));
        } else if (target == 3) {
            Transaction memory dummy;
            IPrivacyPool(pool).atomicCrossChainUnshield(dummy, 1, address(1), 0, bytes32(0));
        }
        _attacking = false;
    }

    function transfer(address to, uint256 amount) public override returns (bool) {
        _reenter(); // fires during _transferTokenOut (unshield payout)
        return super.transfer(to, amount);
    }

    function transferFrom(address from, address to, uint256 amount) public override returns (bool) {
        _reenter(); // fires during _transferTokenIn (shield deposit)
        return super.transferFrom(from, to, amount);
    }
}
