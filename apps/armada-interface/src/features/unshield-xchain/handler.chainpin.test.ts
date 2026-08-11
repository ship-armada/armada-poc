// ABOUTME: Chain-pin tests for the unshield-xchain handler's wallet-override hub-burn path (W-3/W-4).
// ABOUTME: The hub-chain receipt wait must carry an explicit chainId so a mid-flow wallet network switch can't retarget polling to a chain where the hash doesn't exist.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('wagmi/actions', () => ({
  getPublicClient: vi.fn(() => null),
  sendTransaction: vi.fn(async () => '0xunused'),
}))
vi.mock('@/config/wagmi', () => ({ wagmiConfig: {} }))
vi.mock('@/lib/network-switch', () => ({ ensureChain: vi.fn(async () => {}) }))

// Capture the chainId, then throw to short-circuit the post-receipt CCTP extraction — we only
// care that the receipt wait was pinned. The outer catch routes the throw into markFailed.
const waitForReceiptMock = vi.hoisted(() => vi.fn(async () => { throw new Error('stop-after-capture') }))
vi.mock('@/lib/tx/receipt', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/tx/receipt')>()
  return { ...actual, waitForReceiptOrFail: waitForReceiptMock }
})

// Mock the SDK builder so importing the handler doesn't transitively load the @armada/sdk prover.
vi.mock('@/lib/railgun/unshield-xchain-sdk', () => ({
  buildXchainUnshieldSdk: vi.fn(),
}))
vi.mock('@/lib/railgun/sync', () => ({ refreshShieldedBalances: vi.fn(async () => {}) }))
vi.mock('@/lib/railgun/keyManager', () => ({
  isUnlocked: () => false,
  getWalletId: () => 'rw-1',
  getSdkEncryptionKey: () => '0xkey',
}))
vi.mock('@/config/deployments', () => ({
  loadDeployments: vi.fn(async () => ({
    hub: {
      contracts: { privacyPool: '0x5555555555555555555555555555555555555555' },
      cctp: {
        messageTransmitter: '0x6666666666666666666666666666666666666666',
        usdc: '0x2222222222222222222222222222222222222222',
      },
    },
    clients: [],
  })),
}))

import { unshieldXchainHandler } from './handler'
import type { ExecutorCtx } from '@/lib/tx/executor'
import type { TxRecord } from '@/lib/tx/types'

function makeCtx() {
  const upserts: TxRecord[] = []
  const ac = new AbortController()
  const ctx: ExecutorCtx<'unshield-xchain'> = {
    signal: ac.signal,
    upsert: async (r) => { upserts.push(r as TxRecord) },
  }
  return { ctx, upserts }
}

function overrideRecordWithHash(): TxRecord<'unshield-xchain'> {
  return {
    id: 'ulid-unshield-xchain-override',
    kind: 'unshield-xchain',
    executionState: 'retrying',
    stage: 'submit-relayer',
    stagesCompleted: ['build-proof'],
    updatedSeq: 3,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    meta: {
      amount: 1_000_000n,
      feeCacheId: 'c',
      recipient: '0x3333333333333333333333333333333333333333',
      toChainId: 31338,
      broadcasterFeeAmount: 0n,
      broadcasterShieldedAddress: '0zk1relayer',
      useWalletOverride: true,
    },
    // A record at submit-relayer always carries the encoded calldata persisted at build-proof —
    // required now that runSubmitAndBurn dispatches from artifacts rather than re-proving.
    artifacts: {
      sourceTxHash: '0xfeed',
      unshieldTx: {
        to: '0x5555555555555555555555555555555555555555',
        data: '0xdeadbeef',
        value: '0',
      },
    },
    walletContext: { evmAddress: '0xabc', shieldedWalletId: 'rw-1', sourceChainId: 31337 },
  } as TxRecord<'unshield-xchain'>
}

describe('unshieldXchainHandler wallet-override chain pinning (W-3/W-4)', () => {
  beforeEach(() => { waitForReceiptMock.mockClear() })

  it('pins the hub chainId on the receipt wait', async () => {
    const { ctx } = makeCtx()
    await unshieldXchainHandler.run(overrideRecordWithHash(), ctx)
    expect(waitForReceiptMock).toHaveBeenCalledWith(expect.objectContaining({ chainId: 31337 }))
  })
})
