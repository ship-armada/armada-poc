// ABOUTME: Phase 9 integration sweep — exercises useHistoryRecovery + useIncomingTransferDetector together: cold-unlock scan, dedup against authored records, balance-event-triggered incremental scan, and checkpoint advancement.
// ABOUTME: Mocks at the SDK boundary (subscribeBalanceUpdates + scanWalletHistory) + storage; hooks + state atoms run unmodified to catch cross-hook regressions the per-hook unit tests can't.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, waitFor, act } from '@testing-library/react'
import { Provider, createStore } from 'jotai'
import {
  TransactionHistoryItemCategory,
  RailgunWalletBalanceBucket,
  TXIDVersion,
  type TransactionHistoryItem,
} from '@railgun-community/shared-models'
import {
  activeRailgunWalletIdAtom,
  shieldedWalletsAtom,
} from '@/state/wallet'
import { txListAtom } from '@/state/tx'
import { historyRecoveryAtom } from '@/state/history'
import type { TxRecord } from '@/lib/tx/types'

const HUB_DEPLOY_BLOCK = 100_000

// ─────────────────────────────────────────────────────────────────────────────
// Hoisted shared mocks for the SDK + storage boundaries.
// ─────────────────────────────────────────────────────────────────────────────
const hoisted = vi.hoisted(() => {
  let balanceListener:
    | ((event: { chain: { type: 0; id: number }; railgunWalletID: string }) => void)
    | null = null
  return {
    scanWalletHistory: vi.fn<(walletId: string, fromBlock?: number) => Promise<TransactionHistoryItem[]>>(
      async () => [],
    ),
    putTxIfFresh: vi.fn<(record: TxRecord) => Promise<boolean>>(async () => true),
    subscribe: vi.fn(async (listener: typeof balanceListener) => {
      balanceListener = listener
      return () => {
        balanceListener = null
      }
    }),
    fireBalanceEvent(walletID: string) {
      if (balanceListener) {
        balanceListener({ chain: { type: 0, id: 31337 }, railgunWalletID: walletID })
      }
    },
    loadDeployments: vi.fn(async () => ({
      hub: { chainId: 31337, deployBlock: HUB_DEPLOY_BLOCK },
      clients: [],
    })),
    loadYieldDeployment: vi.fn(async () => null),
  }
})

vi.mock('@/lib/railgun/history', async () => {
  const actual = await vi.importActual<typeof import('@/lib/railgun/history')>(
    '@/lib/railgun/history',
  )
  return {
    ...actual,
    scanWalletHistory: hoisted.scanWalletHistory,
    runHistoryScan: async (
      walletId: string,
      ctx: import('@/lib/railgun/history').HistoryMapContext,
      fromBlock: number | undefined,
    ) => {
      const items = await hoisted.scanWalletHistory(walletId, fromBlock)
      const records = actual.historyItemsToTxRecords(items, walletId, ctx)
      let highest: number | null = null
      for (const item of items) {
        if (item.blockNumber !== undefined && item.blockNumber !== null) {
          if (highest === null || item.blockNumber > highest) highest = item.blockNumber
        }
      }
      return { records, highestBlock: highest, itemCount: items.length }
    },
  }
})

vi.mock('@/lib/tx/storage', () => ({
  putTxIfFresh: hoisted.putTxIfFresh,
  putTx: vi.fn(async () => {}),
  deleteTx: vi.fn(async () => {}),
  loadAllTx: vi.fn(async () => []),
}))

vi.mock('@/lib/railgun/sync', () => ({
  subscribeBalanceUpdates: hoisted.subscribe,
}))

vi.mock('@/config/deployments', () => ({
  loadDeployments: hoisted.loadDeployments,
  loadYieldDeployment: hoisted.loadYieldDeployment,
}))

import { useHistoryRecovery } from '@/hooks/useHistoryRecovery'
import { useIncomingTransferDetector } from '@/hooks/useIncomingTransferDetector'

function Harness() {
  useHistoryRecovery()
  useIncomingTransferDetector()
  return null
}

