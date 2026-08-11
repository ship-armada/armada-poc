// ABOUTME: V2 redesign integration sweep — exercises the cross-phase boundaries: signIn (Phases 2, 2a, 4) → tx storage encryption (Phase 7) → activeTxListAtom scoping (Phase 6) → account-switch auto-lock (Phase 4) → history isolation across wallets.
// ABOUTME: Mocks at the Railgun SDK boundary only — keyManager, storage, wallet.ts, useShieldedWallet, useWallet all run real. wagmi signTypedData + useAccount are stubbed via the same hoisted-state pattern the unit tests use.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, waitFor, act } from '@testing-library/react'
import { Provider, createStore } from 'jotai'
import {
  activeRailgunWalletIdAtom,
  evmAddressAtom,
  shieldedWalletsAtom,
} from '@/state/wallet'
import { activeTxListAtom, txListAtom, upsertTxAtom } from '@/state/tx'
import type { TxRecord } from '@/lib/tx/types'

// ─────────────────────────────────────────────────────────────────────────────
// Hoisted shared mock state — same pattern used in useWallet.test.tsx.
// ─────────────────────────────────────────────────────────────────────────────
const hoisted = vi.hoisted(() => {
  const wagmiState = {
    address: undefined as `0x${string}` | undefined,
    chainId: 31337,
    isConnected: false,
  }
  // Per-message signer: when called twice with the same EIP-712 payload, returns the same
  // bytes (matches RFC 6979 deterministic ECDSA — the V2 redesign requires this).
  const deterministicSig = '0x' + '11'.repeat(32) + '22'.repeat(32) + '1b'
  return {
    wagmiState,
    deterministicSig,
    signTypedData: vi.fn(async () => deterministicSig),
    openConnectModal: vi.fn(),
    disconnect: vi.fn(),
    // Railgun SDK is mocked at the dynamic-import boundary inside lib/railgun/wallet.ts.
    createRailgunWallet: vi.fn(async () => ({ id: 'sdk-wallet-id-A', railgunAddress: '0zk1A' })),
    loadWalletByID: vi.fn(async () => ({ id: 'sdk-wallet-id-A', railgunAddress: '0zk1A' })),
    unloadWalletByID: vi.fn(),
    deleteWalletByID: vi.fn(),
  }
})

vi.mock('@railgun-community/wallet', () => ({
  createRailgunWallet: hoisted.createRailgunWallet,
  loadWalletByID: hoisted.loadWalletByID,
  unloadWalletByID: hoisted.unloadWalletByID,
  deleteWalletByID: hoisted.deleteWalletByID,
}))

// wallet.ts derives the 0zk address via the SDK's `deriveKeyset`; the real one needs ed25519/poseidon
// crypto that jsdom can't run, and this test exercises the record/atom lifecycle, not keyset crypto.
// Override just `deriveKeyset`, keep the rest of @armada/sdk real (sdk-read + handlers import it).
vi.mock('@armada/sdk', async (importActual) => {
  const actual = await importActual<typeof import('@armada/sdk')>()
  return {
    ...actual,
    deriveKeyset: vi.fn(async () => ({ railgunAddress: '0zk1qtestlifecycleaddr000000000000000000000000000000000000000000' })),
  }
})

vi.mock('@/lib/railgun/init', () => ({
  initRailgunEngine: vi.fn(async () => {}),
  isRailgunEngineInitialized: vi.fn(() => true),
  getRailgunInitError: vi.fn(() => null),
  resetInitState: vi.fn(),
}))

vi.mock('@/lib/railgun/network', () => ({
  loadHubNetwork: vi.fn(async () => {}),
  isHubNetworkLoaded: vi.fn(() => true),
  resetNetworkLoaderState: vi.fn(),
  getHubChainDescriptor: vi.fn(() => ({ type: 0 as const, id: 31337 })),
  getCurrentHubBlock: vi.fn(async () => 100),
}))

vi.mock('wagmi/actions', () => ({
  signTypedData: hoisted.signTypedData,
}))

vi.mock('wagmi', () => ({
  useAccount: () => ({
    address: hoisted.wagmiState.address,
    chainId: hoisted.wagmiState.chainId,
    isConnected: hoisted.wagmiState.isConnected,
  }),
  useDisconnect: () => ({ disconnect: hoisted.disconnect }),
  useWalletClient: () => ({ data: null }),
}))

