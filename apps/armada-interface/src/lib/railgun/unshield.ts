// ABOUTME: Engine-side helper for CROSS-CHAIN unshield — buildXchainUnshieldTransaction (generateProofTransactions
// ABOUTME: + relayAdaptID for the CCTP binding). Same-chain unshield-local runs entirely on @armada/sdk (unshield-sdk.ts).

import { ethers } from 'ethers'
import { loadHubNetwork } from './network'
import { encodeCctpBinding } from './cctpBinding'
import { yieldToPaint } from '@/lib/paint'

type RailgunSdk = typeof import('@railgun-community/wallet')
type SharedModels = typeof import('@railgun-community/shared-models')

async function railgunSdk(): Promise<RailgunSdk> {
  return import('@railgun-community/wallet')
}
async function sharedModels(): Promise<SharedModels> {
  return import('@railgun-community/shared-models')
}

/**
 * One broadcaster output baked into the SNARK proof so the relayer is paid in the same atomic
 * tx as the unshield. Required when `submitRelay` is the submission path — without it, the
 * relayer's server-side fee verifier rejects with `FEE_INSUFFICIENT`. Pass `null` to fall back
 * to a direct user-submitted tx (kept for the A6 wallet-fallback override).
 */
export interface BroadcasterFeeRecipient {
  /** USDC token address on the hub chain. Same address the unshield's first recipient uses. */
  tokenAddress: string
  /** Fee amount in USDC raw units (6 decimals) — must equal the value the relayer published on
   *  `/fees`; the relayer compares against this exact value at request time. */
  amount: bigint
  /** Relayer's `0zk...` address. Sourced from the `FeeSchedule.broadcasterRailgunAddress` field. */
  recipientAddress: string
}

/**
 * Cross-chain unshield: generate the proof AND return the ready-to-encode Transaction struct in a
 * single call. The proof is generated with the PrivacyPool itself as the unshield recipient (the
 * pool burns the shielded UTXO and emits CCTP messages to deliver USDC to the real recipient on a
 * different chain).
 *
 * The CCTP destination (`finalRecipient`, `destinationDomain`, `maxFee`) is bound into the proof's
 * `boundParams.adaptParams` via `encodeCctpBinding`. The hub `TransactModule` re-derives that hash
 * from the submitted `atomicCrossChainUnshield` arguments and rejects any mismatch, so a relayer or
 * front-runner cannot redirect the exit (#364/#378/#399). `adaptContract` is `ZeroAddress` — this is
 * a plain unshield-to-pool, NOT a relay-adapt cross-contract call, and the contract requires
 * `adaptContract == address(0)`.
 *
 * `broadcasterFee`: A5 — when present, embeds a broadcaster-fee output to the relayer's 0zk address
 * so the relayer-mediated hub burn pays the relayer in the same atomic tx. When null, falls back to
 * a direct user-submitted hub burn (kept for the A6 wallet-override fallback).
 *
 * Uses `generateProofTransactions` (not `generateUnshieldProof`) because only the lower-level API
 * accepts a `relayAdaptID`, and it returns the proved Transaction struct directly — no populate +
 * calldata-decode round-trip. Mirrors the yield.ts pattern.
 */
export async function buildXchainUnshieldTransaction(opts: {
  walletId: string
  encryptionKey: string
  tokenAddress: string
  privacyPoolAddress: string
  amount: bigint
  broadcasterFee: BroadcasterFeeRecipient | null
  finalRecipient: string
  destinationDomain: number
  maxFee: bigint
  hubChainId: number
  onProgress?: (fraction: number) => void
}): Promise<{ transaction: unknown }> {
  await loadHubNetwork()
  const [{ generateProofTransactions }, { TXIDVersion, ProofType, NetworkName }] = await Promise.all([
    railgunSdk(),
    sharedModels(),
  ])

  const adaptParams = encodeCctpBinding(opts.finalRecipient, opts.destinationDomain, opts.maxFee)

  const sendWithPublicWallet = opts.broadcasterFee === null
  // Yield one frame so the caller's "Generating proof…" state paints before the WASM proof gen
  // blocks the main thread for 20-30s.
  await yieldToPaint()
  const { provedTransactions } = await generateProofTransactions(
    ProofType.Unshield,
    NetworkName.Hardhat,
    opts.walletId,
    TXIDVersion.V2_PoseidonMerkle,
    opts.encryptionKey,
    false, // showSenderAddressToRecipient
    undefined, // memoText
    [
      {
        tokenAddress: opts.tokenAddress,
        amount: opts.amount,
        // The PrivacyPool itself receives the USDC — it then forwards via CCTP.
        recipientAddress: opts.privacyPoolAddress,
      },
    ],
    [], // nftAmountRecipients
    opts.broadcasterFee ?? undefined,
    sendWithPublicWallet,
    { contract: ethers.ZeroAddress, parameters: adaptParams },
    false, // useDummyProof
    undefined, // overallBatchMinGasPrice — A6/follow-up
    (progress) => opts.onProgress?.(progress / 100),
  )
  if (!provedTransactions.length) {
    throw new Error('buildXchainUnshieldTransaction: SDK returned no proved transactions')
  }
  return { transaction: normalizeTransaction(provedTransactions[0], opts.hubChainId) }
}

