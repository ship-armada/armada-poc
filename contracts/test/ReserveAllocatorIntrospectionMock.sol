// SPDX-License-Identifier: MIT
// ABOUTME: Tests only the Safe-compatible owner/threshold reads used by reserve deployment checks.
// ABOUTME: Not a multisig implementation; cannot authorize assignments or execute transactions.
pragma solidity ^0.8.17;

contract ReserveAllocatorIntrospectionMock {
    address[] private owners;
    uint256 private threshold;

    constructor(address[] memory _owners, uint256 _threshold) {
        owners = _owners;
        threshold = _threshold;
    }

    function getOwners() external view returns (address[] memory) {
        return owners;
    }

    function getThreshold() external view returns (uint256) {
        return threshold;
    }
}
