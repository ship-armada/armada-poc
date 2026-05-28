/**
 * Broadcaster Fee Verifier
 *
 * Server-side check that the broadcaster-fee output baked into an incoming SNARK proof actually
 * pays the relayer at the rate it advertised. Without this, a malicious client could submit a
 * well-formed proof with a $0 (or arbitrary-recipient) broadcaster output and the relayer would
 * eat the gas — defeating the whole relayer-mediation model.
 *
 * How it works:
 *   1. The relayer maintains its own Railgun (`0zk`) wallet (`railgun-wallet.ts`) whose viewing
 *      key is the only key that can decrypt outputs sent to that address.
 *   2. The frontend builds a proof with `broadcasterFeeRecipient: { tokenAddress, amount,
 *      recipientAddress: relayer0zkAddress }`. The SDK encrypts one of the proof's commitment
 *      ciphertexts to that recipient.
 *   3. On `/relay`, we hand the request's calldata to the wallet's
 *      `extractFirstNoteERC20AmountMap(...)` helper. The SDK decodes the calldata, attempts
 *      decryption of each commitment ciphertext with our viewing key, and returns a map of
 *      `{tokenAddress -> amount}` containing only successfully-decrypted outputs.
 *   4. We look up the USDC entry. If missing OR its amount < advertised, we reject with
 *      `FEE_INSUFFICIENT`.
 *
 * Scope (Phase A2):
 *   - Vanilla `transact(Transaction[])` calls only. The SDK's calldata decoder is hard-coded to
 *     the `transact` / `relay` function names, so wrapper functions (atomicCrossChainUnshield,
 *     lendAndShield, redeemAndShield) need their own extraction path. Those land alongside the
 *     handler PRs that need them (A4 for yield, A5 for xchain). The caller (privacy-relay) is
 *     responsible for routing only `transact` calls here; other selectors are rejected at the
 *     `INVALID_DATA` gate.
 *   - Phase A2 single-token (USDC). The map check is keyed by USDC token hash; any output to
 *     another token is ignored (treated as "no broadcaster fee paid for USDC").
 */

import { ContractTransaction } from "ethers";
import { RailgunWallet } from "@railgun-community/engine";
import { ChainType, TXIDVersion } from "@railgun-community/shared-models";
import { RelayError } from "../types";

export interface VerifierContext {
  /** The relayer's loaded Railgun wallet — supplies the viewing key used for decryption. */
  wallet: RailgunWallet;
  /** PrivacyPool contract address on the hub chain. SDK uses this to ABI-decode the calldata. */
  privacyPoolAddress: string;
  /** Hub chain ID — wrapped into the `Chain` shape the SDK helper expects. */
  hubChainId: number;
  /** USDC token address on the hub chain. The verifier matches the broadcaster output's token
   *  against the Railgun-derived hash of this address; payments in any other token are ignored. */
  usdcAddress: string;
}

export interface BroadcasterFeeVerifyRequest {
  /** Target contract — must be the PrivacyPool for the SDK decoder to accept it. */
  to: string;
  /** ABI-encoded `transact(Transaction[])` calldata as it would be sent on-chain. */
  data: string;
}

/**
 * Verify that the incoming relay request pays at least `advertisedFee` USDC to the relayer's
 * broadcaster address. Throws `RelayError("FEE_INSUFFICIENT", ...)` on any failure mode:
 *   - calldata isn't a vanilla `transact(...)` call
 *   - no commitment in the proof decrypts to our viewing key
 *   - the decrypted commitment is for a token other than USDC
 *   - the USDC amount is less than advertised
 *
 * Returns the actual amount detected on success (the caller may log it; useful in tests).
 */
export async function verifyBroadcasterFee(
  ctx: VerifierContext,
  request: BroadcasterFeeVerifyRequest,
  advertisedFee: bigint,
): Promise<bigint> {
  // The SDK helper signature wants an ethers `ContractTransaction`. Only `to` + `data` are
  // load-bearing for decoding; `value` defaults to 0 (Transaction structs don't carry ETH).
  const transactionRequest: ContractTransaction = {
    to: request.to,
    data: request.data,
  };

  // EVM hub chain — relayer only processes hub-chain submits (privacy-relay's INVALID_CHAIN gate
  // enforces that earlier). Wrap into Railgun's Chain shape for the SDK call.
  const chain = { type: ChainType.EVM, id: ctx.hubChainId };

  let amountMap: Record<string, bigint>;
  try {
    // V2 (Poseidon Merkle) — the only TXID version Armada's PrivacyPool supports. SDK helper
    // returns a map of `tokenAddress -> amount` for every commitment in the proof that
    // successfully decrypts under our viewing key. Outputs to other recipients (the user's
    // change, the unshield-target, etc.) DON'T decrypt and don't appear.
    //
    // `useRelayAdapt: false` — vanilla `transact(...)`, decoded with the RailgunSmartWallet ABI.
    // Wrapper functions need useRelayAdapt routing extensions; out of scope for A2 (see header).
    amountMap = await ctx.wallet.extractFirstNoteERC20AmountMap(
      TXIDVersion.V2_PoseidonMerkle,
      chain,
      transactionRequest,
      false, // useRelayAdapt
      ctx.privacyPoolAddress,
    );
  } catch (e: any) {
    // SDK throws on:
    //   - `to` mismatch with contractAddress  (caller bug — privacy-relay should have rejected)
    //   - function name mismatch (e.g. somebody fed a wrapper-function calldata in)
    //   - malformed Transaction encoding
    // Any of these → the request didn't pay us a verifiable fee.
    throw new RelayError(
      "FEE_INSUFFICIENT",
      `Broadcaster-fee verification failed: ${e?.message ?? "could not decode proof outputs"}.`,
    );
  }

  // The SDK's extractor returns a map keyed by the lowercased token CONTRACT ADDRESS
  // (40 hex chars + 0x prefix), NOT the Railgun token-hash (32 bytes). See
  // `extractERC20AmountFromTransactNote` in @railgun-community/engine — its return is
  // `ByteUtils.formatToByteLength(tokenAddress, ByteLength.Address, true).toLowerCase()`.
  // Normalise our USDC address to the same shape and look it up directly.
  const usdcKey = ctx.usdcAddress.toLowerCase();
  const normalisedMap: Record<string, bigint> = {};
  for (const [k, v] of Object.entries(amountMap)) {
    normalisedMap[k.toLowerCase()] = v;
  }

  const paidUsdc = normalisedMap[usdcKey] ?? 0n;
  if (paidUsdc < advertisedFee) {
    throw new RelayError(
      "FEE_INSUFFICIENT",
      `Broadcaster fee too low: paid ${paidUsdc} USDC raw, advertised ${advertisedFee} USDC raw. ` +
        `Re-fetch the fee quote and re-build the proof with the matching broadcaster fee.`,
    );
  }

  return paidUsdc;
}
