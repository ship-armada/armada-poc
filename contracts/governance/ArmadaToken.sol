// SPDX-License-Identifier: MIT
pragma solidity ^0.8.17;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @title ArmadaToken — ARM governance token
/// @notice Plain ERC20 with fixed supply. Voting power is tracked by VotingLocker, not by the token itself.
contract ArmadaToken is ERC20 {
    uint256 public constant INITIAL_SUPPLY = 100_000_000 * 1e18; // 100M ARM

    constructor(address initialHolder) ERC20("Armada", "ARM") {
        _mint(initialHolder, INITIAL_SUPPLY);
    }
}
