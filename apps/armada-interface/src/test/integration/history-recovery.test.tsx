// ABOUTME: Phase 9 integration sweep — exercises useHistoryRecovery + useIncomingTransferDetector together: cold-unlock scan, dedup against authored records, balance-event-triggered incremental scan, and checkpoint advancement.
// ABOUTME: Mocks at the SDK boundary (subscribeBalanceUpdates + runHistoryScan) + storage; hooks + state atoms run unmodified to catch cross-hook regressions the per-hook unit tests can't.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, waitFor, act } from '@testing-library/react'
import { Provider, createStore } from 'jotai'
import {
  activeRailgunWalletIdAtom,
  shieldedWalletsAtom,
} from '@/state/wallet'
import { txListAtom } from '@/state/tx'
import { historyRecoveryAtom } from '@/state/history'
import type { TxRecord } from '@/lib/tx/types'
import type { HistoryScanResult } from '@/lib/railgun/history'

const HUB_DEPLOY_BLOCK = 100_000

// ─────────────────────────────────────────────────────────────────────────────
// Hoisted shared mocks for the SDK + storage boundaries.
// ─────────────────────────────────────────────────────────────────────────────
const hoisted = vi.hoisted(() => {
  let balanceListener:
    | ((event: { chain: { type: 0; id: number }; railgunWalletID: string }) => void)
    | null = null
  return {
    runHistoryScan: vi.fn(async (): Promise<HistoryScanResult> => ({
      records: [],
      highestBlock: null,
      itemCount: 0,
    })),
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

// Replace the scan entry point so we feed deterministic HistoryScanResults, but keep the real
// historyEntryToTxRecord mapper for building fixtures (so ids + sourceTxHash are authentic).
vi.mock('@/lib/railgun/history', async () => {
  const actual = await vi.importActual<typeof import('@/lib/railgun/history')>(
    '@/lib/railgun/history',
  )
  return { ...actual, runHistoryScan: hoisted.runHistoryScan }
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
import { historyEntryToTxRecord } from '@/lib/railgun/history'

function Harness() {
  useHistoryRecovery()
  useIncomingTransferDetector()
  return null
}

/* Fixture builders — synthesize TxRecords via the real SDK mapper so ids + sourceTxHash are
   authentic. `txid` drives both the synthetic id and the `0x<txid>` sourceTxHash used for dedup. */

function shieldRecord(txid: string, blockNumber: number, amount: bigint): TxRecord {
  return historyEntryToTxRecord(
    { txid, blockNumber, category: 'shield', tokenAddress: '0xusdc', value: amount },
    'rg-1', { hubChainId: 31337 }, blockNumber * 1000,
  )!
}

function receiveRecord(txid: string, blockNumber: number, amount: bigint): TxRecord {
  return historyEntryToTxRecord(
    { txid, blockNumber, category: 'transfer-received', tokenAddress: '0xusdc', value: amount },
    'rg-1', { hubChainId: 31337 }, blockNumber * 1000,
  )!
}

function unshieldRecord(txid: string, blockNumber: number, amount: bigint): TxRecord {
  return historyEntryToTxRecord(
    { txid, blockNumber, category: 'unshield', tokenAddress: '0xusdc', value: -amount, recipient: '0xrecipient' },
    'rg-1', { hubChainId: 31337 }, blockNumber * 1000,
  )!
}

function scanResult(records: TxRecord[], highestBlock: number | null): HistoryScanResult {
  return { records, highestBlock, itemCount: records.length }
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
  hoisted.runHistoryScan.mockReset()
  hoisted.runHistoryScan.mockResolvedValue(scanResult([], null))
  hoisted.putTxIfFresh.mockReset()
  hoisted.putTxIfFresh.mockResolvedValue(true)
  hoisted.subscribe.mockClear()
})

describe('Phase 9 — chain history recovery + incoming detector integration', () => {
  it('cold unlock → scans, persists rows, advances checkpoint, flips state to idle', async () => {
    // WHY: end-to-end happy path. Fresh device (no checkpoint) + unlocked wallet should produce
    // a single scan from the deploy block, surface records in the atom, write the checkpoint,
    // and the banner state should settle on idle once persistence completes.
    hoisted.runHistoryScan.mockResolvedValue(scanResult([
      shieldRecord('a', 100_001, 1_000_000n),
      shieldRecord('b', 100_010, 2_000_000n),
    ], 100_010))
    const store = unlockedStore()
    render(
      <Provider store={store}>
        <Harness />
      </Provider>,
    )
    await waitFor(() => {
      expect(store.get(txListAtom).length).toBe(2)
    })
    expect(hoisted.runHistoryScan).toHaveBeenCalledWith(
      'rg-1', expect.objectContaining({ hubChainId: 31337 }), HUB_DEPLOY_BLOCK,
    )
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
    hoisted.runHistoryScan.mockResolvedValueOnce(scanResult([], null))
    const store = unlockedStore()
    render(
      <Provider store={store}>
        <Harness />
      </Provider>,
    )
    await waitFor(() => {
      expect(hoisted.runHistoryScan).toHaveBeenCalledTimes(1)
    })
    expect(store.get(txListAtom).length).toBe(0)

    // Simulate an incoming transfer: queue the SDK response then fire the balance event.
    hoisted.runHistoryScan.mockResolvedValueOnce(scanResult([
      receiveRecord('rcv-1', 100_005, 5_000_000n),
    ], 100_005))
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
    expect(newRecord.id).toBe('synth:rcv-1:transfer-received')
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

    hoisted.runHistoryScan.mockResolvedValue(scanResult([
      // Same txid as the authored record (sourceTxHash 0xabc). Without dedup we'd see 2 rows.
      shieldRecord('abc', 100_001, 1_000_000n),
      // Unrelated tx. Must synthesize.
      shieldRecord('xyz', 100_002, 2_000_000n),
    ], 100_002))

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
    expect(ids).toContain('synth:xyz:shield')
    expect(ids).not.toContain('synth:abc:shield')
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

    hoisted.runHistoryScan.mockResolvedValue(scanResult([shieldRecord('abc', 100_001, 1_000_000n)], 100_001))

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
    hoisted.runHistoryScan.mockResolvedValue(scanResult([unshieldRecord('burn', 100_001, 1_000_000n)], 100_001))

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

  it('does not synthesize a duplicate Deposit row for a completed cross-chain shield (T-H2)', async () => {
    // WHY (T-H2): a completed shield-xchain stores the hub MINT hash in destTxHash, while
    // sourceTxHash holds the client burn. The SDK surfaces the hub mint as a Shield history item;
    // matching only on sourceTxHash misses the authored record and synthesizes a second, permanent
    // "Deposit" row for the same funds. findExistingByHash must also match destTxHash.
    const completedShieldXchain: TxRecord<'shield-xchain'> = {
      id: '01J-shieldx',
      kind: 'shield-xchain',
      executionState: 'completed',
      stage: 'hub-mint-confirmed',
      stagesCompleted: [
        'build-proof', 'submit-relayer', 'client-burn-confirmed',
        'iris-attestation-pending', 'iris-attestation-ready', 'hub-mint-pending', 'hub-mint-confirmed',
      ],
      updatedSeq: 9,
      createdAt: 1,
      updatedAt: 1,
      meta: { amount: 1_000_000n, feeCacheId: 'fc', fromChainId: 84532 },
      artifacts: {
        sourceTxHash: '0xclientburn' as `0x${string}`,
        destTxHash: '0xhubmint' as `0x${string}`,
      },
      walletContext: { evmAddress: '0xeoa', railgunWalletId: 'rg-1', sourceChainId: 84532 },
    }
    const store = unlockedStore()
    store.set(txListAtom, [completedShieldXchain])
    // The hub mint surfaces as a Shield history item carrying the mint txid → sourceTxHash 0xhubmint.
    hoisted.runHistoryScan.mockResolvedValue(scanResult([shieldRecord('hubmint', 100_001, 1_000_000n)], 100_001))

    render(
      <Provider store={store}>
        <Harness />
      </Provider>,
    )

    await waitFor(() => expect(store.get(historyRecoveryAtom).state).toBe('idle'))

    const list = store.get(txListAtom)
    expect(list.length).toBe(1) // no duplicate synth Deposit row
    expect(list[0]!.id).toBe('01J-shieldx')
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
      expect(hoisted.runHistoryScan).toHaveBeenCalled()
    })
    expect(hoisted.runHistoryScan).toHaveBeenCalledWith('rg-1', expect.anything(), 500_001)
  })
})
