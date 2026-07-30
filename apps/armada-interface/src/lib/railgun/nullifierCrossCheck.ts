// ABOUTME: WI-5 nullifier cross-check — the on-chain safety net that catches a watcher omitting a Nullified event.
// ABOUTME: Merkleroot validation can't see nullifiers (they aren't in the commitment tree), so we query the hub PrivacyPool's nullifiers(...) directly for the wallet's own unspent notes.

import { ethers } from 'ethers'
import { getNetworkConfig } from '@/config/network'
import { loadDeployments } from '@/config/deployments'
import { trackError } from '@/lib/telemetry'
import { aggregate3, type AggregateCall } from '@/lib/multicall3'
import { timeoutProvider, getHubChainDescriptor } from './network'

// PrivacyPoolStorage.sol: mapping(uint256 => mapping(bytes32 => bool)) public nullifiers → this
// auto getter. Set in TransactModule.sol when a note is spent. No SDK read helper exists.
const NULLIFIERS_ABI = ['function nullifiers(uint256,bytes32) view returns (bool)']

/**
 * Normalize a TXO nullifier for the `bytes32` ABI arg. The engine stores it as an UNPREFIXED,
 * zero-padded 32-byte hex string (`ByteUtils.nToHex(nullifier, ByteLength.UINT_256)`), but ethers'
 * `bytes32` encoder requires a `0x`-prefixed BytesLike — passing the raw value throws
 * "invalid BytesLike value". Idempotent: tolerates an already-prefixed or short-trimmed value.
 */
export function toNullifierBytes32(nullifier: string): string {
  const raw = nullifier.startsWith('0x') ? nullifier.slice(2) : nullifier
  return `0x${raw.padStart(64, '0')}`
}

// The Railgun SDK crashes on module-load under jsdom (circomlibjs) — defer to call time, same
// pattern as sync.ts / wallet.ts. One import per session.
async function railgunSdk() {
  return import('@railgun-community/wallet')
}
async function sharedModels() {
  return import('@railgun-community/shared-models')
}

/** An own note the wallet believes is unspent, identified for its on-chain nullifier lookup. */
export interface OwnUnspentNote {
  readonly tree: number
  readonly nullifier: string
}

export interface NullifierCrossCheckResult {
  /** How many own unspent notes were cross-checked. */
  readonly checked: number
  /** True when the chain reports one of them as already spent (watcher omitted its Nullified event). */
  readonly omissionDetected: boolean
}

/**
 * The wallet's own notes it believes are unspent, as `{tree, nullifier}`. Each TXO already carries
 * its computed `nullifier` and `tree`; `spendtxid === false` means locally-unspent. V2 only — our
 * PrivacyPool implements the V2 UTXO tree.
 */
export async function getOwnUnspentNotes(walletId: string): Promise<OwnUnspentNote[]> {
  const [{ walletForID }, { TXIDVersion }] = await Promise.all([railgunSdk(), sharedModels()])
  const wallet = walletForID(walletId)
  const txos = await wallet.TXOs(TXIDVersion.V2_PoseidonMerkle, getHubChainDescriptor())
  return txos
    .filter((txo) => txo.spendtxid === false)
    .map((txo) => ({ tree: txo.tree, nullifier: txo.nullifier }))
}

/**
 * Pure omission detector: given the wallet's own locally-unspent notes and a way to ask the chain
 * (in one batch) which are spent, report whether any note is spent on-chain (→ the watcher omitted
 * its Nullified event, so the displayed balance is stale). The batch checker returns one flag per
 * note in order; a flag that couldn't be read comes back `false` (fail-open — never a false block).
 */
export async function detectOmittedNullifiers(
  notes: readonly OwnUnspentNote[],
  areSpentOnChain: (notes: readonly OwnUnspentNote[]) => Promise<readonly boolean[]>,
): Promise<NullifierCrossCheckResult> {
  if (notes.length === 0) return { checked: 0, omissionDetected: false }
  const spentFlags = await areSpentOnChain(notes)
  return { checked: notes.length, omissionDetected: spentFlags.some((spent) => spent === true) }
}

/** Reader for the hub PrivacyPool nullifiers getter — the contract (for ABI encode/decode) + its provider. */
interface NullifiersReader {
  contract: ethers.Contract
  provider: ethers.JsonRpcProvider
}

/** Build the read-only hub PrivacyPool contract + provider for the nullifiers getter. Null if unconfigured. */
async function buildNullifiersReader(): Promise<NullifiersReader | null> {
  const rpc = getNetworkConfig().hub.rpcUrls[0]
  if (!rpc) return null
  const deployments = await loadDeployments()
  const privacyPool = deployments.hub.contracts.privacyPool
  if (!privacyPool) return null
  // A single Multicall3 `aggregate3` folds every note's `nullifiers(...)` read into ONE eth_call, so
  // there is nothing for JSON-RPC batching to over-batch — the batch-limit that forced `batchMaxCount=1`
  // (e.g. drpc's free plan caps JSON-RPC batches at 3) no longer applies. Default provider batching is fine.
  const provider = timeoutProvider(rpc)
  const contract = new ethers.Contract(privacyPool, NULLIFIERS_ABI, provider)
  return { contract, provider }
}

/**
 * Ask the chain, in one Multicall3 `aggregate3` call, whether each note's `(tree, nullifier)` is
 * spent. Returns one flag per note in order; a sub-call that reverted/returned no data maps to
 * `false` (fail-open — a note we couldn't read is not treated as spent).
 */
async function queryNullifiersSpent(
  reader: NullifiersReader,
  notes: readonly OwnUnspentNote[],
): Promise<boolean[]> {
  const calls: AggregateCall[] = notes.map((n) => ({
    contract: reader.contract,
    functionName: 'nullifiers',
    args: [n.tree, toNullifierBytes32(n.nullifier)],
  }))
  const results = await aggregate3(reader.provider, calls)
  return results.map((r) => (r.success && r.result !== undefined ? r.result[0] === true : false))
}

/**
 * Cross-check the wallet's own unspent notes against the hub PrivacyPool's nullifier set.
 *
 * PRIVACY (P6, testnet decision): querying our own nullifiers directly lets the RPC provider link
 * them to our IP when the notes are later spent on-chain. Accepted for testnet — it matches the
 * exposure the app already has (every RPC read goes to the same provider). The reads are batched via
 * multicall (one eth_call); mixing in decoy nullifiers sampled from the global stream so the provider
 * can't tell which are ours is the remaining mainnet follow-up. See SECURITY.md.
 *
 * FAIL-OPEN: the cross-check is a UX-integrity safeguard, not the double-spend boundary — the chain
 * rejects an actual double-spend regardless. A transient hub-RPC error must not block spending, so
 * on any error we log and report no omission (worst case: the user attempts a spend that reverts,
 * exactly the pre-WI-5 behavior). A malicious watcher can't trigger this path — the check hits the
 * chain RPC, not the watcher.
 */
export async function checkOwnNullifiersOnChain(walletId: string): Promise<NullifierCrossCheckResult> {
  try {
    const notes = await getOwnUnspentNotes(walletId)
    if (notes.length === 0) return { checked: 0, omissionDetected: false }

    const reader = await buildNullifiersReader()
    if (!reader) return { checked: 0, omissionDetected: false }

    return await detectOmittedNullifiers(notes, (batch) => queryNullifiersSpent(reader, batch))
  } catch (err) {
    trackError('railgun.nullifierCrossCheck', err)
    return { checked: 0, omissionDetected: false }
  }
}
