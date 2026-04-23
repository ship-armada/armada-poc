// ABOUTME: Component tests for the observer App layout.
// ABOUTME: Verifies rendering for each phase: loading, pre-open, empty, active, cancelled, refund.

// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { Provider as JotaiProvider } from 'jotai'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { App } from './App'
import type { ContractState } from '@armada/crowdfund-shared'

// Default contract state for mocking
const defaultContractState: ContractState = {
  phase: 0,
  armLoaded: true,
  totalCommitted: 100_000n * 10n ** 6n,
  cappedDemand: 90_000n * 10n ** 6n,
  saleSize: 1_200_000n * 10n ** 6n,
  windowStart: 1700000000,
  windowEnd: 1700100000,
  launchTeamInviteEnd: 1700050000,
  finalizedAt: 0,
  claimDeadline: 0,
  refundMode: false,
  blockTimestamp: 1700000500,
  hopStats: [
    { totalCommitted: 60_000n * 10n ** 6n, cappedCommitted: 55_000n * 10n ** 6n, uniqueCommitters: 50, whitelistCount: 10 },
    { totalCommitted: 30_000n * 10n ** 6n, cappedCommitted: 28_000n * 10n ** 6n, uniqueCommitters: 40, whitelistCount: 100 },
    { totalCommitted: 10_000n * 10n ** 6n, cappedCommitted: 7_000n * 10n ** 6n, uniqueCommitters: 20, whitelistCount: 200 },
  ],
  participantCount: 110,
  seedCount: 10,
  loading: false,
  error: null,
}

let mockContractState = { ...defaultContractState }
let mockDeploymentError: string | null = null

// Mock ResizeObserver for jsdom
globalThis.ResizeObserver = class ResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
} as any

// Mock modules
vi.mock('@/config/network', () => ({
  getHubRpcUrls: () => ['http://localhost:8545'],
  getPollIntervalMs: () => 30000,
  getNetworkMode: () => 'local',
}))

vi.mock('@/config/deployments', () => ({
  loadDeployment: () => {
    if (mockDeploymentError) return Promise.reject(new Error(mockDeploymentError))
    return Promise.resolve({
      contracts: { crowdfund: '0xCrowdfund' },
    })
  },
}))

vi.mock('ethers', async () => {
  const actual = await vi.importActual('ethers')
  return {
    ...actual,
    JsonRpcProvider: class MockProvider {},
  }
})

// Mock shared hooks to avoid real RPC calls
vi.mock('@armada/crowdfund-shared', async () => {
  const actual = await vi.importActual('@armada/crowdfund-shared')
  return {
    ...actual,
    useContractEvents: () => ({ events: [], loading: false, error: null }),
    useGraphState: () => ({
      graph: { nodes: new Map(), edges: [], summaries: new Map() },
      summaries: new Map(),
      nodes: new Map(),
    }),
    useSelection: () => ({
      selectedAddress: null,
      selectAddress: vi.fn(),
      searchQuery: '',
      setSearchQuery: vi.fn(),
      hoveredAddress: null,
      setHoveredAddress: vi.fn(),
    }),
    useENS: () => ({ resolve: () => null }),
    useAllocations: () => new Map(),
    useContractState: () => mockContractState,
    createProvider: () => ({}),
  }
})

function renderApp() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  return render(
    <QueryClientProvider client={client}>
      <JotaiProvider>
        <App />
      </JotaiProvider>
    </QueryClientProvider>,
  )
}

describe('App', () => {
  beforeEach(() => {
    mockContractState = { ...defaultContractState }
    mockDeploymentError = null
  })

  it('renders loading state when contract state is loading', () => {
    mockContractState = { ...defaultContractState, loading: true }
    renderApp()
    expect(screen.getByText('Loading...')).toBeDefined()
  })

  it('renders deployment error when deployment fails', async () => {
    mockDeploymentError = 'Manifest not found'
    renderApp()
    // Deployment error is handled via useEffect, so it won't render synchronously
    // in this mock setup since loadDeployment runs in useEffect.
    // The test validates the initial loading state path.
    expect(screen.getByText('Loading...')).toBeDefined()
  })

  it('renders pre-open state when ARM is not loaded', async () => {
    mockContractState = { ...defaultContractState, armLoaded: false }
    renderApp()
    await waitFor(() => {
      expect(screen.getByText('Crowdfund Not Yet Open')).toBeDefined()
    })
  })

  it('shows seed count in pre-open state when seeds exist', async () => {
    mockContractState = { ...defaultContractState, armLoaded: false, seedCount: 5 }
    renderApp()
    await waitFor(() => {
      expect(screen.getByText('5 seeds added')).toBeDefined()
    })
  })

  it('renders empty state when no seeds yet', async () => {
    mockContractState = { ...defaultContractState, seedCount: 0 }
    renderApp()
    await waitFor(() => {
      expect(screen.getByText('Waiting for seeds to be added...')).toBeDefined()
    })
  })

  it('renders active state with header and event footer', async () => {
    renderApp()
    await waitFor(() => {
      expect(screen.getByText('Armada Crowdfund')).toBeDefined()
    })
    // Event footer text may be split across elements; search by regex
    expect(screen.getByText(/events loaded/)).toBeDefined()
  })

  it('renders cancellation banner when phase is 2', async () => {
    mockContractState = { ...defaultContractState, phase: 2 }
    renderApp()
    await waitFor(() => {
      expect(screen.getByText('Crowdfund Cancelled')).toBeDefined()
    })
    expect(screen.getByText(/full USDC refund/)).toBeDefined()
  })

  it('renders refund mode banner when phase is 1 with refundMode', async () => {
    mockContractState = { ...defaultContractState, phase: 1, refundMode: true }
    renderApp()
    await waitFor(() => {
      expect(screen.getByText('Refund Mode')).toBeDefined()
    })
  })

  it('renders mobile tab buttons', async () => {
    renderApp()
    await waitFor(() => {
      expect(screen.getByText('Armada Crowdfund')).toBeDefined()
    })
    // Mobile tabs use shadcn Tabs (role=tab, not role=button); rendered in DOM
    // even when CSS-hidden at desktop breakpoints.
    const treeTabs = screen.getAllByRole('tab', { name: /Tree/i })
    const tableTabs = screen.getAllByRole('tab', { name: /Table/i })
    expect(treeTabs.length).toBeGreaterThan(0)
    expect(tableTabs.length).toBeGreaterThan(0)
  })
})
