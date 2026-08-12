// ABOUTME: Tests for useHistoryRecovery — triggers a scan on unlock, persists synthesized records, advances the checkpoint, is idempotent across re-mounts, and re-runs on epoch bump.
// ABOUTME: Stubs runHistoryScan + deployments loader + tx/storage at the import boundary so no real IDB / SDK runtime is involved; fixtures are built with the real historyEntryToTxRecord mapper.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, waitFor, act } from '@testing-library/react'
import { Provider, createStore } from 'jotai'
import {
  activeShieldedWalletIdAtom,
  shieldedWalletsAtom,
} from '@/state/wallet'
import { txListAtom } from '@/state/tx'
import { historyRecoveryAtom, historyRecoveryEpochAtom } from '@/state/history'
import type { TxRecord } from '@/lib/tx/types'
import type { HistoryScanResult } from '@/lib/shielded/history'

const HUB_DEPLOY_BLOCK = 100_000

const hoisted = vi.hoisted(() => ({
  runHistoryScan: vi.fn(async (): Promise<HistoryScanResult> => ({
    records: [],
    highestBlock: null,
    itemCount: 0,
  })),
  putTxIfFresh: vi.fn<(record: unknown) => Promise<boolean>>(async () => true),
  loadDeployments: vi.fn(async () => ({
    hub: { chainId: 31337, deployBlock: HUB_DEPLOY_BLOCK },
    clients: [],
  })),
}))

// Replace the scan entry point so we feed deterministic HistoryScanResults, but keep the real
// historyEntryToTxRecord mapper for building fixtures (so ids + sourceTxHash are authentic).
vi.mock('@/lib/shielded/history', async () => {
  const actual = await vi.importActual<typeof import('@/lib/shielded/history')>(
    '@/lib/shielded/history',
  )
  return { ...actual, runHistoryScan: hoisted.runHistoryScan }
})

vi.mock('@/lib/tx/storage', () => ({
  putTxIfFresh: hoisted.putTxIfFresh,
  putTx: vi.fn(async () => {}),
  deleteTx: vi.fn(async () => {}),
  loadAllTx: vi.fn(async () => []),
}))

vi.mock('@/config/deployments', () => ({
  loadDeployments: hoisted.loadDeployments,
}))

import { useHistoryRecovery } from './useHistoryRecovery'
import { historyEntryToTxRecord } from '@/lib/shielded/history'

function Harness() {
  useHistoryRecovery()
  return null
}

/** Build a synthesized shield TxRecord via the real SDK mapper — `txid` drives id + sourceTxHash. */
function shieldRecord(txid: string, blockNumber: number, amount: bigint): TxRecord {
  return historyEntryToTxRecord(
    { txid, blockNumber, category: 'shield', tokenAddress: '0xusdc', value: amount },
    'rg-1',
    { hubChainId: 31337 },
    1_700_000_000_000,
  )!
}

function scanResult(records: TxRecord[], highestBlock: number | null): HistoryScanResult {
  return { records, highestBlock, itemCount: records.length }
}

function makeStore(opts: { unlocked: boolean }) {
  const store = createStore()
  store.set(shieldedWalletsAtom, {
    'rg-1': {
      id: 'rg-1',
      status: opts.unlocked ? 'unlocked' : 'locked',
      shieldedAddress: '0zk-test',
    },
  })
  store.set(activeShieldedWalletIdAtom, opts.unlocked ? 'rg-1' : null)
  return store
}

beforeEach(() => {
  window.localStorage.clear()
  hoisted.runHistoryScan.mockReset()
  hoisted.runHistoryScan.mockResolvedValue(scanResult([], null))
  hoisted.putTxIfFresh.mockReset()
  hoisted.putTxIfFresh.mockResolvedValue(true)
})

