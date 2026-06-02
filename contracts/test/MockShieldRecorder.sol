// SPDX-License-Identifier: MIT
pragma solidity ^0.8.17;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {ShieldRequest} from "../railgun/logic/Globals.sol";

/**
 * @title MockShieldRecorder
 * @notice Test-only stub that exposes `shield(ShieldRequest[], address)` matching the real
 *         PrivacyPool selector. Pulls USDC from msg.sender via transferFrom (matching the real
 *         pool's behaviour) and records the call. Used in B1's Hardhat integration test for
 *         GaslessShieldWrapper without needing the full PrivacyPool + Poseidon + verifier
 *         deployment surface.
 * @dev Intentionally does NOT inherit IPrivacyPool — the wrapper encodes by selector, so a
 *      contract with the matching function shape is structurally indistinguishable to the
 *      caller. Avoids implementing dozens of unrelated interface entries just to compile.
 */
contract MockShieldRecorder {
    using SafeERC20 for IERC20;

    address public immutable usdc;
    uint256 public lastValue;
    address public lastIntegrator;
    bytes32 public lastNpk;
    uint256 public shieldCallCount;

    constructor(address _usdc) {
        usdc = _usdc;
    }

    function shield(ShieldRequest[] calldata requests, address integrator) external {
        require(requests.length == 1, "MockShieldRecorder: one request only");
        ShieldRequest calldata r = requests[0];
        IERC20(usdc).safeTransferFrom(msg.sender, address(this), r.preimage.value);
        lastValue = r.preimage.value;
        lastIntegrator = integrator;
        lastNpk = r.preimage.npk;
        shieldCallCount++;
    }
}
