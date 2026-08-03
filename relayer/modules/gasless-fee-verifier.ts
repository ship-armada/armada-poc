// ABOUTME: Server-side fee verifier for the permissionless gaslessShield / gaslessCrossChainShield.
// ABOUTME: Confirms the shielded fee note is addressed to the relayer's own 0zk at the advertised amount.

/**
 * Gasless Fee Verifier (Phase C — permissionless, shielded fee note)
 *
 * The gasless shield wrappers are permissionless: any relayer may submit, and the fee is paid as a
 * SHIELDED note bound in the user's EIP-712 intent (not public USDC). So this verifier must confirm
 * the fee note is addressed to US before paying gas — the same guarantee `redeem-fee-verifier.ts`
 * provides for `redeemAndShield`, and it reuses the same primitive:
 *
 *   A shield note's public key is `npk = Poseidon(masterPublicKey, random)` (`ShieldNote.getNotePublicKey`).
 *   The frontend built the relayer fee note to our published 0zk and sends the per-note `random`
 *   (`feeShieldRandom`) on the /relay request (we're the note's recipient — we'd decrypt this same
 *   random during normal balance sync, so nothing new leaks). We recompute `Poseidon(ourMasterPublicKey,
 *   random)` and require it to equal the fee note's on-chain npk. A match proves the note is ours.
 *
 * Two selectors are supported:
 *   - GaslessShieldWrapper.gaslessShield(...)                 — hub (fee note is one of shieldRequests[])
 *   - GaslessShieldWrapperClient.gaslessCrossChainShield(...) — client (fee note is the `feeNote` arg)
 *
 * Defense in depth: the wrapper target is still pinned to the chain's known wrapper address.
 *
 * Note on the fee-note net: the wrapper is not shield-fee-exempt, so the pool charges its shield fee
 * on the fee note too — the relayer nets `feeValue - shieldFee(feeValue)`, marginally below the
 * quoted amount. Accepted for now (the shortfall is ~the shield-fee rate on a ~1 USDC fee); an exact
 * gross-up is deferred (see .context/gasless-shield-permissionless-plan.md §4d).
 *
 * Returns silently on success; throws RelayError on any check failure.
 */

import { ethers } from "ethers";
import { RailgunWallet, ShieldNote } from "@railgun-community/engine";
import { RelayError } from "../types";

// ============ Selectors ============

/**
 * Hub wrapper entry:
 * `gaslessShield((address,uint256,uint256,address,uint8,bytes32,bytes32),bytes,((bytes32,(uint8,address,uint256),uint120),(bytes32[3],bytes32))[])`.
 * Pinned so a wrapper-signature refactor surfaces as a test failure rather than silent acceptance.
 */
export const GASLESS_SHIELD_SELECTOR = ethers.id(
  "gaslessShield((address,uint256,uint256,address,uint8,bytes32,bytes32),bytes,((bytes32,(uint8,address,uint256),uint120),(bytes32[3],bytes32))[])",
).slice(0, 10);

/**
 * Client wrapper entry:
 * `gaslessCrossChainShield((address,uint256,uint256,uint256,uint32,uint8,bytes32,bytes32),bytes,(bytes32,uint120,bytes32[3],bytes32,address),(bytes32,uint120,bytes32[3],bytes32,address))`.
 */
export const GASLESS_CROSS_CHAIN_SHIELD_SELECTOR = ethers.id(
  "gaslessCrossChainShield((address,uint256,uint256,uint256,uint32,uint8,bytes32,bytes32),bytes,(bytes32,uint120,bytes32[3],bytes32,address),(bytes32,uint120,bytes32[3],bytes32,address))",
).slice(0, 10);

const GASLESS_SHIELD_ABI = [
  "function gaslessShield((address user,uint256 deadline,uint256 nonce,address integrator,uint8 permitV,bytes32 permitR,bytes32 permitS) params, bytes intentSig, ((bytes32 npk,(uint8 tokenType,address tokenAddress,uint256 tokenSubID) token,uint120 value) preimage,(bytes32[3] encryptedBundle,bytes32 shieldKey) ciphertext)[] shieldRequests)",
];