describe('useHistoryRecovery', () => {
  it('does not scan when the wallet is locked', async () => {
    const store = makeStore({ unlocked: false })
    render(
      <Provider store={store}>
        <Harness />
      </Provider>,
    )
    // Give microtasks a chance to flush — there's no scan, so nothing to wait on.
    await Promise.resolve()
    expect(hoisted.runHistoryScan).not.toHaveBeenCalled()
    expect(store.get(historyRecoveryAtom).state).toBe('idle')
  })

  it('scans on unlock and writes synthesized records to txListAtom', async () => {
    // WHY: this is the primary use case — empty IDB on a fresh device, the SDK returns the
    // wallet's chain history, we mirror it into the activity feed.
    hoisted.runHistoryScan.mockResolvedValue(scanResult([
      shieldRecord('txA', 100_001, 1_000_000n),
      shieldRecord('txB', 100_002, 2_000_000n),
    ], 100_002))
    const store = makeStore({ unlocked: true })
    render(
      <Provider store={store}>
        <Harness />
      </Provider>,
    )
    await waitFor(() => {
      expect(store.get(txListAtom).length).toBe(2)
    })
    expect(hoisted.runHistoryScan).toHaveBeenCalledTimes(1)
    // First-ever scan uses the hub deploy block as the floor.
    expect(hoisted.runHistoryScan).toHaveBeenCalledWith(
      'rg-1',
      expect.objectContaining({ hubChainId: 31337 }),
      HUB_DEPLOY_BLOCK,
    )
    expect(store.get(historyRecoveryAtom).state).toBe('idle')
    expect(store.get(historyRecoveryAtom).lastRecordCount).toBe(2)
  })

  it('persists checkpoint at the highest block scanned', async () => {
    // WHY: the next scan must resume past `highest + 1`. The hook persists the scan's
    // `highestBlock` verbatim as the checkpoint; a missing checkpoint means we re-walk the full
    // hub-deploy-onward history every unlock — wasteful but correct. (The max-block computation
    // itself is covered by runHistoryScan's own unit test.)
    hoisted.runHistoryScan.mockResolvedValue(scanResult([
      shieldRecord('a', 100_001, 1n),
      shieldRecord('b', 100_005, 2n),
      shieldRecord('c', 100_003, 3n),
    ], 100_005))
    const store = makeStore({ unlocked: true })
    render(
      <Provider store={store}>
        <Harness />
      </Provider>,
    )
    await waitFor(() => {
      expect(store.get(txListAtom).length).toBe(3)
    })
    const checkpointRaw = window.localStorage.getItem('armada.shielded.historyScanBlock.rg-1')
    expect(checkpointRaw).not.toBeNull()
    const cp = JSON.parse(checkpointRaw!) as { block: number; scannedAt: number }
    expect(cp.block).toBe(100_005)
  })

  it('uses checkpoint + 1 as fromBlock on subsequent scans', async () => {
    // WHY: incremental scans skip already-processed blocks. Off-by-one would either re-process
    // (waste) or skip (data loss); we want strict "everything after the last seen".
    window.localStorage.setItem(
      'armada.shielded.historyScanBlock.rg-1',
      JSON.stringify({ block: 200_000, scannedAt: 1 }),
    )
    const store = makeStore({ unlocked: true })
    render(
      <Provider store={store}>
        <Harness />
      </Provider>,
    )
    await waitFor(() => {
      expect(hoisted.runHistoryScan).toHaveBeenCalled()
    })
    expect(hoisted.runHistoryScan).toHaveBeenCalledWith('rg-1', expect.anything(), 200_001)
  })

  it('re-runs the scan when historyRecoveryEpochAtom bumps', async () => {
    // WHY: Settings "Re-scan history" must force a fresh scan within the same session. The
    // ref-based dedup must allow epoch changes through.
    hoisted.runHistoryScan.mockResolvedValue(scanResult([], null))
    const store = makeStore({ unlocked: true })
    render(
      <Provider store={store}>
        <Harness />
      </Provider>,
    )
    await waitFor(() => {
      expect(hoisted.runHistoryScan).toHaveBeenCalledTimes(1)
    })
    await act(async () => {
      store.set(historyRecoveryEpochAtom, 1)
    })
    await waitFor(() => {
      expect(hoisted.runHistoryScan).toHaveBeenCalledTimes(2)
    })
  })

  it('skips synthesizing rows for txHashes already represented by an authored record', async () => {
    // WHY: this is the dedup invariant. When the user submits a shield, useTx writes a real
    // record with `artifacts.sourceTxHash` set. When the SDK later returns the same tx in its
    // history sweep, mapping it would create a synthetic row beside the authored one — two
    // entries for one event. The authored row carries the full lifecycle / fee breakdown; the
    // synthetic row would be lossy. We keep the authored, drop the synth.
    const AUTHORED_HASH = '0xabc123'
    const store = makeStore({ unlocked: true })
    // Seed an authored record for the same tx the SDK will return.
    store.set(txListAtom, [{
      id: '01J-authored',
      kind: 'shield',
      executionState: 'completed',
      stage: 'hub-confirmed',
      stagesCompleted: ['build-proof', 'submit-relayer', 'hub-confirmed'],
      updatedSeq: 5,
      createdAt: 1,
      updatedAt: 1,
      meta: { amount: 1_000_000n, feeCacheId: 'fc', fromChainId: 31337 },
      artifacts: { sourceTxHash: AUTHORED_HASH as `0x${string}` },
      walletContext: { evmAddress: '0xabc', shieldedWalletId: 'rg-1', sourceChainId: 31337 },
    }])
    hoisted.runHistoryScan.mockResolvedValue(scanResult([
      // Same txid as the authored record (sourceTxHash 0xabc123) — must be skipped.
      shieldRecord('abc123', 100_001, 1_000_000n),
      // Different tx — must be synthesized.
      shieldRecord('def456', 100_002, 2_000_000n),
    ], 100_002))
    render(
      <Provider store={store}>
        <Harness />
      </Provider>,
    )
    await waitFor(() => {
      // Original authored + one new synth = 2. Without the guard we'd get 3.
      expect(store.get(txListAtom).length).toBe(2)
    })
    const ids = store.get(txListAtom).map(r => r.id).sort()
    expect(ids).toContain('01J-authored')
    expect(ids).toContain('synth:def456:shield')
    expect(ids).not.toContain('synth:abc123:shield')
  })

  it('flips state to "failed" with the error message when the SDK throws', async () => {
    // WHY: the banner reads `state === 'failed'` to surface a retry CTA. A silent failure
    // would leave the user staring at an empty activity feed with no signal.
    hoisted.runHistoryScan.mockRejectedValue(new Error('rpc unreachable'))
    const store = makeStore({ unlocked: true })
    render(
      <Provider store={store}>
        <Harness />
      </Provider>,
    )
    await waitFor(() => {
      expect(store.get(historyRecoveryAtom).state).toBe('failed')
    })
    expect(store.get(historyRecoveryAtom).error).toMatch(/rpc unreachable/)
  })
})
