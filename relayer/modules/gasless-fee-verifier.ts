/**
 * Gasless Fee Verifier
 *
 * Validates that a permit-based `gaslessShield` / `gaslessCrossChainShield` request pays the
 * relayer at least the advertised fee. Unlike Phase A's `broadcaster-fee-verifier`, this
 * verifier does NOT decrypt SNARK commitment ciphertexts — the fee on the gasless shield path
 * is paid as a plaintext `transferFrom(user, relayer, fee)` enforced by the wrapper contract
 * itself (`GaslessShieldWrapper.sol::gaslessShield`). So we can read the `fee` argument
 * directly from the calldata.
 *
 * Defense in depth: the call also asserts the wrapper target matches the chain's known wrapper
 * address. The PrivacyRelay's `allowedTargets` set is the primary gate (an unknown target is
 * rejected before this verifier runs), but we cross-check here so a future refactor that
 * accidentally widens the allow-list doesn't silently allow a "wrapper" that emits a fee
 * Transfer to an attacker-controlled address.
 *
 * Two selectors are supported:
 *   - GaslessShieldWrapper.gaslessShield(...)               — hub
 *   - GaslessShieldWrapperClient.gaslessCrossChainShield(...) — client
 *
 * Returns silently on success; throws RelayError on any check failure.
 */

import { ethers } from "ethers";
import { RelayError } from "../types";

// ============ Selectors ============

/**
 * Hub wrapper entry: `gaslessShield(address,uint256,uint256,uint256,uint8,bytes32,bytes32,(((bytes32,(uint8,address,uint256),uint120),(bytes32[3],bytes32))),address)`.
 *
 * Computed via `keccak256(...).slice(0, 10)` against the wrapper's compiled ABI fragment. Pinned
 * here as a constant so a wrapper-signature refactor that changes the selector surfaces as a
 * test failure rather than silent acceptance of the old shape on a wrapper that no longer
 * speaks it.
 */
export const GASLESS_SHIELD_SELECTOR = ethers.id(
  "gaslessShield(address,uint256,uint256,uint256,uint8,bytes32,bytes32,((bytes32,(uint8,address,uint256),uint120),(bytes32[3],bytes32)),address)",
).slice(0, 10);

/**
 * Client wrapper entry: `gaslessCrossChainShield((address,uint256,uint256,uint256,uint8,bytes32,bytes32),(uint256,uint32,bytes32,bytes32[3],bytes32,bytes32,address))`.
 *
 * Same pinning rationale as above.
 */
export const GASLESS_CROSS_CHAIN_SHIELD_SELECTOR = ethers.id(
  "gaslessCrossChainShield((address,uint256,uint256,uint256,uint8,bytes32,bytes32),(uint256,uint32,bytes32,bytes32[3],bytes32,bytes32,address))",
).slice(0, 10);

const GASLESS_SHIELD_ABI = [
  "function gaslessShield(address user, uint256 totalAmount, uint256 fee, uint256 deadline, uint8 v, bytes32 r, bytes32 s, ((bytes32,(uint8,address,uint256),uint120),(bytes32[3],bytes32)) shieldRequest, address integrator)",
];

const GASLESS_CROSS_CHAIN_SHIELD_ABI = [
  "function gaslessCrossChainShield((address user, uint256 totalAmount, uint256 fee, uint256 deadline, uint8 v, bytes32 r, bytes32 s) permitInput, (uint256 maxFee, uint32 minFinalityThreshold, bytes32 npk, bytes32[3] encryptedBundle, bytes32 shieldKey, bytes32 destinationCaller, address integrator) dest)",
];

/** Interfaces hoisted to module scope — built once instead of per /relay request. */
const GASLESS_SHIELD_IFACE = new ethers.Interface(GASLESS_SHIELD_ABI);
const GASLESS_CROSS_CHAIN_SHIELD_IFACE = new ethers.Interface(GASLESS_CROSS_CHAIN_SHIELD_ABI);

// ============ Verifier Context ============

export interface GaslessVerifierContext {
  /**
   * Map of chainId → expected wrapper address for THAT chain. The hub maps to its
   * `GaslessShieldWrapper`; each client maps to its `GaslessShieldWrapperClient`. Lookup is
   * lowercase-normalised.
   */
  wrappersByChain: Map<number, string>;
}

export interface GaslessVerifyRequest {
  chainId: number;
  to: string;
  data: string;
}

// ============ Verification ============

/**
 * Verify a gasless shield request pays at least the advertised fee.
 *
 * @throws RelayError(FEE_INSUFFICIENT) when the fee argument is below `advertisedFee`.
 * @throws RelayError(INVALID_TARGET) when the wrapper address mismatches the configured one.
 * @throws RelayError(INVALID_DATA)   when the calldata doesn't match either supported shape.
 */
export function verifyGaslessFee(
  ctx: GaslessVerifierContext,
  request: GaslessVerifyRequest,
  advertisedFee: bigint,
): void {
  const expectedWrapper = ctx.wrappersByChain.get(request.chainId);
  if (!expectedWrapper) {
    // Caller shouldn't have reached us — privacy-relay's chainId gate runs first — but pin the
    // assertion so a misconfigured boot (chain present in wallet-manager, absent here) fails
    // loudly rather than authorising a free shield.
    throw new RelayError(
      "INVALID_CHAIN",
      `No gasless wrapper configured for chain ${request.chainId}`,
    );
  }
  if (request.to.toLowerCase() !== expectedWrapper.toLowerCase()) {
    throw new RelayError(
      "INVALID_TARGET",
      `Gasless target ${request.to} does not match configured wrapper ${expectedWrapper} on chain ${request.chainId}`,
    );
  }

  const selector = request.data.slice(0, 10);
  let fee: bigint;
  if (selector === GASLESS_SHIELD_SELECTOR) {
    let decoded: ethers.Result;
    try {
      decoded = GASLESS_SHIELD_IFACE.decodeFunctionData("gaslessShield", request.data);
    } catch (e: any) {
      throw new RelayError(
        "INVALID_DATA",
        `Failed to decode gaslessShield calldata: ${e.message ?? e}`,
      );
    }
    // Args: [user, totalAmount, fee, deadline, v, r, s, shieldRequest, integrator]
    fee = BigInt(decoded[2]);
  } else if (selector === GASLESS_CROSS_CHAIN_SHIELD_SELECTOR) {
    let decoded: ethers.Result;
    try {
      decoded = GASLESS_CROSS_CHAIN_SHIELD_IFACE.decodeFunctionData("gaslessCrossChainShield", request.data);
    } catch (e: any) {
      throw new RelayError(
        "INVALID_DATA",
        `Failed to decode gaslessCrossChainShield calldata: ${e.message ?? e}`,
      );
    }
    // Args: [permitInput, dest]. permitInput[2] is `fee`.
    const permitInput = decoded[0];
    fee = BigInt(permitInput[2]);
  } else {
    throw new RelayError(
      "INVALID_DATA",
      `Selector ${selector} is not a supported gasless wrapper entry`,
    );
  }

  if (fee < advertisedFee) {
    throw new RelayError(
      "FEE_INSUFFICIENT",
      `Gasless wrapper fee ${fee} is below advertised fee ${advertisedFee}`,
    );
  }
}
