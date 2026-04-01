// ABOUTME: External library for string conversion utilities used by ArmadaGovernor.
// ABOUTME: Deployed separately to reduce governor bytecode size; called via DELEGATECALL.

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.17;

/// @title GovernorStringLib — String conversion utilities for governance descriptions
/// @notice External library deployed at its own address. The governor links to it at
///         compile time and calls these functions via DELEGATECALL, keeping the governor's
///         deployed bytecode under the EVM size limit.
library GovernorStringLib {

    /// @notice Convert uint to decimal string (e.g. 42 → "42").
    /// @param value The unsigned integer to convert
    /// @return The decimal string representation
    function uint2str(uint256 value) external pure returns (string memory) {
        if (value == 0) return "0";
        uint256 temp = value;
        uint256 digits;
        while (temp != 0) { digits++; temp /= 10; }
        bytes memory buffer = new bytes(digits);
        while (value != 0) {
            digits--;
            buffer[digits] = bytes1(uint8(48 + value % 10));
            value /= 10;
        }
        return string(buffer);
    }

    /// @notice Convert bytes32 to 0x-prefixed hex string (e.g. 0xabcd...0000).
    /// @param value The bytes32 value to convert
    /// @return The hex string representation
    function bytes32ToHex(bytes32 value) external pure returns (string memory) {
        bytes memory hexChars = "0123456789abcdef";
        bytes memory str = new bytes(66); // "0x" + 64 hex chars
        str[0] = "0";
        str[1] = "x";
        for (uint256 i = 0; i < 32; i++) {
            str[2 + i * 2] = hexChars[uint8(value[i] >> 4)];
            str[3 + i * 2] = hexChars[uint8(value[i] & 0x0f)];
        }
        return string(str);
    }
}
