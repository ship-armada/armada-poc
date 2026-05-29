// ABOUTME: SDK-side helpers for transfer-shielded — generateTransferProof + populateProvedTransfer with broadcaster-fee (relayer-mediated) support.
// ABOUTME: Mirrors lib/railgun/unshield.ts in structure; differences are the 0zk recipient and two extra SDK args (showSenderAddressToRecipient, memoText).

import { loadHubNetwork } from './network'

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
 * tx as the transfer. Required for the relayer-mediated submit path; pass `null` for direct
 * user-submission.
 *
 * Same shape as `lib/railgun/unshield.ts::BroadcasterFeeRecipient` — kept duplicated here for
 * locality; co-locating with the helper makes the SDK-arg-passing call site self-contained.
 */
export interface BroadcasterFeeRecipient {
  tokenAddress: string
  amount: bigint
  recipientAddress: string
}

/**
 * Gas details — branches Type1/Type2 on `sendWithPublicWallet`. Mirrors `unshield.ts::buildGasDetails`.
 * Broadcaster mode (sendWithPublicWallet=false) requires Type1 because the SDK only supports
 * `overallBatchMinGasPrice` on Type1; Type2 surfaces as "Invalid evmGasType for Hardhat
 * (Broadcaster)". Direct-submit mode stays Type2 (EIP-1559) which is what MetaMask sends.
 */
async function buildGasDetails(sendWithPublicWallet: boolean): Promise<unknown> {
  const { EVMGasType } = await sharedModels()
  if (sendWithPublicWallet) {
    return {
      evmGasType: EVMGasType.Type2,
      gasEstimate: 2_000_000n,
      maxFeePerGas: 2_000_000_000n,
      maxPriorityFeePerGas: 1_000_000_000n,
    }
  }
  return {
    evmGasType: EVMGasType.Type1,
    gasEstimate: 2_000_000n,
    gasPrice: 1_000_000_000n,
  }
}

/**
 * Generate the ZK transfer proof for a single 0zk recipient. Caches the proof in engine memory
 * keyed by ALL the inputs (including `broadcasterFee`); the subsequent `populateProvedTransfer`
 * MUST pass identical args or the SDK throws "proof not found".
 *
 * `showSenderAddressToRecipient: false` keeps the sender's 0zk address hidden from the recipient
 * — privacy default. `memoText: undefined` for v1; a memo field is a future UX add.
 */
export async function generateTransferProofForRecipient(opts: {
  walletId: string
  encryptionKey: string
  tokenAddress: string
  recipient: string
  amount: bigint
  broadcasterFee: BroadcasterFeeRecipient | null
  onProgress?: (fraction: number) => void
}): Promise<void> {
  if (!opts.recipient.startsWith('0zk')) {
    throw new Error('generateTransferProofForRecipient: recipient must be a 0zk Railgun address')
  }
  await loadHubNetwork()
  const [{ generateTransferProof }, { TXIDVersion, NetworkName }] = await Promise.all([
    railgunSdk(),
    sharedModels(),
  ])
  const sendWithPublicWallet = opts.broadcasterFee === null
  await generateTransferProof(
    TXIDVersion.V2_PoseidonMerkle,
    NetworkName.Hardhat,
    opts.walletId,
    opts.encryptionKey,
    false, // showSenderAddressToRecipient — privacy default
    undefined, // memoText — no memo for v1
    [
      {
        tokenAddress: opts.tokenAddress,
        amount: opts.amount,
        recipientAddress: opts.recipient,
      },
    ],
    [], // nftAmountRecipients
    opts.broadcasterFee ?? undefined,
    sendWithPublicWallet,
    undefined, // overallBatchMinGasPrice — future: derive from quote for staleness check
    (progress) => opts.onProgress?.(progress / 100),
  )
}

/**
 * Populate the transaction object using the proof cached above. Inputs MUST match the proof call
 * (including broadcasterFee — the cache key is keyed by all args).
 *
 * Returns raw `to` + `data` + `value`. The handler POSTs `{to, data}` to the relayer when
 * broadcasterFee is non-null; otherwise submits via the connected EVM wallet (Phase B fallback).
 */
export async function populateTransferTransaction(opts: {
  walletId: string
  tokenAddress: string
  recipient: string
  amount: bigint
  broadcasterFee: BroadcasterFeeRecipient | null
}): Promise<{ to: `0x${string}`; data: `0x${string}`; value: bigint }> {
  const [{ populateProvedTransfer }, { TXIDVersion, NetworkName }] = await Promise.all([
    railgunSdk(),
    sharedModels(),
  ])
  const sendWithPublicWallet = opts.broadcasterFee === null
  const gasDetails = await buildGasDetails(sendWithPublicWallet)
  const result = await populateProvedTransfer(
    TXIDVersion.V2_PoseidonMerkle,
    NetworkName.Hardhat,
    opts.walletId,
    false, // showSenderAddressToRecipient
    undefined, // memoText
    [
      {
        tokenAddress: opts.tokenAddress,
        amount: opts.amount,
        recipientAddress: opts.recipient,
      },
    ],
    [], // nftAmountRecipients
    opts.broadcasterFee ?? undefined,
    sendWithPublicWallet,
    undefined, // overallBatchMinGasPrice
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    gasDetails as any,
  )
  const tx = result.transaction
  if (!tx.to || !tx.data) {
    throw new Error('populateTransferTransaction: SDK returned an incomplete transaction')
  }
  return {
    to: tx.to as `0x${string}`,
    data: tx.data as `0x${string}`,
    value: tx.value ? BigInt(tx.value.toString()) : 0n,
  }
}