const GASLESS_CROSS_CHAIN_SHIELD_ABI = [
  "function gaslessCrossChainShield((address user,uint256 deadline,uint256 nonce,uint256 maxFee,uint32 minFinalityThreshold,uint8 permitV,bytes32 permitR,bytes32 permitS) params, bytes intentSig, (bytes32 npk,uint120 value,bytes32[3] encryptedBundle,bytes32 shieldKey,address integrator) userNote, (bytes32 npk,uint120 value,bytes32[3] encryptedBundle,bytes32 shieldKey,address integrator) feeNote)",
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
  /** The relayer's loaded Railgun wallet — supplies the master public key the fee note must match. */
  wallet: RailgunWallet;
}

export interface GaslessVerifyRequest {
  chainId: number;
  to: string;
  data: string;
}

// ============ Verification ============

/**
 * Verify a gasless shield request shields at least `advertisedFee` USDC to the relayer's own 0zk.
 *
 * @throws RelayError(FEE_INSUFFICIENT) when the fee note is below `advertisedFee` or not addressed to us.
 * @throws RelayError(INVALID_TARGET)   when the wrapper address mismatches the configured one.
 * @throws RelayError(INVALID_DATA)     when the calldata doesn't match either supported shape or the
 *                                      feeShieldRandom is missing/invalid.
 */
export function verifyGaslessFee(
  ctx: GaslessVerifierContext,
  request: GaslessVerifyRequest,
  advertisedFee: bigint,
  feeShieldRandom: string | undefined,
): void {
  const expectedWrapper = ctx.wrappersByChain.get(request.chainId);
  if (!expectedWrapper) {
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

  // The random lets us reconstruct (and thus verify) the fee note's npk. Without it we can't prove
  // the fee is ours, so refuse rather than submit blind.
  if (typeof feeShieldRandom !== "string" || feeShieldRandom.length === 0) {
    throw new RelayError(
      "INVALID_DATA",
      "gasless shield relay requires feeShieldRandom to verify the fee destination.",
    );
  }
  let expectedNpk: bigint;
  try {
    expectedNpk = ShieldNote.getNotePublicKey(ctx.wallet.masterPublicKey, feeShieldRandom);
  } catch (e: any) {
    throw new RelayError(
      "INVALID_DATA",
      `Could not derive expected fee-note key (bad feeShieldRandom?): ${e?.message ?? e}`,
    );
  }

  const selector = request.data.slice(0, 10);
  const feeValue = extractFeeNoteValue(selector, request.data, expectedNpk);
  if (feeValue === null) {
    // No note in the call is addressed to us — submitting would pay gas for a fee we never receive.
    throw new RelayError(
      "FEE_INSUFFICIENT",
      "Gasless shield carries no fee note addressed to the relayer — refusing to relay.",
    );
  }
  if (feeValue < advertisedFee) {
    throw new RelayError(
      "FEE_INSUFFICIENT",
      `Gasless fee note ${feeValue} is below advertised fee ${advertisedFee}`,
    );
  }
}

/**
 * Decode the calldata and return the value of the note addressed to `expectedNpk`, or null if none.
 */
function extractFeeNoteValue(selector: string, data: string, expectedNpk: bigint): bigint | null {
  if (selector === GASLESS_SHIELD_SELECTOR) {
    let decoded: ethers.Result;
    try {
      decoded = GASLESS_SHIELD_IFACE.decodeFunctionData("gaslessShield", data);
    } catch (e: any) {
      throw new RelayError("INVALID_DATA", `Failed to decode gaslessShield calldata: ${e?.message ?? e}`);
    }
    // decoded[2] = shieldRequests[]; each element is [preimage, ciphertext],
    // preimage = [npk, token, value]. Find the note whose npk is ours.
    const requests = decoded[2];
    for (const req of requests) {
      const npk = BigInt(req[0][0]);
      if (npk === expectedNpk) return BigInt(req[0][2]);
    }
    return null;
  }
  if (selector === GASLESS_CROSS_CHAIN_SHIELD_SELECTOR) {
    let decoded: ethers.Result;
    try {
      decoded = GASLESS_CROSS_CHAIN_SHIELD_IFACE.decodeFunctionData("gaslessCrossChainShield", data);
    } catch (e: any) {
      throw new RelayError(
        "INVALID_DATA",
        `Failed to decode gaslessCrossChainShield calldata: ${e?.message ?? e}`,
      );
    }
    // decoded[3] = feeNote = [npk, value, encryptedBundle, shieldKey, integrator].
    const feeNote = decoded[3];
    if (BigInt(feeNote[0]) === expectedNpk) return BigInt(feeNote[1]);
    return null;
  }
  throw new RelayError("INVALID_DATA", `Selector ${selector} is not a supported gasless wrapper entry`);
}
