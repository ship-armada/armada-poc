// ABOUTME: Tests the engine bootstrap — that initRailgunEngine boots via RailgunEngine.initForWallet + setEngine (not the startRailgunEngine convenience).
// ABOUTME: The setEngine seam is what keeps every other wallet-SDK convenience (balances, wallet lifecycle) working against our engine.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { getDefaultStore } from 'jotai'
import { syncStateAtom } from '@/state/wallet'

// ─── Hoisted SDK mocks (dynamic-import boundary inside init.ts) ───────────────
const hoisted = vi.hoisted(() => {
  const engineInstance = {
    __brand: 'engine' as const,
    wallets: {} as Record<string, unknown>,
    on: vi.fn(),
    emitScanEventHistoryComplete: vi.fn(),
  }
  return {
    engineInstance,
    initForWallet: vi.fn(async () => engineInstance),
    setEngine: vi.fn(),
    setLoggers: vi.fn(),
    setOnUTXOMerkletreeScanCallback: vi.fn(),
    onBalancesUpdate: vi.fn(async () => {}),
    overrideArtifact: vi.fn(),
    startRailgunEngine: vi.fn(async () => {}),
    poiInit: vi.fn(),
  }
})

vi.mock('@railgun-community/wallet', () => ({
  setEngine: hoisted.setEngine,
  setLoggers: hoisted.setLoggers,
  setOnUTXOMerkletreeScanCallback: hoisted.setOnUTXOMerkletreeScanCallback,
  onBalancesUpdate: hoisted.onBalancesUpdate,
  overrideArtifact: hoisted.overrideArtifact,
  // Present so a regression that still calls the convenience path is detectable.
  startRailgunEngine: hoisted.startRailgunEngine,
}))

vi.mock('@railgun-community/engine', () => ({
  RailgunEngine: { initForWallet: hoisted.initForWallet },
  POI: { init: hoisted.poiInit },
  EngineEvent: { UTXOScanDecryptBalancesComplete: 'UTXOScanDecryptBalancesComplete' },
}))

vi.mock('@railgun-community/shared-models', () => ({
  MerkletreeScanStatus: {
    Started: 'Started',
    Updated: 'Updated',
    Complete: 'Complete',
    Incomplete: 'Incomplete',
  },
}))

vi.mock('./database', () => ({
  createWebDatabase: vi.fn(() => ({ __brand: 'db' })),
}))

vi.mock('./prover', () => ({
  initializeProver: vi.fn(async () => {}),
}))

vi.mock('@/lib/telemetry', () => ({
  trackError: vi.fn(),
}))

import {
  initRailgunEngine,
  getEngineState,
  subscribeEngineState,
  resetInitState,
} from './init'

beforeEach(() => {
  // Skip the DEV-only Armada circuit fetch (loadArmadaCircuits) — that wiring is covered by
  // artifacts.test.ts; here we exercise only the engine-construction seam. Under vitest DEV
  // defaults to true, which would fire relative-URL /api/circuits fetches that node's fetch rejects.
  vi.stubEnv('DEV', false)
  resetInitState()
  getDefaultStore().set(syncStateAtom, { status: 'idle', progress: 0 })
  hoisted.engineInstance.wallets = {}
  hoisted.engineInstance.on.mockClear()
  hoisted.engineInstance.emitScanEventHistoryComplete.mockClear()
  hoisted.initForWallet.mockClear()
  hoisted.setEngine.mockClear()
  hoisted.setOnUTXOMerkletreeScanCallback.mockClear()
  hoisted.onBalancesUpdate.mockClear()
  hoisted.startRailgunEngine.mockClear()
  hoisted.poiInit.mockClear()
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('initRailgunEngine (engine-port)', () => {
  it('boots via RailgunEngine.initForWallet and NOT the startRailgunEngine convenience', async () => {
    await initRailgunEngine()

    expect(hoisted.initForWallet).toHaveBeenCalledTimes(1)
    expect(hoisted.startRailgunEngine).not.toHaveBeenCalled()
  })

  it('registers the constructed engine via setEngine so the wallet-SDK seam holds', async () => {
    await initRailgunEngine()

    expect(hoisted.setEngine).toHaveBeenCalledTimes(1)
    expect(hoisted.setEngine).toHaveBeenCalledWith(hoisted.engineInstance)
  })

  it('passes an ArtifactGetter as arg 3 and a quick-sync callback as arg 4', async () => {
    await initRailgunEngine()

    const args = hoisted.initForWallet.mock.calls[0]!
    const artifactGetter = args[2] as { getArtifacts: unknown; getArtifactsPOI: unknown; assertArtifactExists: unknown }
    expect(typeof artifactGetter.getArtifacts).toBe('function')
    expect(typeof artifactGetter.getArtifactsPOI).toBe('function')
    expect(typeof artifactGetter.assertArtifactExists).toBe('function')
    expect(typeof args[3]).toBe('function') // quickSyncEvents callback
    expect(args[8]).toBe(false) // skipMerkletreeScans stays false
  })

  it('wires the balance-complete listener so balances populate + scan-complete fires (R4)', async () => {
    hoisted.engineInstance.wallets = { w1: { id: 'w1' }, w2: { id: 'w2' } }
    await initRailgunEngine()

    // Listener registered for the decrypt-balances-complete engine event.
    const onCall = hoisted.engineInstance.on.mock.calls.find(
      (c) => c[0] === 'UTXOScanDecryptBalancesComplete',
    )
    expect(onCall).toBeDefined()

    // Firing it recomputes every wallet's balance and emits scan-complete.
    const listener = onCall![1] as (e: unknown) => void
    listener({ txidVersion: 'V2', chain: { type: 0, id: 31337 }, walletIdFilter: undefined })
    await Promise.resolve()
    await Promise.resolve()

    expect(hoisted.onBalancesUpdate).toHaveBeenCalledTimes(2)
    expect(hoisted.engineInstance.emitScanEventHistoryComplete).toHaveBeenCalledWith('V2', {
      type: 0,
      id: 31337,
    })
  })

  it('drives engine state cold → warming → ready', async () => {
    const seen: string[] = []
    const unsub = subscribeEngineState((s) => seen.push(s.state))
    await initRailgunEngine()
    unsub()

    expect(getEngineState().state).toBe('ready')
    expect(seen).toContain('warming')
    expect(seen[seen.length - 1]).toBe('ready')
  })

  it('maps an Incomplete scan → syncStateAtom failed (WI-4: a merkleroot mismatch surfaces as Incomplete → spend gate blocks)', async () => {
    await initRailgunEngine()
    const scanCb = hoisted.setOnUTXOMerkletreeScanCallback.mock.calls[0]![0] as (e: {
      scanStatus: string
      progress?: number
    }) => void

    // The engine emits Incomplete when a rebuilt tree root fails on-chain rootHistory validation
    // (railgun-engine.js scanUTXOHistory: throw 'Invalid merkleroot' → catch emits Incomplete).
    scanCb({ scanStatus: 'Incomplete', progress: 0.4 })

    expect(getDefaultStore().get(syncStateAtom).status).toBe('failed')
  })

  it('marks state failed when initForWallet throws', async () => {
    hoisted.initForWallet.mockRejectedValueOnce(new Error('boom'))
    await expect(initRailgunEngine()).rejects.toThrow('boom')
    expect(getEngineState().state).toBe('failed')
  })
})
