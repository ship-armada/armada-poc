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
 *   - `atomicCrossChainUnshield(Transaction, uint32, address, bytes32, uint256)` on the
 *     PrivacyPool itself — A5 cross-chain unshield wrapper.
 *
 *   `redeemAndShield` is NOT here: its fee is paid contract-side from the redeemed proceeds (issue
 *   #312), not as a broadcaster output inside the proof, so `redeem-fee-verifier.ts` handles it.
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
// Type-only imports from @armada/sdk's root entry (main/types are node10-resolvable). Erased at
// compile time, so importing them costs the stock path nothing — the SDK's runtime values are loaded
// lazily inside `extractFeeArmada`/`deriveBroadcasterIdentity` so the stock path never pulls in the
// prover/poseidon deps. The SDK root re-exports the note-crypto/keyset/token helpers explicitly, so
// node10 consumers like this one can import them (and their types) straight from the package root.
import type { ReceiverNoteKeys, TokenDataGetter, Chain } from "@armada/sdk";

/**
 * The relayer's `0zk` identity in @armada/sdk form — the full identity (address data + viewing
 * private key), which is what `extractFeeOutput` needs to *bind* a decrypted fee note to an on-chain
 * commitment (it recomputes `npk = poseidon(masterPublicKey, random)`, not just trial-decrypts).
 * Derived from the same mnemonic as the stock `wallet`, so both backends verify against the same 0zk.
 */
export type ArmadaBroadcasterIdentity = ReceiverNoteKeys;

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
  /**
   * When present, fee extraction routes through @armada/sdk's native decode API (`decodeTransact` +
   * `extractFeeOutput`) instead of the stock engine's `extractFirstNoteERC20AmountMap`. Set at boot
   * only under `SDK_BACKEND=armada` (see `armada-relayer.ts`). The verifier switches on this field's
   * PRESENCE, not the env flag directly, so tests can exercise either path without env juggling.
   */
  armadaBroadcaster?: ArmadaBroadcasterIdentity;
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

/**
 * Derive the relayer's @armada/sdk broadcaster identity from its BIP39 mnemonic — the same mnemonic
 * `railgun-wallet.ts` derives the stock `0zk` wallet from, at the same default derivation index, so
 * both backends resolve to the identical broadcaster address (keyset parity validated in Phase 0,
 * seed-to-wallet vectors). Kept in this module (not in the wallet setup) so tests build the identity
 * exactly the way the relayer does. The SDK is imported lazily to keep it off the stock boot path.
 */
export async function deriveBroadcasterIdentity(
  mnemonic: string,
): Promise<ArmadaBroadcasterIdentity> {
  const { deriveKeysetFromMnemonic } = await import("@armada/sdk");
  const ks = await deriveKeysetFromMnemonic(mnemonic);
  return {
    addressData: {
      masterPublicKey: ks.masterPublicKey,
      viewingPublicKey: ks.viewingPublicKey,
    },
    viewingPrivateKey: ks.viewingPrivateKey,
  };
}

/**
 * Armada-backend fee extraction — the SDK's native decode API, replacing the stock engine helper.
 * `decodeTransact` ABI-decodes the (already wrapper-normalised) `transact(Transaction[])` calldata;
 * for each bundled transaction `extractFeeOutput` trial-decrypts the commitment ciphertexts with the
 * broadcaster's full identity and BINDS each decrypted note to an actual on-chain commitment before
 * trusting its claimed value. Returns the stock helper's `{ tokenAddress -> amount }` shape so the
 * caller's USDC lookup + threshold check stay backend-agnostic.
 *
 * Only USDC is resolvable (mirrors the stock wallet's DB-backed token getter): the getter throws for
 * any other token hash, `tryDecryptCommitment` swallows that as "not ours", and a fee note in a
 * non-USDC token simply never contributes to the map — the same outcome as the stock path ignoring
 * non-USDC outputs.
 */
async function extractFeeArmada(
  calldata: string,
  broadcaster: ArmadaBroadcasterIdentity,
  usdcAddress: string,
  hubChainId: number,
): Promise<Record<string, bigint>> {
  const {
    decodeTransact,
    extractFeeOutput,
    getTokenDataERC20,
    getTokenDataHash,
    initPoseidonPromise,
    ChainType: SdkChainType,
  } = await import("@armada/sdk");
  // extractFeeOutput recomputes npk = poseidon(masterPublicKey, random) for its binding check.
  await initPoseidonPromise;

  const usdcTokenData = getTokenDataERC20(usdcAddress);
  const usdcHash = getTokenDataHash(usdcTokenData);
  const strip0x = (h: string): string => (h.startsWith("0x") ? h.slice(2) : h);
  const tokenDataGetter: TokenDataGetter = {
    getTokenDataFromHash: async (_txidVersion, _chain, tokenHash) => {
      if (strip0x(tokenHash) === strip0x(usdcHash)) return usdcTokenData;
      throw new Error(
        `broadcaster-fee-verifier: unresolvable token hash ${tokenHash} (only USDC is resolvable)`,
      );
    },
  };
  const chain: Chain = { type: SdkChainType.EVM, id: hubChainId };

  const amountMap: Record<string, bigint> = {};
  for (const tx of decodeTransact(calldata as `0x${string}`)) {
    const fee = await extractFeeOutput(tx, broadcaster, tokenDataGetter, chain);
    if (fee) {
      const key = fee.tokenAddress.toLowerCase();
      amountMap[key] = (amountMap[key] ?? 0n) + fee.value;
    }
  }
  return amountMap;
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
    if (ctx.armadaBroadcaster) {
      // Armada backend (SDK_BACKEND=armada) — decode + fee extraction via @armada/sdk's native
      // decode API. Same `{ tokenAddress -> amount }` contract as the stock helper below.
      amountMap = await extractFeeArmada(
        normalised.data,
        ctx.armadaBroadcaster,
        ctx.usdcAddress,
        ctx.hubChainId,
      );
    } else {
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
    }
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
