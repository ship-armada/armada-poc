// ABOUTME: Yield adapt-proof generation — single SDK proof of type CrossContractCalls binds the shield destination to the adapter's output via adaptParams. Broadcaster-fee aware (relayer-mediated submit).
// ABOUTME: Mode-parametric (lend / redeem); the on-chain entry point picks lendAndShield vs redeemAndShield. All dynamic-imports to dodge jsdom + circomlibjs at module-load.

import { ethers } from 'ethers'
import { loadHubNetwork } from './network'
import { yieldToPaint } from '@/lib/paint'

type RailgunSdk = typeof import('@railgun-community/wallet')
type RailgunEngine = typeof import('@railgun-community/engine')
type SharedModels = typeof import('@railgun-community/shared-models')

async function railgunSdk(): Promise<RailgunSdk> {
  return import('@railgun-community/wallet')
}
async function railgunEngine(): Promise<RailgunEngine> {
  return import('@railgun-community/engine')
}
async function sharedModels(): Promise<SharedModels> {
  return import('@railgun-community/shared-models')
}

export type YieldAdaptMode = 'lend' | 'redeem'

/**
 * One broadcaster output baked into the CrossContractCalls proof so the relayer is paid in the
 * same atomic tx as the lend/redeem. Required for the relayer-mediated submit path; pass `null`
 * to fall back to direct user submission (the Phase B wallet-fallback override).
 *
 * Same shape as the corresponding type in `transfer.ts` / `unshield.ts` — duplicated for
 * locality so each SDK-helper file is self-contained.
 */
export interface BroadcasterFeeRecipient {
  tokenAddress: string
  amount: bigint
  recipientAddress: string
}

/**
 * Bind the shield destination into adaptParams so the on-chain adapter can't redirect the
 * minted aUSDC (lend) or USDC (redeem) anywhere else. Solidity verifies adaptParams matches
 * keccak256(abi.encode(npk, encryptedBundle, shieldKey)) — divergence reverts.
 */
function encodeYieldAdaptParams(
  npk: string,
  encryptedBundle: [string, string, string],
  shieldKey: string,
): string {
  const encoded = ethers.AbiCoder.defaultAbiCoder().encode(
    ['bytes32', 'bytes32[3]', 'bytes32'],
    [npk, encryptedBundle, shieldKey],
  )
  return ethers.keccak256(encoded)
}

/**
 * Withdraw (redeem) variant that also binds the broadcaster fee into adaptParams. The fee is paid as a
 * SHIELD to the relayer's own 0zk destination (so the relayer is paid to its shielded address like every
 * other tx type), from the redeemed USDC proceeds — a single Transaction, self-funding, relayer-immutable
 * (issue #312). Must match Solidity
 * YieldAdaptParams.encode(npk, bundle, shieldKey, feeNpk, feeBundle, feeShieldKey, feeAmount).
 */
function encodeYieldAdaptParamsWithFee(
  npk: string,
  encryptedBundle: [string, string, string],
  shieldKey: string,
  feeNpk: string,
  feeEncryptedBundle: [string, string, string],
  feeShieldKey: string,
  feeAmount: bigint,
): string {
  const encoded = ethers.AbiCoder.defaultAbiCoder().encode(
    ['bytes32', 'bytes32[3]', 'bytes32', 'bytes32', 'bytes32[3]', 'bytes32', 'uint256'],
    [npk, encryptedBundle, shieldKey, feeNpk, feeEncryptedBundle, feeShieldKey, feeAmount],
  )
  return ethers.keccak256(encoded)
}

/**
 * Normalize the SDK's proved Transaction tuple into the shape the adapter ABI expects. The
 * SDK returns ethers v6 Result proxies with maybe-numeric / maybe-string fields; the adapter
 * call needs strict bigint / hex types. Adapted from the legacy normalizeTransactionForAdapter.
 */
