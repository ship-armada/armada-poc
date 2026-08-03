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
    address public lastIntegrator;
    uint256 public lastTotal;
    uint256 public lastNoteCount;
    uint256 public shieldCallCount;
    uint256[] public noteValues;
    bytes32[] public noteNpks;

    constructor(address _usdc) {
        usdc = _usdc;
    }

    /// @notice Records a shield of one or more notes, pulling the summed value from msg.sender via
    ///         transferFrom (matching the real pool's per-note pull, aggregated). Supports the
    ///         two-note (user note + relayer fee note) gasless-shield shape.
    function shield(ShieldRequest[] calldata requests, address integrator) external {
        delete noteValues;
        delete noteNpks;
        uint256 total;
        for (uint256 i = 0; i < requests.length; i++) {
            ShieldRequest calldata r = requests[i];
            total += r.preimage.value;
            noteValues.push(r.preimage.value);
            noteNpks.push(r.preimage.npk);
        }
        IERC20(usdc).safeTransferFrom(msg.sender, address(this), total);
        lastIntegrator = integrator;
        lastTotal = total;
        lastNoteCount = requests.length;
        shieldCallCount++;
    }
}
