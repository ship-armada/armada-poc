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
 * Selector support (extended through Phase A4 + A5):
 *   - `transact(Transaction[])` — vanilla. SDK helper decodes directly.
 *   - `lendAndShield(Transaction, bytes32, ShieldCiphertext)` on ArmadaYieldAdapter — wrapper.
 *   - `redeemAndShield(Transaction, bytes32, ShieldCiphertext)` on ArmadaYieldAdapter — wrapper.
 *   - `atomicCrossChainUnshield(Transaction, uint32, address, bytes32, uint256)` on the
 *     PrivacyPool itself — A5 cross-chain unshield wrapper.
 *
 *   For all wrapper selectors the SDK's decoder doesn't know the function name (it expects
 *   `transact` or `relay`), so we decode the wrapper ourselves, lift the embedded Transaction
 *   struct (always the first argument), and ABI-re-encode it as a synthetic
 *   `transact([transaction])` call against the PrivacyPool address. The broadcaster output
 *   lives inside `Transaction.boundParams.commitmentCiphertext[]` regardless of which outer
 *   contract carried it, so the same decryption pipeline applies. See `lib/transact-shape.ts`
 *   for the ABI fragments and the `normaliseRequestToVanillaTransact` helper.
 *
 *   Single-token check (USDC only) is preserved across all paths — payments in any other
 *   token are ignored.
 */

import { ContractTransaction, ethers } from "ethers";
import { RailgunWallet } from "@railgun-community/engine";
import { ChainType, TXIDVersion } from "@railgun-community/shared-models";
import { RelayError } from "../types";
import {
  TRANSACT_SELECTOR,
  WRAPPER_SELECTORS,
  TRANSACT_ABI,
  WRAPPER_ABIS,
} from "../lib/transact-shape";

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
/**
 * For wrapper-function calldata (lendAndShield / redeemAndShield), ABI-decode the outer call to
 * lift the embedded Transaction struct, then re-encode it as a synthetic
 * `transact([transaction])` call against the PrivacyPool. The SDK's decoder can consume the
 * synthetic shape directly. For vanilla `transact(...)` calls, returns the request unchanged.
 *
 * Throws `RelayError(INVALID_DATA)` on an unknown selector. (privacy-relay's allowlist gate
 * should reject these before they reach us; defensive guard for direct-caller usage like tests.)
 */
function normaliseRequestToVanillaTransact(
  request: BroadcasterFeeVerifyRequest,
  privacyPoolAddress: string,
): BroadcasterFeeVerifyRequest {
  const selector = request.data.slice(0, 10).toLowerCase();
  if (selector === TRANSACT_SELECTOR) {
    return request;
  }
  if (!WRAPPER_SELECTORS.has(selector)) {
    throw new RelayError(
      "INVALID_DATA",
      `Verifier received an unsupported selector: ${selector}.`,
    );
  }
  // Wrapper path — ABI-decode the outer call, lift Transaction from arg 0, re-encode.
  const wrapperIface = new ethers.Interface(WRAPPER_ABIS);
  const decoded = wrapperIface.parseTransaction({ data: request.data });
  if (!decoded) {
    throw new RelayError(
      "FEE_INSUFFICIENT",
      `Could not decode wrapper-function calldata (selector ${selector}).`,
    );
  }
  // Both wrappers carry Transaction at args[0] by convention. ethers v6 returns a `Result`
  // proxy; passing it through encodeFunctionData below works because the encoder reads by
  // structural shape, not by class identity.
  const embeddedTransaction = decoded.args[0];
  const transactIface = new ethers.Interface(TRANSACT_ABI);
  const syntheticData = transactIface.encodeFunctionData("transact", [
    [embeddedTransaction],
  ]);
  return { to: privacyPoolAddress, data: syntheticData };
}

export async function verifyBroadcasterFee(
  ctx: VerifierContext,
  request: BroadcasterFeeVerifyRequest,
  advertisedFee: bigint,
): Promise<bigint> {
  // Normalise wrapper calls (lendAndShield / redeemAndShield) into synthetic vanilla transact
  // calldata before handing to the SDK helper. Vanilla transact requests pass through unchanged.
  const normalised = normaliseRequestToVanillaTransact(request, ctx.privacyPoolAddress);

  // The SDK helper signature wants an ethers `ContractTransaction`. Only `to` + `data` are
  // load-bearing for decoding; `value` defaults to 0 (Transaction structs don't carry ETH).
  const transactionRequest: ContractTransaction = {
    to: normalised.to,
    data: normalised.data,
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
