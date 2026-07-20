// ABOUTME: Server-side fee verifier for redeemAndShield (yield withdraw). Confirms the contract-side
// ABOUTME: fee note is shielded to the relayer at the advertised amount before the relayer pays gas.

/**
 * Redeem Fee Verifier
 *
 * `redeemAndShield` (issue #312) does NOT pay the relayer via a broadcaster output inside the SNARK
 * proof — that's `broadcaster-fee-verifier.ts`'s job for `lendAndShield` / `atomicCrossChainUnshield`.
 * Instead the adapter shields `_feeAmount` USDC out of the redeemed proceeds to the relayer's own 0zk
 * note (`_feeNpk` / `_feeShieldCiphertext`), with all three bound into the proof's `adaptParams`.
 *
 * The proof binding stops a *submitter* from altering the fee after proof-gen, but it does NOT prove
 * the fee is directed at US: a malicious submitter can build a valid proof whose fee note is their
 * OWN address, and the relayer would pay gas for a fee it never receives. So the relayer must
 * independently confirm the fee note is addressed to itself.
 *
 * How:
 *   A shield note's public key is a deterministic commitment `npk = Poseidon(masterPublicKey, random)`
 *   (`ShieldNote.getNotePublicKey`). The masterPublicKey is public (it's in a 0zk address); the
 *   per-note `random` is the secret blinding factor. The frontend generated this fee note to the
 *   relayer's address and passes the `random` alongside the /relay request (the relayer is the note's
 *   recipient — it would decrypt this same `random` during normal balance sync, so nothing new leaks).
 *   We recompute `Poseidon(ourMasterPublicKey, random)` and require it to equal the on-chain `_feeNpk`.
 *   Forging a `random` to hit a target npk under a *different* master key is preimage-hard, so a match
 *   proves the fee note is ours. We also require `_feeAmount >= advertisedFee`.
 *
 *   Token is not checked here: the adapter shields the fee from the redeemed USDC proceeds, so the fee
 *   note is always USDC by construction (the submitter cannot substitute a worthless token).
 */

import { ethers } from "ethers";
import { RailgunWallet, ShieldNote } from "@railgun-community/engine";
import { RelayError } from "../types";
import { REDEEM_AND_SHIELD_ABI } from "../lib/transact-shape";

/** Interface hoisted to module scope — built once instead of per /relay request. */
const REDEEM_IFACE = new ethers.Interface(REDEEM_AND_SHIELD_ABI);

export interface RedeemFeeVerifierContext {
  /** The relayer's loaded Railgun wallet — supplies the master public key the fee note must match. */
  wallet: RailgunWallet;
}

export interface RedeemFeeVerifyRequest {
  /** ABI-encoded `redeemAndShield(...)` calldata as it would be sent on-chain. */
  data: string;
}

/**
 * Verify that a `redeemAndShield` request shields at least `advertisedFee` USDC to the relayer's own
 * 0zk note. Returns the fee amount on success.
 *
 * @throws RelayError(INVALID_DATA)      calldata won't decode, or `feeShieldRandom` is missing
 * @throws RelayError(FEE_INSUFFICIENT)  fee below advertised, or the fee note is not addressed to us
 */
export function verifyRedeemFee(
  ctx: RedeemFeeVerifierContext,
  request: RedeemFeeVerifyRequest,
  advertisedFee: bigint,
  feeShieldRandom: string | undefined,
): bigint {
  // The random is what lets us reconstruct (and thus verify) the fee note's npk. Without it we can't
  // prove the fee is ours, so refuse rather than submit blind.
  if (typeof feeShieldRandom !== "string" || feeShieldRandom.length === 0) {
    throw new RelayError(
      "INVALID_DATA",
      "redeemAndShield relay requires feeShieldRandom to verify the fee destination.",
    );
  }

  let decoded: ethers.Result;
  try {
    decoded = REDEEM_IFACE.decodeFunctionData("redeemAndShield", request.data);
  } catch (e: any) {
    throw new RelayError(
      "INVALID_DATA",
      `Failed to decode redeemAndShield calldata: ${e?.message ?? e}`,
    );
  }

  // Args: [_transaction, _npk, _shieldCiphertext, _feeNpk, _feeShieldCiphertext, _feeAmount]
  const feeNpk = BigInt(decoded[3]);
  const feeAmount = BigInt(decoded[5]);

  if (feeAmount < advertisedFee) {
    throw new RelayError(
      "FEE_INSUFFICIENT",
      `Redeem fee too low: fee ${feeAmount} USDC raw, advertised ${advertisedFee} USDC raw. ` +
        `Re-fetch the fee quote and re-build the proof with the matching fee.`,
    );
  }

  // Recompute the note public key the fee note WOULD have if it were shielded to us with this random.
  let expectedNpk: bigint;
  try {
    expectedNpk = ShieldNote.getNotePublicKey(ctx.wallet.masterPublicKey, feeShieldRandom);
  } catch (e: any) {
    throw new RelayError(
      "INVALID_DATA",
      `Could not derive expected fee-note key (bad feeShieldRandom?): ${e?.message ?? e}`,
    );
  }

  if (feeNpk !== expectedNpk) {
    // The bound fee note is addressed to someone else — submitting would pay gas for a fee we never
    // receive. Reject.
    throw new RelayError(
      "FEE_INSUFFICIENT",
      "Redeem fee note is not addressed to the relayer — refusing to relay.",
    );
  }

  return feeAmount;
}
