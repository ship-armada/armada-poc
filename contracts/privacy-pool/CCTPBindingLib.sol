// SPDX-License-Identifier: MIT
pragma solidity ^0.8.17;

/**
 * @title CCTPBindingLib
 * @notice Binds the cross-chain-unshield CCTP destination tuple into a transaction's adaptParams.
 * @dev In `atomicCrossChainUnshield` the destination `recipient`, `destinationDomain`, and `maxFee` are
 *      plaintext arguments the SNARK proof does NOT otherwise cover. Without binding them, a relayer or
 *      mempool front-runner can resubmit the victim's identical proof with `recipient = attacker` (or a
 *      different domain / inflated fee) — the proof still verifies, the nullifier burns, and the funds
 *      are stolen/redirected (issue #364, generalized in #378).
 *
 *      `boundParams.adaptParams` IS committed by the circuit (via hashBoundParams; it is a SNARK public
 *      input), so committing a hash of these three fields into it makes them proof-bound with NO circuit
 *      / trusted-setup change — the same mechanism `YieldAdaptParams` uses. The prover (frontend) sets
 *      adaptParams = encode(recipient, destinationDomain, maxFee); the contract re-derives it from the
 *      submitted arguments and rejects any mismatch.
 *
 *      `destinationCaller` is intentionally NOT bound here — it is pinned on-chain to
 *      remoteHookRouters[destinationDomain] (issue #64), so it is not caller-supplied.
 */
library CCTPBindingLib {
    /// @dev Versioned domain tag so a future adaptParams format cannot collide with v1 hashes (#378).
    bytes32 private constant DOMAIN_TAG = keccak256("ArmadaCCTPUnshield.v1");

    /**
     * @notice Encode the cross-chain unshield destination binding.
     * @param recipient Final USDC recipient on the destination chain
     * @param destinationDomain CCTP domain of the destination chain
     * @param maxFee Maximum CCTP fee (raw USDC units)
     * @return The keccak256 commitment set as boundParams.adaptParams
     */
    function encode(
        address recipient,
        uint32 destinationDomain,
        uint256 maxFee
    ) internal pure returns (bytes32) {
        return keccak256(abi.encode(DOMAIN_TAG, recipient, destinationDomain, maxFee));
    }

    /**
     * @notice Verify submitted destination arguments match the proof-bound adaptParams.
     * @param adaptParams The boundParams.adaptParams committed by the SNARK proof
     * @param recipient Final USDC recipient argument
     * @param destinationDomain CCTP destination domain argument
     * @param maxFee maxFee argument
     * @return True when the arguments hash to the committed adaptParams
     */
    function verify(
        bytes32 adaptParams,
        address recipient,
        uint32 destinationDomain,
        uint256 maxFee
    ) internal pure returns (bool) {
        return adaptParams == encode(recipient, destinationDomain, maxFee);
    }
}
