// ABOUTME: Unit test for sdk-read's syncTracked — asserts each wallet.sync() emits an sdk.sync
// ABOUTME: telemetry line carrying the exact resume window, so resume-vs-rescan stays observable.

import { describe, it, expect, vi, beforeEach } from 'vitest'

// Stub the heavy @armada/sdk value imports so importing sdk-read doesn't pull the SDK/wasm into the
// test — syncTracked only needs the wallet's `sync()` return, not any real SDK runtime. `createArmadaSdk`
// + `LocalSigner` are also exercised by the ensureInstance concurrency test below.
vi.mock('@armada/sdk', () => ({
  createArmadaSdk: vi.fn(),
  IndexedDBStorageAdapter: class {},
  LocalSigner: { fromRootSecret: vi.fn(async () => ({})) },
  getTokenDataERC20: vi.fn(),
  getTokenDataHash: vi.fn(),
}))
vi.mock('@/lib/telemetry', () => ({ track: vi.fn() }))
// Mocks the ensureInstance path needs: a real keyManager throws when locked, and real deployments are
// null in the test → both would block instance creation.
vi.mock('./keyManager', () => ({
  getShieldedAddress: () => '0zktest',
  getRootSecret: () => new Uint8Array(32),
  getCreationBlock: () => 0,
}))
vi.mock('../../config/deployments', () => ({
  getCachedDeployments: () => ({
    hub: { contracts: { privacyPool: '0x0000000000000000000000000000000000000001' }, deployBlock: 100 },
  }),
  getUsdcAddress: () => '0x0000000000000000000000000000000000000002',
  loadYieldDeployment: async () => null,
}))
vi.mock('../../config/network', () => ({
  getNetworkConfig: () => ({
    hub: { chainId: 31337, rpcUrls: ['http://localhost:8545'] },
    confirmationDepth: 0,
    finalityThreshold: 0,
    indexerUrl: null,
  }),
}))

import { syncTracked, getSdkWallet, closeSdkRead } from './sdk-read'
import { track } from '@/lib/telemetry'
import { createArmadaSdk } from '@armada/sdk'

describe('syncTracked', () => {
  it('emits sdk.sync with the exact { fromBlock, syncedThrough, scanned } sync returned', async () => {
    // WHY: fromBlock and syncedThrough are both numbers, so a field swap wouldn't be caught by
    // types — but it would make the resume-vs-rescan signal lie. Pin the mapping.
    const wallet = { sync: vi.fn(async () => ({ fromBlock: 501, syncedThrough: 520, scanned: true })) }
    await syncTracked(wallet)
    expect(track).toHaveBeenCalledWith('sdk.sync', {
      fromBlock: 501,
      syncedThrough: 520,
      scanned: true,
    })
  })

  it('reports scanned:false for a no-op sync (head not advanced past the checkpoint)', async () => {
    // WHY: the cheap-path signal — a warm reload with no new blocks. fromBlock stays checkpoint+1.
    const wallet = { sync: vi.fn(async () => ({ fromBlock: 521, syncedThrough: 520, scanned: false })) }
    await syncTracked(wallet)
    expect(track).toHaveBeenCalledWith('sdk.sync', {
      fromBlock: 521,
      syncedThrough: 520,
      scanned: false,
    })
  })

  it('serializes concurrent syncs — wallet.sync() never overlaps', async () => {
    // WHY: the SDK's sync() has no in-flight guard; two concurrent scans would double-apply the same
    // events and corrupt the scan state. syncTracked chains them so at most one runs at a time.
    let active = 0
    let maxConcurrent = 0
    const wallet = {
      sync: vi.fn(async () => {
        active += 1
        maxConcurrent = Math.max(maxConcurrent, active)
        await new Promise((resolve) => setTimeout(resolve, 5))
        active -= 1
        return { fromBlock: 1, syncedThrough: 2, scanned: true }
      }),
    }
    await Promise.all([syncTracked(wallet), syncTracked(wallet), syncTracked(wallet)])
    expect(maxConcurrent).toBe(1)
    expect(wallet.sync).toHaveBeenCalledTimes(3)
  })

  it('a failing sync does not wedge the chain for later callers', async () => {
    const wallet = {
      sync: vi
        .fn()
        .mockRejectedValueOnce(new Error('rpc down'))
        .mockResolvedValueOnce({ fromBlock: 1, syncedThrough: 2, scanned: true }),
    }
    await expect(syncTracked(wallet)).rejects.toThrow('rpc down')
    // The next caller still runs (the chain caught the rejection).
    await expect(syncTracked(wallet)).resolves.toBeUndefined()
    expect(wallet.sync).toHaveBeenCalledTimes(2)
  })
})

describe('ensureInstance — concurrency guard (getSdkWallet)', () => {
  beforeEach(async () => {
    await closeSdkRead() // reset the module singleton + any in-flight build between tests
    const fakeWallet = { on: vi.fn() }
    const fakeSdk = { wallet: { fromRootSecret: vi.fn(async () => fakeWallet) }, close: vi.fn(async () => {}) }
    vi.mocked(createArmadaSdk).mockReset()
    // A deliberately slow build so the concurrent callers genuinely overlap during creation — the exact
    // window the in-flight guard closes.
    vi.mocked(createArmadaSdk).mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5))
      return fakeSdk as unknown as Awaited<ReturnType<typeof createArmadaSdk>>
    })
  })

  it('coalesces concurrent unlock-time callers onto a SINGLE SDK instance', async () => {
    // WHY: on unlock the initial scan + sync poll + the balance reads + history recovery all call
    // ensureInstance near-simultaneously. Without the guard each builds its own SDK instance against the
    // same IndexedDB DB, and the concurrent wallets clobber each other's scan state — the observed
    // "dashboard balance reads 0 until a later sync." The guard must fold them onto one build.
    const [a, b, c] = await Promise.all([getSdkWallet(), getSdkWallet(), getSdkWallet()])
    expect(createArmadaSdk).toHaveBeenCalledTimes(1)
    expect(a).toBe(b)
    expect(b).toBe(c)
  })

  it('rebuilds after closeSdkRead — a fresh unlock creates a new instance', async () => {
    await getSdkWallet()
    expect(createArmadaSdk).toHaveBeenCalledTimes(1)
    await closeSdkRead()
    await getSdkWallet()
    expect(createArmadaSdk).toHaveBeenCalledTimes(2)
  })
})