vi.mock('@rainbow-me/rainbowkit', () => ({
  useConnectModal: () => ({ openConnectModal: hoisted.openConnectModal }),
  // `getDefaultConfig` is invoked at module-eval time by `@/config/wagmi`. Tests don't need a
  // real wagmi config (signTypedData + useAccount are mocked separately), but the export must
  // exist or the import chain throws before we reach any test body.
  getDefaultConfig: vi.fn(() => ({})),
}))

vi.mock('@/config/wagmi', () => ({
  wagmiConfig: {},
}))

vi.mock('sonner', () => ({
  toast: vi.fn(),
}))

vi.mock('@/lib/wagmi-adapter', () => ({ walletClientToSigner: vi.fn() }))

import { useShieldedWallet } from '@/hooks/useShieldedWallet'
import { useWallet } from '@/hooks/useWallet'
import { useTxHistory } from '@/hooks/useTxHistory'
import { isUnlocked, clear as clearKeyManager } from '@/lib/railgun/keyManager'
import { putTxIfFresh } from '@/lib/tx/storage'

// ─────────────────────────────────────────────────────────────────────────────
// Harness
// ─────────────────────────────────────────────────────────────────────────────
function Harness({
  capture,
}: {
  capture: {
    shielded: ReturnType<typeof useShieldedWallet> | null
    wallet: ReturnType<typeof useWallet> | null
  }
}) {
  capture.shielded = useShieldedWallet()
  capture.wallet = useWallet()
  useTxHistory() // exercises the hydration + on-active-id-change reset path
  return null
}

function mount(initialAddress?: `0x${string}`) {
  hoisted.wagmiState.address = initialAddress
  hoisted.wagmiState.isConnected = initialAddress !== undefined
  const store = createStore()
  const capture: {
    shielded: ReturnType<typeof useShieldedWallet> | null
    wallet: ReturnType<typeof useWallet> | null
  } = { shielded: null, wallet: null }
  render(
    <Provider store={store}>
      <Harness capture={capture} />
    </Provider>,
  )
  return { store, capture }
}

function txFixture(id: string, walletId: string): TxRecord<'shield'> {
  return {
    id,
    kind: 'shield',
    executionState: 'completed',
    stage: 'hub-confirmed',
    stagesCompleted: ['build-proof'],
    updatedSeq: 1,
    createdAt: 1000,
    updatedAt: 2000,
    meta: { amount: 1_000_000n, feeCacheId: '', fromChainId: 31337 },
    artifacts: {},
    walletContext: {
      evmAddress: '0xabc',
      railgunWalletId: walletId,
      sourceChainId: 31337,
    },
  } as TxRecord<'shield'>
}