function shieldItem(
  txid: string,
  blockNumber: number,
  amount: bigint,
): TransactionHistoryItem {
  return {
    txidVersion: TXIDVersion.V2_PoseidonMerkle,
    txid,
    version: 0,
    timestamp: blockNumber,
    blockNumber,
    receiveERC20Amounts: [{
      tokenAddress: '0xusdc',
      amount,
      senderAddress: null,
      memoText: null,
      shieldFee: undefined,
      hasValidPOIForActiveLists: true,
      balanceBucket: RailgunWalletBalanceBucket.Spendable,
    }],
    transferERC20Amounts: [],
    changeERC20Amounts: [],
    unshieldERC20Amounts: [],
    receiveNFTAmounts: [],
    transferNFTAmounts: [],
    unshieldNFTAmounts: [],
    category: TransactionHistoryItemCategory.ShieldERC20s,
  }
}

function transferReceiveItem(
  txid: string,
  blockNumber: number,
  amount: bigint,
): TransactionHistoryItem {
  return {
    txidVersion: TXIDVersion.V2_PoseidonMerkle,
    txid,
    version: 0,
    timestamp: blockNumber,
    blockNumber,
    receiveERC20Amounts: [{
      tokenAddress: '0xusdc',
      amount,
      senderAddress: '0xsomeoneelse',
      memoText: null,
      shieldFee: undefined,
      hasValidPOIForActiveLists: true,
      balanceBucket: RailgunWalletBalanceBucket.Spendable,
    }],
    transferERC20Amounts: [],
    changeERC20Amounts: [],
    unshieldERC20Amounts: [],
    receiveNFTAmounts: [],
    transferNFTAmounts: [],
    unshieldNFTAmounts: [],
    category: TransactionHistoryItemCategory.TransferReceiveERC20s,
  }
}

function unshieldItem(
  txid: string,
  blockNumber: number,
  amount: bigint,
): TransactionHistoryItem {
  return {
    txidVersion: TXIDVersion.V2_PoseidonMerkle,
    txid,
    version: 0,
    timestamp: blockNumber,
    blockNumber,
    receiveERC20Amounts: [],
    transferERC20Amounts: [],
    changeERC20Amounts: [],
    unshieldERC20Amounts: [{
      tokenAddress: '0xusdc',
      amount,
      recipientAddress: '0xrecipient',
      memoText: null,
      hasValidPOIForActiveLists: true,
      balanceBucket: RailgunWalletBalanceBucket.Spendable,
    }],
    receiveNFTAmounts: [],
    transferNFTAmounts: [],
    unshieldNFTAmounts: [],
    category: TransactionHistoryItemCategory.UnshieldERC20s,
  }
}

function unlockedStore() {
  const store = createStore()
  store.set(shieldedWalletsAtom, {
    'rg-1': { id: 'rg-1', status: 'unlocked', railgunAddress: '0zk-test' },
  })
  store.set(activeRailgunWalletIdAtom, 'rg-1')
  return store
}

beforeEach(() => {
  window.localStorage.clear()
  hoisted.scanWalletHistory.mockReset()
  hoisted.scanWalletHistory.mockResolvedValue([])
  hoisted.putTxIfFresh.mockReset()
  hoisted.putTxIfFresh.mockResolvedValue(true)
  hoisted.subscribe.mockClear()
})

