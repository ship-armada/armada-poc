// ABOUTME: Tests for useWallet — wrong-network detection and one-click chain switching.
// ABOUTME: Mocks wagmi + RainbowKit hooks to drive connection/chain state deterministically.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook } from '@testing-library/react'

const mockUseAccount = vi.fn()
const mockUseChainId = vi.fn()
const mockUseWalletClient = vi.fn()
const mockUseDisconnect = vi.fn()
const mockUseSwitchChain = vi.fn()
const mockUseConnectModal = vi.fn()
const mockUseChainModal = vi.fn()

vi.mock('wagmi', () => ({
  useAccount: () => mockUseAccount(),
  useChainId: () => mockUseChainId(),
  useWalletClient: () => mockUseWalletClient(),
  useDisconnect: () => mockUseDisconnect(),
  useSwitchChain: () => mockUseSwitchChain(),
}))

vi.mock('@rainbow-me/rainbowkit', () => ({
  useConnectModal: () => mockUseConnectModal(),
  useChainModal: () => mockUseChainModal(),
}))

// Stub the ethers adapter — these tests only assert signer presence/absence,
// not the real Signer wiring.
vi.mock('@/lib/wagmiAdapter', () => ({
  walletClientToSigner: vi.fn(() => ({ _isSigner: true })),
}))

import { useWallet } from './useWallet'

// VITE_NETWORK is forced to 'local' in vitest.config.ts, so the hub chain id is Anvil's.
const HUB_CHAIN_ID = 31337
const WRONG_CHAIN_ID = 1

const switchChainAsync = vi.fn().mockResolvedValue(undefined)
const openChainModal = vi.fn()

beforeEach(() => {
  vi.clearAllMocks()
  switchChainAsync.mockResolvedValue(undefined)
  mockUseAccount.mockReturnValue({
    address: undefined,
    isConnected: false,
    isConnecting: false,
    chainId: undefined,
  })
  // Legacy config-level chain id. Always the hub id (config holds one chain) —
  // present so the hook's transition off useChainId is exercised faithfully.
  mockUseChainId.mockReturnValue(HUB_CHAIN_ID)
  mockUseWalletClient.mockReturnValue({ data: undefined })
  mockUseDisconnect.mockReturnValue({ disconnect: vi.fn() })
  mockUseSwitchChain.mockReturnValue({ switchChainAsync })
  mockUseConnectModal.mockReturnValue({ openConnectModal: vi.fn() })
  mockUseChainModal.mockReturnValue({ openChainModal })
})

describe('useWallet', () => {
  it('is disconnected with no wrong-network flag when no wallet is connected', () => {
    const { result } = renderHook(() => useWallet())
    expect(result.current.connected).toBe(false)
    expect(result.current.isWrongNetwork).toBe(false)
    expect(result.current.address).toBeNull()
    expect(result.current.error).toBeNull()
  })

  it('is connected (and not wrong-network) when the wallet is on the hub chain', () => {
    mockUseAccount.mockReturnValue({
      address: '0xAbCdEf0000000000000000000000000000000001',
      isConnected: true,
      isConnecting: false,
      chainId: HUB_CHAIN_ID,
    })
    mockUseWalletClient.mockReturnValue({ data: {} })
    const { result } = renderHook(() => useWallet())
    expect(result.current.connected).toBe(true)
    expect(result.current.isWrongNetwork).toBe(false)
    // Address is normalized to lowercase.
    expect(result.current.address).toBe('0xabcdef0000000000000000000000000000000001')
    expect(result.current.signer).not.toBeNull()
    expect(result.current.error).toBeNull()
  })

  it('detects a wrong network from the per-connection account chainId', () => {
    // The wallet switched to a chain that is NOT in the single-chain wagmi
    // config. useChainId() still reports the hub id (it ignores unconfigured
    // chains), so detection must come from useAccount().chainId.
    mockUseAccount.mockReturnValue({
      address: '0xAbCdEf0000000000000000000000000000000001',
      isConnected: true,
      isConnecting: false,
      chainId: WRONG_CHAIN_ID,
    })
    mockUseWalletClient.mockReturnValue({ data: {} })
    const { result } = renderHook(() => useWallet())
    expect(result.current.isWrongNetwork).toBe(true)
    // A wrong-network wallet is not "connected" for flow purposes.
    expect(result.current.connected).toBe(false)
    expect(result.current.error).toContain(String(HUB_CHAIN_ID))
    // No signer is built against the wrong chain.
    expect(result.current.signer).toBeNull()
  })

  it('switchNetwork requests a switch to the hub chain', () => {
    mockUseAccount.mockReturnValue({
      address: '0xAbCdEf0000000000000000000000000000000001',
      isConnected: true,
      isConnecting: false,
      chainId: WRONG_CHAIN_ID,
    })
    const { result } = renderHook(() => useWallet())
    result.current.switchNetwork()
    expect(switchChainAsync).toHaveBeenCalledWith({ chainId: HUB_CHAIN_ID })
  })
})
