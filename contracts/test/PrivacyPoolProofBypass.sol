// ABOUTME: TEST-ONLY PrivacyPool whose owner can switch SNARK verification off, so tests can transact
// ABOUTME: without real proofs. Never deploy outside tests; production uses PrivacyPool, which has no bypass.
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.17;

import "../privacy-pool/PrivacyPool.sol";

/**
 * @title PrivacyPoolProofBypass
 * @notice Test harness: the real PrivacyPool plus an owner toggle that makes `verify` accept any proof.
 * @dev Replaces the removed testing mode (#633), which lived in production bytecode. The toggle is a
 *      state variable of this derived contract, so it is laid out after PrivacyPoolStorage's reserved
 *      gap, a slot the delegatecall modules never touch. Only test setups deploy this contract; the
 *      deploy scripts deploy PrivacyPool.
 */
contract PrivacyPoolProofBypass is PrivacyPool {
    /// @notice When true, `verify` accepts any proof.
    bool public skipProofVerification;

    /// @notice Turn proof verification off (true) or back on (false). Owner only.
    function setSkipProofVerification(bool skip) external {
        require(msg.sender == owner, "PrivacyPoolProofBypass: Only owner");
        skipProofVerification = skip;
    }

    /// @inheritdoc PrivacyPool
    function verify(Transaction calldata _transaction) public view override returns (bool) {
        if (skipProofVerification) return true;
        return super.verify(_transaction);
    }
}
