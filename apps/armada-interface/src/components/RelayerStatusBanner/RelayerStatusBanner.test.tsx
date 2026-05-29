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
    mockUseRelayerHealth.mockReturnValue({ isDegraded: false, data: { status: 'healthy' } })
    const store = createStore()
    const { container } = render(wrapWith(store, <RelayerStatusBanner isOpen />))
    expect(container.firstChild).toBeNull()
  })

  it('renders nothing when the user already has submitFromWallet enabled', () => {
    // WHY: if the user has opted into the wallet path globally, the banner is noise — the
    // handler will take the wallet path regardless of relayer health.
    mockUseRelayerHealth.mockReturnValue({ isDegraded: true, data: { status: 'unhealthy' } })
    const store = createStore()
    store.set(preferencesAtom, { ...DEFAULT_PREFERENCES, submitFromWallet: true })
    const { container } = render(wrapWith(store, <RelayerStatusBanner isOpen />))
    expect(container.firstChild).toBeNull()
  })

  it('renders the banner with the relayer\'s status when degraded', () => {
    // WHY: the status word must reach the user — "stale" vs "unhealthy" tell them whether to
    // hand-fall-back now or wait. The role="status" container holds the message; assert against
    // its textContent so the surrounding <strong> emphasis tag doesn't trip the matcher.
    mockUseRelayerHealth.mockReturnValue({ isDegraded: true, data: { status: 'stale' } })
    const store = createStore()
    const { getByRole } = render(wrapWith(store, <RelayerStatusBanner isOpen />))
    const statusRegion = getByRole('status')
    expect(statusRegion.textContent).toMatch(/relayer is reporting/i)
    expect(statusRegion.textContent).toMatch(/stale/i)
    expect(getByRole('button', { name: /Submit from my wallet instead/i })).toBeInTheDocument()
  })

  it('falls back to "unreachable" when the hook returned no data', () => {
    // WHY: a network-level failure has no `data.status` to read — the banner must still render
    // something meaningful. "unreachable" is the right semantic distinction from "stale".
    mockUseRelayerHealth.mockReturnValue({ isDegraded: true, data: undefined })
    const store = createStore()
    const { getByRole } = render(wrapWith(store, <RelayerStatusBanner isOpen />))
    expect(getByRole('status').textContent).toMatch(/unreachable/i)
  })

  it('flips submitFromWallet to true when the user clicks the action', () => {
    // WHY: this is the load-bearing user gesture for the override path. A regression that wrote
    // to the wrong field would silently keep the relayer path active despite the click.
    mockUseRelayerHealth.mockReturnValue({ isDegraded: true, data: { status: 'unhealthy' } })
    const store = createStore()
    render(wrapWith(store, <RelayerStatusBanner isOpen />))
    fireEvent.click(screen.getByRole('button', { name: /Submit from my wallet instead/i }))
    expect(store.get(preferencesAtom).submitFromWallet).toBe(true)
  })
})
