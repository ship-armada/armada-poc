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
  useWalletClient: (params?: unknown) => mockUseWalletClient(params),
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
    // The signer reflects wallet connection, not chain correctness — it stays
    // available so on-chain actions fail loudly (or prompt a switch) rather than
    // silently no-op'ing. Chain correctness is conveyed via isWrongNetwork.
    expect(result.current.signer).not.toBeNull()
  })

  // The wallet-client query must never fetch while the wallet sits on an
  // unconfigured chain: wagmi's useWalletClient requests the CONFIG's chain id,
  // and getConnectorClient throws ConnectorChainMismatchError when the wallet's
  // live chain differs. With staleTime: Infinity and invalidation only on
  // address change, that error state is permanent for the session — the
  // "signer null after fresh connect on mainnet → switch to hub chain" bug.
  // Gating `enabled` on the account chain means the first fetch happens only
  // once it can succeed, and the chain switch itself triggers it.
  describe('wallet-client query gating', () => {
    const queryEnabled = (): boolean | undefined =>
      (mockUseWalletClient.mock.lastCall?.[0] as { query?: { enabled?: boolean } } | undefined)
        ?.query?.enabled

    it('disables the query while disconnected', () => {
      renderHook(() => useWallet())
      expect(queryEnabled()).toBe(false)
    })

    it('disables the query while the wallet is on the wrong network', () => {
      mockUseAccount.mockReturnValue({
        address: '0xAbCdEf0000000000000000000000000000000001',
        isConnected: true,
        isConnecting: false,
        chainId: WRONG_CHAIN_ID,
      })
      renderHook(() => useWallet())
      expect(queryEnabled()).toBe(false)
    })

    it('enables the query once connected on the hub chain', () => {
      mockUseAccount.mockReturnValue({
        address: '0xAbCdEf0000000000000000000000000000000001',
        isConnected: true,
        isConnecting: false,
        chainId: HUB_CHAIN_ID,
      })
      renderHook(() => useWallet())
      expect(queryEnabled()).toBe(true)
    })

    it('enables the query when the wallet lands on the hub chain after connecting elsewhere', () => {
      // Fresh-connect repro: MetaMask connects on mainnet, then a second prompt
      // switches to the hub chain. The query must flip disabled → enabled.
      mockUseAccount.mockReturnValue({
        address: '0xAbCdEf0000000000000000000000000000000001',
        isConnected: true,
        isConnecting: false,
        chainId: WRONG_CHAIN_ID,
      })
      const { rerender } = renderHook(() => useWallet())
      expect(queryEnabled()).toBe(false)
      mockUseAccount.mockReturnValue({
        address: '0xAbCdEf0000000000000000000000000000000001',
        isConnected: true,
        isConnecting: false,
        chainId: HUB_CHAIN_ID,
      })
      rerender()
      expect(queryEnabled()).toBe(true)
    })
  })

  it('switchNetwork opens the RainbowKit chain modal', () => {
    mockUseAccount.mockReturnValue({
      address: '0xAbCdEf0000000000000000000000000000000001',
      isConnected: true,
      isConnecting: false,
      chainId: WRONG_CHAIN_ID,
    })
    const { result } = renderHook(() => useWallet())
    result.current.switchNetwork()
    expect(openChainModal).toHaveBeenCalled()
  })
})