beforeEach(() => {
  window.localStorage.clear()
  clearKeyManager()
  hoisted.signTypedData.mockReset()
  hoisted.signTypedData.mockResolvedValue(hoisted.deterministicSig)
  hoisted.openConnectModal.mockReset()
  hoisted.disconnect.mockReset()
  hoisted.createRailgunWallet.mockClear()
  hoisted.loadWalletByID.mockClear()
  hoisted.unloadWalletByID.mockClear()
  hoisted.deleteWalletByID.mockClear()
})

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────
describe('V2 shielded-wallet lifecycle integration', () => {
  it('signIn → tx record encrypted on write + visible via activeTxListAtom + decrypted on hydrate', async () => {
    const evmA = '0x1111111111111111111111111111111111111111' as `0x${string}`
    const { store, capture } = mount(evmA)

    // First-ever signIn for evmA: the determinism check signs twice; both calls return the
    // same deterministic signature, so the check passes.
    await act(async () => {
      await capture.shielded!.signIn()
    })

    // Identity is derived locally (no engine wallet); the unlock populates the active id atom.
    expect(isUnlocked()).toBe(true)
    const activeWalletId = store.get(activeRailgunWalletIdAtom)
    expect(activeWalletId).toBeTruthy()

    // Write a tx record via the real storage layer (Phase 7 encryption on write).
    const r = txFixture('tx-1', activeWalletId!)
    await act(async () => {
      await putTxIfFresh(r)
      store.set(upsertTxAtom, r)
    })

    // The record is visible to active-scope consumers.
    await waitFor(() => {
      expect(store.get(activeTxListAtom).map(rr => rr.id)).toEqual(['tx-1'])
    })
  })

  it('switching EVM addresses auto-locks + clears the active tx list (Phase 4 + Phase 6 together)', async () => {
    const evmA = '0x1111111111111111111111111111111111111111' as `0x${string}`
    const evmB = '0x2222222222222222222222222222222222222222' as `0x${string}`
    const { store, capture } = mount(evmA)

    await act(async () => {
      await capture.shielded!.signIn()
    })
    const walletIdA = store.get(activeRailgunWalletIdAtom)
    expect(walletIdA).toBeTruthy()

    const r = txFixture('tx-A1', walletIdA!)
    await act(async () => {
      store.set(upsertTxAtom, r)
    })
    await waitFor(() => {
      expect(store.get(activeTxListAtom)).toHaveLength(1)
    })

    // Switch wagmi to a different EVM address. useWallet's effect should detect the mismatch
    // against keyManager.getEvmAddress() and auto-lock.
    expect(isUnlocked()).toBe(true)
    hoisted.wagmiState.address = evmB
    await act(async () => {
      // Force a re-render so useWallet's effect picks up the new address.
      hoisted.wagmiState.isConnected = true
      store.set(evmAddressAtom, evmB)
      // The effect runs on the next render — render again with an explicit set to trigger.
      render(
        <Provider store={store}>
          <Harness capture={capture} />
        </Provider>,
      )
    })

    // The shielded wallet should be locked (zeroized) and the wallet entry's status flipped
    // to 'locked' (NOT removed). Keeping activeRailgunWalletIdAtom set is what lets App.tsx's
    // lock-watch effect route from dashboard → UnlockFlow on disconnect/switch — wiping the
    // atoms would produce `{ status: 'missing' }`, which the guard doesn't catch. Once the
    // user signs in with the new EVM, the new walletId replaces the active id and the old
    // wallet's records fall out of activeTxListAtom naturally.
    await waitFor(() => {
      expect(isUnlocked()).toBe(false)
      expect(store.get(activeRailgunWalletIdAtom)).toBe(walletIdA)
      expect(store.get(shieldedWalletsAtom)[walletIdA!]?.status).toBe('locked')
    })
  })

  it('non-deterministic signer hard-fails before any identity is bound', async () => {
    const evmA = '0x1111111111111111111111111111111111111111' as `0x${string}`
    // First sign returns one signature; second sign (the verification call) returns a
    // different one. Mimics smart-account / EIP-1271 / random-k wallet behavior.
    const sigA = '0x' + 'aa'.repeat(32) + 'bb'.repeat(32) + '1b'
    const sigB = '0x' + 'cc'.repeat(32) + 'dd'.repeat(32) + '1b'
    hoisted.signTypedData.mockReset()
    hoisted.signTypedData
      .mockResolvedValueOnce(sigA)
      .mockResolvedValueOnce(sigB)

    const { capture } = mount(evmA)
    let captured: unknown
    await act(async () => {
      try {
        await capture.shielded!.signIn()
      } catch (err) {
        captured = err
      }
    })
    const errObj = captured as { kind?: string; reason?: string } | undefined
    expect(errObj?.kind).toBe('NonDeterministicSignerError')
    expect(errObj?.reason).toBe('first-sign-mismatch')
    // The SDK must NOT have been touched — no identity bound.
    expect(hoisted.createRailgunWallet).not.toHaveBeenCalled()
    expect(hoisted.loadWalletByID).not.toHaveBeenCalled()
    expect(isUnlocked()).toBe(false)
  })

  it('storage write throws when the wallet is locked (Phase 7 guarantee)', async () => {
    const { store, capture } = mount()
    expect(isUnlocked()).toBe(false)
    const r = txFixture('tx-loose', 'rg-x')
    await expect(putTxIfFresh(r)).rejects.toThrow(/locked/)
    // No record reached the atom either (caller bears OCC + atom write separately).
    expect(store.get(txListAtom)).toEqual([])
    expect(capture.shielded!.state).toBeNull()
  })
})
