// ABOUTME: Smoke tests for the committer App shell's load gates (deployment error / loading).
// ABOUTME: Guards hook ordering in App — a hook below an early return crashes the error page.
// @vitest-environment jsdom

import { render, screen } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createElement, type ReactNode } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { App } from './App'

vi.mock('wagmi', () => ({
  useAccount: () => ({ address: undefined, isConnected: false, chainId: undefined, connector: undefined }),
  useDisconnect: () => ({ disconnect: vi.fn() }),
  useWalletClient: () => ({ data: undefined }),
  useSwitchChain: () => ({ switchChain: vi.fn() }),
}))
vi.mock('@rainbow-me/rainbowkit', () => ({
  ConnectButton: { Custom: () => null },
  useConnectModal: () => ({ openConnectModal: vi.fn() }),
  useChainModal: () => ({ openChainModal: vi.fn() }),
}))
vi.mock('@/config/deployments', () => ({
  loadDeployment: () => Promise.reject(new Error('No crowdfund deployment for this network')),
}))

function renderApp() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const wrapper = ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client }, children)
  return render(<App />, { wrapper })
}

describe('App load gates', () => {
  // jsdom has no WebGL — force NodeSphere's static fallback so the hero
  // renders without the expected WebGL-context error.
  beforeEach(() => window.history.replaceState({}, '', '/?nowebgl'))
  afterEach(() => window.history.replaceState({}, '', '/'))

  it('shows "Deployment Not Found" (not a crash) when the deployment fails to load', async () => {
    renderApp()
    expect(await screen.findByText('Deployment Not Found')).toBeTruthy()
    expect(screen.getByText('No crowdfund deployment for this network')).toBeTruthy()
  })
})