describe('Phase 9 — chain history recovery + incoming detector integration', () => {
  it('cold unlock → scans, persists rows, advances checkpoint, flips state to idle', async () => {
    // WHY: end-to-end happy path. Fresh device (no checkpoint) + unlocked wallet should produce
    // a single scan from the deploy block, surface records in the atom, write the checkpoint,
    // and the banner state should settle on idle once persistence completes.
    hoisted.scanWalletHistory.mockResolvedValue([
      shieldItem('a', 100_001, 1_000_000n),
      shieldItem('b', 100_010, 2_000_000n),
    ])
    const store = unlockedStore()
    render(
      <Provider store={store}>
        <Harness />
      </Provider>,
    )
    await waitFor(() => {
      expect(store.get(txListAtom).length).toBe(2)
    })
    expect(hoisted.scanWalletHistory).toHaveBeenCalledWith('rg-1', HUB_DEPLOY_BLOCK)
    expect(store.get(historyRecoveryAtom).state).toBe('idle')
    const cp = window.localStorage.getItem('armada.shielded.historyScanBlock.rg-1')
    expect(cp).not.toBeNull()
    expect(JSON.parse(cp!).block).toBe(100_010)
  })

  it('balance event during a live session triggers an incremental scan + adds the new received row', async () => {
    // WHY: the v1 feature promise is "received transfers surface live, no refresh required."
    // Mid-session balance event from the SDK must drive a fresh scan whose new record lands in
    // the active activity feed without user action.
    // First scan: nothing.
    hoisted.scanWalletHistory.mockResolvedValueOnce([])
    const store = unlockedStore()
    render(
      <Provider store={store}>
        <Harness />
      </Provider>,
    )
    await waitFor(() => {
      expect(hoisted.scanWalletHistory).toHaveBeenCalledTimes(1)
    })
    expect(store.get(txListAtom).length).toBe(0)

    // Simulate an incoming transfer: queue the SDK response then fire the balance event.
    hoisted.scanWalletHistory.mockResolvedValueOnce([
      transferReceiveItem('rcv-1', 100_005, 5_000_000n),
    ])
    await act(async () => {
      hoisted.fireBalanceEvent('rg-1')
    })

    // useIncomingTransferDetector trailing-debounces the epoch bump by 2s (P1-29), so the
    // incremental scan fires after the quiet window — give waitFor more than that budget on real
    // timers rather than mixing fake timers into the SDK-mock + waitFor flow.
    await waitFor(
      () => {
        expect(store.get(txListAtom).length).toBe(1)
      },
      { timeout: 3_000 },
    )
    const newRecord = store.get(txListAtom)[0]!
    expect(newRecord.kind).toBe('transfer-shielded-received')
    expect(newRecord.id).toBe('synth:rcv-1:TransferReceiveERC20s')
  })

  it('authored outgoing record blocks the synth-row duplicate of the same on-chain hash', async () => {
    // WHY: the dedup invariant. The user submitted a shield; useTx wrote a real lifecycle-rich
    // record. A subsequent chain scan returning the same tx must NOT add a parallel synth row.
    const AUTHORED_HASH = '0xabc' as `0x${string}`
    const authored: TxRecord<'shield'> = {
      id: '01J-authored',
      kind: 'shield',
      executionState: 'completed',
      stage: 'hub-confirmed',
      stagesCompleted: ['build-proof', 'submit-relayer', 'hub-confirmed'],
      updatedSeq: 7,
      createdAt: 1,
      updatedAt: 1,
      meta: { amount: 1_000_000n, feeCacheId: 'fc', fromChainId: 31337 },
      artifacts: { sourceTxHash: AUTHORED_HASH },
      walletContext: { evmAddress: '0xeoa', railgunWalletId: 'rg-1', sourceChainId: 31337 },
    }
    const store = unlockedStore()
    store.set(txListAtom, [authored])

    hoisted.scanWalletHistory.mockResolvedValue([
      // Same txid as the authored record. Without dedup we'd see 2 rows for one event.
      shieldItem('abc', 100_001, 1_000_000n),
      // Unrelated tx. Must synthesize.
      shieldItem('xyz', 100_002, 2_000_000n),
    ])

    render(
      <Provider store={store}>
        <Harness />
      </Provider>,
    )

    await waitFor(() => {
      // Authored (1) + synth for 'xyz' only = 2.
      expect(store.get(txListAtom).length).toBe(2)
    })
    const ids = store.get(txListAtom).map(r => r.id).sort()
    expect(ids).toContain('01J-authored')
    expect(ids).toContain('synth:xyz:ShieldERC20s')
    expect(ids).not.toContain('synth:abc:ShieldERC20s')
  })

  it('reconciles a terminated-but-confirmed authored record to completed, without a synth duplicate', async () => {
    // WHY (P1-24): the user's shield expired locally (we lost the watcher past the lifecycle cap),
    // but the chain shows it actually landed. The scan must UPGRADE the authored record to
    // completed in place — not skip (leaving a permanent false "expired") and not add a parallel
    // synth row. The terminal-write guard permits expired→completed (terminal→terminal).
    const CONFIRMED_HASH = '0xabc' as `0x${string}`
    const expired: TxRecord<'shield'> = {
      id: '01J-expired',
      kind: 'shield',
      executionState: 'expired',
      stage: 'submit-relayer',
      stagesCompleted: ['build-proof'],
      updatedSeq: 4,
      createdAt: 1,
      updatedAt: 1,
      meta: { amount: 1_000_000n, feeCacheId: 'fc', fromChainId: 31337 },
      artifacts: { sourceTxHash: CONFIRMED_HASH, error: { code: 'POLL_TIMEOUT', message: 'lost track' } },
      walletContext: { evmAddress: '0xeoa', railgunWalletId: 'rg-1', sourceChainId: 31337 },
    }
    const store = unlockedStore()
    store.set(txListAtom, [expired])

    hoisted.scanWalletHistory.mockResolvedValue([shieldItem('abc', 100_001, 1_000_000n)])

    render(
      <Provider store={store}>
        <Harness />
      </Provider>,
    )

    await waitFor(() => {
      expect(store.get(txListAtom).find(r => r.id === '01J-expired')?.executionState).toBe('completed')
    })
    const list = store.get(txListAtom)
    // No duplicate synth row beside the upgraded authored record.
    expect(list.length).toBe(1)
    const upgraded = list[0]!
    expect(upgraded.id).toBe('01J-expired')
    expect(upgraded.stage).toBe('hub-confirmed')
    expect(upgraded.artifacts.sourceTxHash).toBe(CONFIRMED_HASH)
    expect(upgraded.artifacts.error).toBeUndefined()
  })

  it('does NOT force-complete an in-flight cross-chain unshield from the hub-burn hash (T-H1)', async () => {
    // WHY (T-H1): the hub BURN of an unshield-xchain appears in shielded history with the same
    // txid as the record's sourceTxHash, but that proves only the burn leg — CCTP delivery on the
    // destination chain hasn't happened (and may never). Force-completing here paints a false
    // "Funds delivered" and upgrades a real POLL_TIMEOUT failure to permanent false success. The
    // reconcile path must leave xchain records to the executor's delivery watcher.
    const BURN_HASH = '0xburn' as `0x${string}`
    const failedXchain: TxRecord<'unshield-xchain'> = {
      id: '01J-xchain-failed',
      kind: 'unshield-xchain',
      executionState: 'failed',
      stage: 'iris-attestation-pending',
      stagesCompleted: ['build-proof', 'submit-relayer', 'hub-burn-confirmed'],
      updatedSeq: 6,
      createdAt: 1,
      updatedAt: 1,
      meta: {
        amount: 1_000_000n,
        feeCacheId: 'fc',
        toChainId: 84532,
        recipient: '0x0000000000000000000000000000000000000001',
        broadcasterFeeAmount: 50_000n,
        broadcasterRailgunAddress: '0zk' + 'a'.repeat(64),
      },
      artifacts: { sourceTxHash: BURN_HASH, error: { code: 'POLL_TIMEOUT', message: 'lost track' } },
      walletContext: { evmAddress: '0xeoa', railgunWalletId: 'rg-1', sourceChainId: 31337 },
    }
    const store = unlockedStore()
    store.set(txListAtom, [failedXchain])
    // The hub burn surfaces as an unshield history item carrying the same txid → sourceTxHash 0xburn.
    hoisted.scanWalletHistory.mockResolvedValue([unshieldItem('burn', 100_001, 1_000_000n)])

    render(
      <Provider store={store}>
        <Harness />
      </Provider>,
    )

    // Wait for the scan to fully settle (status flips to idle when runScanAndPersist finishes).
    await waitFor(() => expect(store.get(historyRecoveryAtom).state).toBe('idle'))

    const rec = store.get(txListAtom).find(r => r.id === '01J-xchain-failed')
    expect(rec?.executionState).toBe('failed') // stays failed — no false "Funds delivered"
    expect(rec?.stage).toBe('iris-attestation-pending')
    // No synth row inserted either (the matched-existing branch skips without upgrading).
    expect(store.get(txListAtom).length).toBe(1)
  })

  it('subsequent scans resume from checkpoint+1, not the hub deploy block', async () => {
    // WHY: this is the perf invariant. The whole point of the checkpoint is to avoid re-walking
    // hub history. A regression here turns a cheap incremental into a full-history rewalk on
    // every balance event.
    window.localStorage.setItem(
      'armada.shielded.historyScanBlock.rg-1',
      JSON.stringify({ block: 500_000, scannedAt: 1 }),
    )
    const store = unlockedStore()
    render(
      <Provider store={store}>
        <Harness />
      </Provider>,
    )
    await waitFor(() => {
      expect(hoisted.scanWalletHistory).toHaveBeenCalled()
    })
    expect(hoisted.scanWalletHistory).toHaveBeenCalledWith('rg-1', 500_001)
  })
})