function normalizeTransactionForAdapter(tx: unknown, hubChainId: number): unknown {
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

/**
 * Inline ABI fragment for the adapter's lend/redeem entry points. Mirrors the contract verbatim
 * (see contracts/yield/ArmadaYieldAdapter.sol). Both functions take the same Transaction tuple
 * + the user's shield destination (npk + ciphertext) — they differ only in what they DO with
 * the unshielded USDC (deposit into Aave vs redeem from Aave).
 */
const ADAPTER_ABI = [
  'function lendAndShield(tuple(tuple(tuple(uint256 x, uint256 y) a, tuple(uint256[2] x, uint256[2] y) b, tuple(uint256 x, uint256 y) c) proof, bytes32 merkleRoot, bytes32[] nullifiers, bytes32[] commitments, tuple(uint16 treeNumber, uint72 minGasPrice, uint8 unshield, uint64 chainID, address adaptContract, bytes32 adaptParams, tuple(bytes32[4] ciphertext, bytes32 blindedSenderViewingKey, bytes32 blindedReceiverViewingKey, bytes annotationData, bytes memo)[] commitmentCiphertext) boundParams, tuple(bytes32 npk, tuple(uint8 tokenType, address tokenAddress, uint256 tokenSubID) token, uint120 value) unshieldPreimage) _transaction, bytes32 _npk, tuple(bytes32[3] encryptedBundle, bytes32 shieldKey) _shieldCiphertext) returns (uint256)',
  'function redeemAndShield(tuple(tuple(tuple(uint256 x, uint256 y) a, tuple(uint256[2] x, uint256[2] y) b, tuple(uint256 x, uint256 y) c) proof, bytes32 merkleRoot, bytes32[] nullifiers, bytes32[] commitments, tuple(uint16 treeNumber, uint72 minGasPrice, uint8 unshield, uint64 chainID, address adaptContract, bytes32 adaptParams, tuple(bytes32[4] ciphertext, bytes32 blindedSenderViewingKey, bytes32 blindedReceiverViewingKey, bytes annotationData, bytes memo)[] commitmentCiphertext) boundParams, tuple(bytes32 npk, tuple(uint8 tokenType, address tokenAddress, uint256 tokenSubID) token, uint120 value) unshieldPreimage) _transaction, bytes32 _npk, tuple(bytes32[3] encryptedBundle, bytes32 shieldKey) _shieldCiphertext, bytes32 _feeNpk, tuple(bytes32[3] encryptedBundle, bytes32 shieldKey) _feeShieldCiphertext, uint256 _feeAmount) returns (uint256)',
]

export interface YieldAdaptProofResult {
  /** Ready-to-send tx (to = adapterAddress, data = encoded calldata, value = 0). */
  transaction: { to: `0x${string}`; data: `0x${string}`; value: bigint }
}

/**
 * Build the adapt-proof tx for a lend OR redeem operation. Single SDK proof (CrossContractCalls)
 * binds the unshield (input token → adapter) and the re-shield (output token → user's 0zk) into
 * one atomic ZK statement; the adapter can't deviate from the user's committed shield destination.
 *
 *   lend   : unshield USDC → adapter.lendAndShield → shielded aUSDC
 *   redeem : unshield aUSDC → adapter.redeemAndShield → shielded USDC
 *
 * The CALLER decides which token is which by passing `unshieldToken` (what we're spending) and
 * `shieldOutputToken` (what we'll receive back into the pool).
 */
export async function buildYieldAdaptTransaction(opts: {
  walletId: string
  encryptionKey: string
  mode: YieldAdaptMode
  unshieldToken: string
  shieldOutputToken: string
  amount: bigint
  railgunAddress: string
  adapterAddress: string
  hubChainId: number
  /**
   * Broadcaster output baked into the proof for relayer-mediated submission. When non-null,
   * `sendWithPublicWallet` flips to false and the SDK adds the broadcaster payment leg to the
   * CrossContractCalls proof — same mechanism as transfer.ts / unshield.ts, just inside the
   * adapter-bound proof. Pass `null` for direct user submission (Phase B fallback only).
   */
  broadcasterFee: BroadcasterFeeRecipient | null
  onProgress?: (fraction: number) => void
}): Promise<YieldAdaptProofResult> {
  await loadHubNetwork()
  const [{ generateProofTransactions }, { RelayAdaptHelper, ByteUtils }, { TXIDVersion, ProofType, NetworkName }] = await Promise.all([
    railgunSdk(),
    railgunEngine(),
    sharedModels(),
  ])

  // 16-byte random binds the resulting shield request — the adapter receives this same value
  // as part of adaptParams and uses it to derive identical commitments.
  const shieldRandom = ByteUtils.randomHex(16)
  const relayShieldRequests = await RelayAdaptHelper.generateRelayShieldRequests(
    shieldRandom,
    [{ tokenAddress: opts.shieldOutputToken, recipientAddress: opts.railgunAddress }],
    [],
  )
  if (relayShieldRequests.length === 0) {
    throw new Error('buildYieldAdaptTransaction: failed to generate relay shield request')
  }
  const shieldRequest = relayShieldRequests[0]!
  const npk = String(shieldRequest.preimage.npk)
  const encryptedBundle = [
    String(shieldRequest.ciphertext.encryptedBundle[0]),
    String(shieldRequest.ciphertext.encryptedBundle[1]),
    String(shieldRequest.ciphertext.encryptedBundle[2]),
  ] as [string, string, string]
  const shieldKey = String(shieldRequest.ciphertext.shieldKey)

  // Redeem (withdraw) pays the broadcaster fee contract-side from the redeemed USDC proceeds, bound
  // into adaptParams — NOT via the SDK broadcaster-fee leg, which would spend a second token (USDC)
  // and produce a second Transaction the adapter can't consume (issue #312). Lend keeps the SDK leg
  // (input and fee are both USDC → a single Transaction already).
  const isRedeem = opts.mode === 'redeem'
  const feeAmount = isRedeem ? (opts.broadcasterFee?.amount ?? 0n) : 0n

  // For a fee-bearing withdraw, generate the relayer's OWN 0zk shield destination (from its 0zk address
  // in the fee quote) and bind it into adaptParams. The adapter shields the fee to this destination, so
  // the relayer is paid to its shielded address — consistent with every other tx type (#312).
  let feeNpk = ethers.ZeroHash
  let feeEncryptedBundle: [string, string, string] = [ethers.ZeroHash, ethers.ZeroHash, ethers.ZeroHash]
  let feeShieldKey = ethers.ZeroHash
  if (isRedeem && feeAmount > 0n && opts.broadcasterFee) {
    const feeShieldRandom = ByteUtils.randomHex(16)
    const feeShieldReqs = await RelayAdaptHelper.generateRelayShieldRequests(
      feeShieldRandom,
      [{ tokenAddress: opts.shieldOutputToken, recipientAddress: opts.broadcasterFee.recipientAddress }],
      [],
    )
    if (feeShieldReqs.length === 0) {
      throw new Error('buildYieldAdaptTransaction: failed to generate relayer fee shield request')
    }
    const feeReq = feeShieldReqs[0]!
    feeNpk = String(feeReq.preimage.npk)
    feeEncryptedBundle = [
      String(feeReq.ciphertext.encryptedBundle[0]),
      String(feeReq.ciphertext.encryptedBundle[1]),
      String(feeReq.ciphertext.encryptedBundle[2]),
    ]
    feeShieldKey = String(feeReq.ciphertext.shieldKey)
  }

  const adaptParams = isRedeem
    ? encodeYieldAdaptParamsWithFee(
        npk,
        encryptedBundle,
        shieldKey,
        feeNpk,
        feeEncryptedBundle,
        feeShieldKey,
        feeAmount,
      )
    : encodeYieldAdaptParams(npk, encryptedBundle, shieldKey)

  // Generate the cross-contract-calls proof. The unshield recipient is the adapter address;
  // the proof binds via adaptContract + adaptParams so the adapter cannot redirect. Redeem never
  // binds an SDK broadcaster into the proof (its fee is contract-side); lend may.
  const sdkBroadcasterFee = isRedeem ? undefined : (opts.broadcasterFee ?? undefined)
  const sendWithPublicWallet = isRedeem ? true : opts.broadcasterFee === null
  // Yield one frame so the caller's "Generating proof…" state paints before the WASM proof gen
  // blocks the main thread for 20-30s.
  await yieldToPaint()
  const { provedTransactions } = await generateProofTransactions(
    ProofType.CrossContractCalls,
    NetworkName.Hardhat,
    opts.walletId,
    TXIDVersion.V2_PoseidonMerkle,
    opts.encryptionKey,
    false, // showSenderAddressToRecipient
    undefined, // memoText
    [
      {
        tokenAddress: opts.unshieldToken,
        amount: opts.amount,
        recipientAddress: opts.adapterAddress,
      },
    ],
    [], // nftAmountRecipients
    sdkBroadcasterFee,
    sendWithPublicWallet,
    { contract: opts.adapterAddress, parameters: adaptParams },
    false, // useDummyProof
    undefined, // overallBatchMinGasPrice
    (progress) => opts.onProgress?.(progress / 100),
  )
  if (!provedTransactions.length) {
    throw new Error('buildYieldAdaptTransaction: SDK returned no proved transactions')
  }

  const transaction = normalizeTransactionForAdapter(provedTransactions[0], opts.hubChainId)
  const iface = new ethers.Interface(ADAPTER_ABI)
  // redeemAndShield additionally takes the relayer fee-shield destination + amount, all verified
  // against adaptParams.
  const data = (
    isRedeem
      ? iface.encodeFunctionData('redeemAndShield', [
          transaction,
          npk,
          { encryptedBundle, shieldKey },
          feeNpk,
          { encryptedBundle: feeEncryptedBundle, shieldKey: feeShieldKey },
          feeAmount,
        ])
      : iface.encodeFunctionData('lendAndShield', [transaction, npk, { encryptedBundle, shieldKey }])
  ) as `0x${string}`

  return {
    transaction: {
      to: opts.adapterAddress as `0x${string}`,
      data,
      value: 0n,
    },
  }
}
