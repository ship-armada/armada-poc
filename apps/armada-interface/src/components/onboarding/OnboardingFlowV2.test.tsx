// ABOUTME: Tests for OnboardingFlowV2 — V2 amendment 4-step flow (welcome → sign → checksum → complete) + the signer-error branch that catches NonDeterministicSignerError and renders the dedicated screen.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'
import { Provider, createStore } from 'jotai'
import { NonDeterministicSignerError } from '@/lib/crypto/determinism'

// Mocks for the lib + wagmi + RainbowKit surfaces SignEnrollmentStep depends on. Keep these
// before the OnboardingFlowV2 import so vi.mock hoists into place.
const mockSignIn = vi.fn()
const mockReset = vi.fn()
const mockDisconnect = vi.fn()

vi.mock('@/hooks/useShieldedWallet', () => ({
  useShieldedWallet: () => ({
    signIn: mockSignIn,
    reset: mockReset,
    state: { id: 'wallet-1', status: 'unlocked', checksum: 'ab12 cd34 ef56', railgunAddress: '0zk1example' },
    enroll: vi.fn(),
    unlockByPaste: vi.fn(),
    unlockByBackup: vi.fn(),
    lock: vi.fn(),
    exportBackup: vi.fn(),
  }),
}))

vi.mock('wagmi', () => ({
  useAccount: () => ({ isConnected: true, address: '0xabc', chainId: 31337 }),
  useDisconnect: () => ({ disconnect: mockDisconnect }),
}))

vi.mock('@rainbow-me/rainbowkit', () => ({
  useConnectModal: () => ({ openConnectModal: vi.fn() }),
}))

import { OnboardingFlowV2 } from './OnboardingFlowV2'

function renderFlow(opts?: { onDone?: () => void; onRestore?: () => void }) {
  const onDone = opts?.onDone ?? vi.fn()
  const onRestore = opts?.onRestore
  const store = createStore()
  render(
    <Provider store={store}>
      <OnboardingFlowV2 onDone={onDone} onRestore={onRestore} />
    </Provider>,
  )
  return { onDone, onRestore }
}

beforeEach(() => {
  mockSignIn.mockReset()
  mockReset.mockReset()
  mockDisconnect.mockReset()
})

async function advanceToSignStep() {
  fireEvent.click(screen.getByRole('button', { name: /Create account/i }))
  await waitFor(() => screen.getByRole('button', { name: /Sign message/i }))
}

describe('<OnboardingFlowV2>', () => {
  it('starts on the welcome step', () => {
    renderFlow()
    expect(screen.getByRole('heading', { name: /Create your private USDC account/i })).toBeInTheDocument()
  })

  it('advances welcome → sign on Create account', async () => {
    renderFlow()
    await advanceToSignStep()
    expect(screen.getByRole('heading', { name: /Sign to generate your keys/i })).toBeInTheDocument()
  })

  it('advances sign → complete on a successful signIn (V2 amendment dropped the intermediate checksum step)', async () => {
    mockSignIn.mockResolvedValueOnce({
      rootSecret: new Uint8Array(32),
      state: { id: 'x', status: 'unlocked' },
    })
    renderFlow()
    await advanceToSignStep()
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Sign message/i }))
    })
    await waitFor(() => expect(mockSignIn).toHaveBeenCalledTimes(1))
    await waitFor(() => {
      expect(screen.getByRole('heading', { name: /you'?re in/i })).toBeInTheDocument()
    })
  })

  it('routes to the signer-error screen when signIn throws NonDeterministicSignerError', async () => {
    mockSignIn.mockRejectedValueOnce(new NonDeterministicSignerError('first-sign-mismatch'))
    renderFlow()
    await advanceToSignStep()
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Sign message/i }))
    })
    await waitFor(() => {
      expect(screen.getByRole('alert')).toBeInTheDocument()
      expect(screen.getByRole('heading', { name: /can't unlock by signing/i })).toBeInTheDocument()
    })
    // Compatibility list rendered.
    expect(screen.getByText('MetaMask')).toBeInTheDocument()
    expect(screen.getByText(/Safe \/ Gnosis Safe/)).toBeInTheDocument()
  })

  it('on the signer-error screen, the use-recovery CTA fires onRestore when supplied', async () => {
    mockSignIn.mockRejectedValueOnce(new NonDeterministicSignerError('first-sign-mismatch'))
    const onRestore = vi.fn()
    renderFlow({ onRestore })
    await advanceToSignStep()
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Sign message/i }))
    })
    await waitFor(() => screen.getByRole('alert'))
    fireEvent.click(screen.getByRole('button', { name: /backup file or recovery secret/i }))
    expect(onRestore).toHaveBeenCalledTimes(1)
  })

  it('on the signer-error screen, the try-different-wallet CTA disconnects + returns to welcome', async () => {
    mockSignIn.mockRejectedValueOnce(new NonDeterministicSignerError('first-sign-mismatch'))
    renderFlow()
    await advanceToSignStep()
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Sign message/i }))
    })
    await waitFor(() => screen.getByRole('alert'))
    fireEvent.click(screen.getByRole('button', { name: /try a different wallet/i }))
    expect(mockDisconnect).toHaveBeenCalledTimes(1)
    await waitFor(() => {
      expect(screen.getByRole('heading', { name: /Create your private USDC account/i })).toBeInTheDocument()
    })
  })
})