/**
 * Coerce the SDK's proved Transaction struct into the exact tuple shape the on-chain
 * `atomicCrossChainUnshield` ABI expects: strict bigint / hex types on every field. Adapted from
 * the yield.ts adapter normalizer.
 */
function normalizeTransaction(tx: unknown, hubChainId: number): unknown {
  const toBigInt = (v: unknown): bigint => {
    if (v == null) return 0n
    if (typeof v === 'bigint') return v
    if (typeof v === 'number' || typeof v === 'string') return BigInt(v)
    return 0n
  }
  const toHex = (v: unknown): string => {
    if (v == null) return ethers.ZeroHash
    if (typeof v === 'string' && v.startsWith('0x')) return v
    try {
      return ethers.hexlify(v as ethers.BytesLike)
    } catch {
      return ethers.ZeroHash
    }
  }
  const t = tx as Record<string, unknown>
  const bp = t.boundParams as Record<string, unknown> | undefined
  const rawCiphertext = (bp?.commitmentCiphertext ?? []) as Array<Record<string, unknown> | null | undefined>
  const defaultCiphertext: [string, string, string, string] = [
    ethers.ZeroHash, ethers.ZeroHash, ethers.ZeroHash, ethers.ZeroHash,
  ]
  const commitmentCiphertext = rawCiphertext
    .filter((c): c is Record<string, unknown> => c != null)
    .map((c) => {
      const ct = c.ciphertext as string[] | undefined
      const arr = Array.isArray(ct) && ct.length >= 4
        ? [ct[0], ct[1], ct[2], ct[3]] as [string, string, string, string]
        : defaultCiphertext
      return {
        ciphertext: arr,
        blindedSenderViewingKey: (c.blindedSenderViewingKey ?? ethers.ZeroHash) as string,
        blindedReceiverViewingKey: (c.blindedReceiverViewingKey ?? ethers.ZeroHash) as string,
        annotationData: (c.annotationData ?? '0x') as string,
        memo: (c.memo ?? '0x') as string,
      }
    })

  const up = t.unshieldPreimage as Record<string, unknown> | undefined
  const token = (up?.token ?? {}) as Record<string, unknown>
  const unshieldPreimage = {
    npk: toHex(up?.npk) || ethers.ZeroHash,
    token: {
      tokenType: Number(token.tokenType ?? 0),
      tokenAddress: (token.tokenAddress != null ? String(token.tokenAddress) : ethers.ZeroAddress) as string,
      tokenSubID: toBigInt(token.tokenSubID),
    },
    value: toBigInt(up?.value),
  }

  const proof = t.proof as Record<string, unknown> | undefined
  const pa = (proof?.a ?? {}) as Record<string, unknown>
  const pb = (proof?.b ?? {}) as Record<string, unknown>
  const pc = (proof?.c ?? {}) as Record<string, unknown>
  const pbx = pb.x as unknown[] | undefined
  const pby = pb.y as unknown[] | undefined
  const snarkProof = {
    a: { x: toBigInt(pa.x), y: toBigInt(pa.y) },
    b: {
      x: [toBigInt(pbx?.[0]), toBigInt(pbx?.[1])] as [bigint, bigint],
      y: [toBigInt(pby?.[0]), toBigInt(pby?.[1])] as [bigint, bigint],
    },
    c: { x: toBigInt(pc.x), y: toBigInt(pc.y) },
  }

  return {
    proof: snarkProof,
    merkleRoot: toHex(t.merkleRoot) || ethers.ZeroHash,
    nullifiers: ((t.nullifiers ?? []) as unknown[]).map((n) => toHex(n) || ethers.ZeroHash) as string[],
    commitments: ((t.commitments ?? []) as unknown[]).map((c) => toHex(c) || ethers.ZeroHash) as string[],
    boundParams: {
      treeNumber: Number(bp?.treeNumber ?? 0),
      minGasPrice: toBigInt(bp?.minGasPrice),
      unshield: Number(bp?.unshield ?? 1),
      chainID: toBigInt(bp?.chainID) || BigInt(hubChainId),
      adaptContract: (bp?.adaptContract != null ? String(bp.adaptContract) : ethers.ZeroAddress) as string,
      adaptParams: toHex(bp?.adaptParams) || ethers.ZeroHash,
      commitmentCiphertext,
    },
    unshieldPreimage,
  }
}
