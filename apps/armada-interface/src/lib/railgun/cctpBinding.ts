// ABOUTME: Computes the CCTP cross-chain-unshield destination binding that goes into a proof's
// ABOUTME: boundParams.adaptParams, so a relayer/front-runner cannot redirect the exit (#364/#378).

import { ethers } from 'ethers'

/**
 * Versioned domain tag — MUST match Solidity `CCTPBindingLib.DOMAIN_TAG`
 * (`keccak256("ArmadaCCTPUnshield.v1")`). Namespaces the adaptParams format so a future layout
 * cannot collide with v1 hashes.
 */
export const CCTP_BINDING_DOMAIN_TAG = ethers.keccak256(ethers.toUtf8Bytes('ArmadaCCTPUnshield.v1'))

/**
 * Encode the cross-chain unshield destination binding — the value the prover sets as
 * `boundParams.adaptParams`. The hub `TransactModule` re-derives this from the submitted
 * `atomicCrossChainUnshield` arguments and rejects any mismatch, so the destination cannot be
 * altered after proof generation.
 *
 * MUST stay byte-identical to Solidity `CCTPBindingLib.encode`:
 *   keccak256(abi.encode(DOMAIN_TAG, recipient, destinationDomain, maxFee))
 *
 * @param recipient Final USDC recipient on the destination chain (EVM address)
 * @param destinationDomain CCTP domain of the destination chain
 * @param maxFee Maximum CCTP fee, raw USDC units
 */
export function encodeCctpBinding(
  recipient: string,
  destinationDomain: number,
  maxFee: bigint,
): `0x${string}` {
  return ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      ['bytes32', 'address', 'uint32', 'uint256'],
      [CCTP_BINDING_DOMAIN_TAG, recipient, destinationDomain, maxFee],
    ),
  ) as `0x${string}`
}
