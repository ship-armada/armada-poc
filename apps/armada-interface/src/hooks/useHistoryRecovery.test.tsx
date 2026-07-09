// ABOUTME: Tests for useHistoryRecovery — triggers a scan on unlock, persists synthesized records, advances the checkpoint, is idempotent across re-mounts, and re-runs on epoch bump.
// ABOUTME: Stubs the SDK history call + deployments loaders + tx/storage at the import boundary so no real IDB / SDK runtime is involved.

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
import { historyRecoveryAtom, historyRecoveryEpochAtom } from '@/state/history'

const HUB_DEPLOY_BLOCK = 100_000

const hoisted = vi.hoisted(() => ({
  scanWalletHistory: vi.fn<(walletId: string, fromBlock?: number) => Promise<TransactionHistoryItem[]>>(
    async () => [],
  ),
  putTxIfFresh: vi.fn<(record: unknown) => Promise<boolean>>(async () => true),
  loadDeployments: vi.fn(async () => ({
    hub: { chainId: 31337, deployBlock: HUB_DEPLOY_BLOCK },
    clients: [],
  })),
  loadYieldDeployment: vi.fn(async () => null),
}))

// Replace the SDK call so we feed deterministic fixtures, but keep the mapper logic real.
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

vi.mock('@/config/deployments', () => ({
  loadDeployments: hoisted.loadDeployments,
  loadYieldDeployment: hoisted.loadYieldDeployment,
}))

import { useHistoryRecovery } from './useHistoryRecovery'

function Harness() {
  useHistoryRecovery()
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
    timestamp: 1_700_000_000,
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

function makeStore(opts: { unlocked: boolean }) {
  const store = createStore()
  store.set(shieldedWalletsAtom, {
    'rg-1': {
      id: 'rg-1',
      status: opts.unlocked ? 'unlocked' : 'locked',
      railgunAddress: '0zk-test',
    },
  })
  store.set(activeRailgunWalletIdAtom, opts.unlocked ? 'rg-1' : null)
  return store
}

beforeEach(() => {
  window.localStorage.clear()
  hoisted.scanWalletHistory.mockReset()
  hoisted.scanWalletHistory.mockResolvedValue([])
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
    expect(hoisted.scanWalletHistory).not.toHaveBeenCalled()
    expect(store.get(historyRecoveryAtom).state).toBe('idle')
  })

  it('scans on unlock and writes synthesized records to txListAtom', async () => {
    // WHY: this is the primary use case — empty IDB on a fresh device, the SDK returns the
    // wallet's chain history, we mirror it into the activity feed.
    hoisted.scanWalletHistory.mockResolvedValue([
      shieldItem('txA', 100_001, 1_000_000n),
      shieldItem('txB', 100_002, 2_000_000n),
    ])
    const store = makeStore({ unlocked: true })
    render(
      <Provider store={store}>
        <Harness />
      </Provider>,
    )
    await waitFor(() => {
      expect(store.get(txListAtom).length).toBe(2)
    })
    expect(hoisted.scanWalletHistory).toHaveBeenCalledTimes(1)
    // First-ever scan uses the hub deploy block as the floor.
    expect(hoisted.scanWalletHistory).toHaveBeenCalledWith('rg-1', HUB_DEPLOY_BLOCK)
    expect(store.get(historyRecoveryAtom).state).toBe('idle')
    expect(store.get(historyRecoveryAtom).lastRecordCount).toBe(2)
  })

  it('persists checkpoint at the highest block scanned', async () => {
    // WHY: the next scan must resume past `highest + 1`. A missing checkpoint means we re-walk
    // the full hub-deploy-onward history every unlock — wasteful but correct. An incorrect
    // checkpoint (e.g. min instead of max) would silently skip rows.
    hoisted.scanWalletHistory.mockResolvedValue([
      shieldItem('a', 100_001, 1n),
      shieldItem('b', 100_005, 2n),
      shieldItem('c', 100_003, 3n),
    ])
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
      expect(hoisted.scanWalletHistory).toHaveBeenCalled()
    })
    expect(hoisted.scanWalletHistory).toHaveBeenCalledWith('rg-1', 200_001)
  })

  it('re-runs the scan when historyRecoveryEpochAtom bumps', async () => {
    // WHY: Settings "Re-scan history" must force a fresh scan within the same session. The
    // ref-based dedup must allow epoch changes through.
    hoisted.scanWalletHistory.mockResolvedValue([])
    const store = makeStore({ unlocked: true })
    render(
      <Provider store={store}>
        <Harness />
      </Provider>,
    )
    await waitFor(() => {
      expect(hoisted.scanWalletHistory).toHaveBeenCalledTimes(1)
    })
    await act(async () => {
      store.set(historyRecoveryEpochAtom, 1)
    })
    await waitFor(() => {
      expect(hoisted.scanWalletHistory).toHaveBeenCalledTimes(2)
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
      walletContext: { evmAddress: '0xabc', railgunWalletId: 'rg-1', sourceChainId: 31337 },
    }])
    hoisted.scanWalletHistory.mockResolvedValue([
      // Same txid as the authored record — must be skipped.
      shieldItem('abc123', 100_001, 1_000_000n),
      // Different tx — must be synthesized.
      shieldItem('def456', 100_002, 2_000_000n),
    ])
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
    expect(ids).toContain('synth:def456:ShieldERC20s')
    expect(ids).not.toContain('synth:abc123:ShieldERC20s')
  })

  it('flips state to "failed" with the error message when the SDK throws', async () => {
    // WHY: the banner reads `state === 'failed'` to surface a retry CTA. A silent failure
    // would leave the user staring at an empty activity feed with no signal.
    hoisted.scanWalletHistory.mockRejectedValue(new Error('rpc unreachable'))
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
