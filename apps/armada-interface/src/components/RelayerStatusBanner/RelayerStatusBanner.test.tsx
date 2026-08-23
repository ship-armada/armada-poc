// ABOUTME: Tests for RelayerStatusBanner — health-gated banner rendering + one-click preference flip.
// ABOUTME: Mocks the useRelayerHealth hook to drive the four states (loading / healthy / degraded / unreachable).

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { Provider, createStore } from 'jotai'
import { RelayerStatusBanner } from './RelayerStatusBanner'
import { preferencesAtom, DEFAULT_PREFERENCES, PREFERENCES_STORAGE_KEY } from '@/state/preferences'
import { useRelayerHealth } from '@/hooks/useRelayerHealth'

const mockUseRelayerHealth = useRelayerHealth as unknown as ReturnType<typeof vi.fn>

vi.mock('@/hooks/useRelayerHealth', () => ({
  useRelayerHealth: vi.fn(),
}))

function wrapWith(store: ReturnType<typeof createStore>, ui: React.ReactElement) {
  return <Provider store={store}>{ui}</Provider>
}

describe('<RelayerStatusBanner>', () => {
  beforeEach(() => {
    mockUseRelayerHealth.mockReset()
    // atomWithStorage persists across tests via jsdom's shared localStorage. Wipe it so each
    // test starts from DEFAULT_PREFERENCES and the per-test `store.set` is the only source.
    window.localStorage.removeItem(PREFERENCES_STORAGE_KEY)
  })

  it('renders nothing when the relayer reports healthy', () => {
    // WHY: the banner is a degradation signal — surfacing it when everything is fine would train
    // users to ignore it. A regression that always rendered (e.g., status undefined defaulted to
    // "show") would burn that signal out.
    mockUseRelayerHealth.mockReturnValue({ isConfigured: true, isDegraded: false, data: { status: 'healthy' } })
    const store = createStore()
    const { container } = render(wrapWith(store, <RelayerStatusBanner isOpen />))
    expect(container.firstChild).toBeNull()
  })

  it('renders nothing when the user already has submitFromWallet enabled', () => {
    // WHY: if the user has opted into the wallet path globally, the banner is noise — the
    // handler will take the wallet path regardless of relayer health.
    mockUseRelayerHealth.mockReturnValue({ isConfigured: true, isDegraded: true, data: { status: 'unhealthy' } })
    const store = createStore()
    store.set(preferencesAtom, { ...DEFAULT_PREFERENCES, submitFromWallet: true })
    const { container } = render(wrapWith(store, <RelayerStatusBanner isOpen />))
    expect(container.firstChild).toBeNull()
  })

  it('renders the degraded-relayer banner with the wallet-submit CTA', () => {
    // WHY: when the relayer is degraded the user must know their tx may not broadcast and be
    // offered the wallet path. Copy is static now (no dynamic status word from the payload).
    mockUseRelayerHealth.mockReturnValue({ isConfigured: true, isDegraded: true, data: { status: 'stale' } })
    const store = createStore()
    const { getByRole } = render(wrapWith(store, <RelayerStatusBanner isOpen />))
    expect(getByRole('status').textContent).toMatch(/can't find an available relayer/i)
    expect(getByRole('button', { name: /Submit from my wallet instead/i })).toBeInTheDocument()
  })

  it('still renders the degraded banner when the hook returned no data', () => {
    // WHY: a network-level failure has no `data.status`, but the banner must still surface — its
    // copy no longer depends on the health payload.
    mockUseRelayerHealth.mockReturnValue({ isConfigured: true, isDegraded: true, data: undefined })
    const store = createStore()
    const { getByRole } = render(wrapWith(store, <RelayerStatusBanner isOpen />))
    expect(getByRole('status').textContent).toMatch(/can't find an available relayer/i)
  })

  it('renders a distinct "no relayer configured" banner with a wallet-submit CTA (P0-10)', () => {
    // WHY: a sepolia build without VITE_RELAYER_URL must say so explicitly (not masquerade as a
    // transient "degraded") and steer the user to the wallet path, which works without a relayer.
    mockUseRelayerHealth.mockReturnValue({ isConfigured: false, isDegraded: false, data: undefined })
    const store = createStore()
    const { getByRole } = render(wrapWith(store, <RelayerStatusBanner isOpen />))
    expect(getByRole('status').textContent).toMatch(/no relayer is configured/i)
    expect(getByRole('button', { name: /Submit from my wallet/i })).toBeInTheDocument()
  })

  it('flips submitFromWallet to true when the user clicks the action', () => {
    // WHY: this is the load-bearing user gesture for the override path. A regression that wrote
    // to the wrong field would silently keep the relayer path active despite the click.
    mockUseRelayerHealth.mockReturnValue({ isConfigured: true, isDegraded: true, data: { status: 'unhealthy' } })
    const store = createStore()
    render(wrapWith(store, <RelayerStatusBanner isOpen />))
    fireEvent.click(screen.getByRole('button', { name: /Submit from my wallet instead/i }))
    expect(store.get(preferencesAtom).submitFromWallet).toBe(true)
  })
})
