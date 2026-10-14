// SPDX-License-Identifier: MIT
// ABOUTME: Test-only CCTP message handler that accepts every message and does nothing.
// ABOUTME: Stands in for an attacker-chosen recipient of a generic (non-burn) CCTP message.
pragma solidity ^0.8.17;

import "../cctp/ICCTPV2.sol";

contract MockMessageHandlerV2 is IMessageHandlerV2 {
    function handleReceiveFinalizedMessage(uint32, bytes32, uint32, bytes calldata) external pure override returns (bool) {
        return true;
    }

    function handleReceiveUnfinalizedMessage(uint32, bytes32, uint32, bytes calldata) external pure override returns (bool) {
        return true;
    }
}
