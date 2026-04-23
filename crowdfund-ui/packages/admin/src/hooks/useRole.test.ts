// ABOUTME: Tests for useRole hook — role detection from connected wallet address.
// ABOUTME: Verifies launch_team, security_council, and observer role assignment.

import type { Mock } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import { useRole } from './useRole'

const LAUNCH_TEAM = '0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
const SECURITY_COUNCIL = '0xBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB'
const TREASURY = '0xCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC'
const RANDOM = '0xDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD'

let mockContractInstance: Record<string, Mock>

vi.mock('ethers', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ethers')>()
  return {
    ...actual,
    Contract: class MockContract {
      constructor() {
        // Return the shared mock instance so tests can configure it
        return mockContractInstance
      }
    },
  }
})

function setupMocks() {
  mockContractInstance = {
    launchTeam: vi.fn().mockResolvedValue(LAUNCH_TEAM),
    securityCouncil: vi.fn().mockResolvedValue(SECURITY_COUNCIL),
    treasury: vi.fn().mockResolvedValue(TREASURY),
  }
}

const fakeProvider = {} as any

describe('useRole', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    setupMocks()
  })

  it('returns observer when no wallet connected', async () => {
    const { result } = renderHook(() =>
      useRole(fakeProvider, '0xContract', null),
    )
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.role).toBe('observer')
  })

  it('detects launch_team role', async () => {
    const { result } = renderHook(() =>
      useRole(fakeProvider, '0xContract', LAUNCH_TEAM),
    )
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.role).toBe('launch_team')
  })

  it('detects security_council role', async () => {
    const { result } = renderHook(() =>
      useRole(fakeProvider, '0xContract', SECURITY_COUNCIL),
    )
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.role).toBe('security_council')
  })

  it('returns observer for unrecognized address', async () => {
    const { result } = renderHook(() =>
      useRole(fakeProvider, '0xContract', RANDOM),
    )
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.role).toBe('observer')
  })

  it('matches addresses case-insensitively', async () => {
    const { result } = renderHook(() =>
      useRole(fakeProvider, '0xContract', LAUNCH_TEAM.toLowerCase()),
    )
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.role).toBe('launch_team')
  })

  it('exposes treasury address', async () => {
    const { result } = renderHook(() =>
      useRole(fakeProvider, '0xContract', null),
    )
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.treasuryAddress).toBe(TREASURY.toLowerCase())
  })

  it('returns observer and stops loading when provider is null', () => {
    const { result } = renderHook(() =>
      useRole(null, '0xContract', LAUNCH_TEAM),
    )
    expect(result.current.loading).toBe(false)
    expect(result.current.role).toBe('observer')
  })

  it('returns observer and stops loading when contractAddress is null', () => {
    const { result } = renderHook(() =>
      useRole(fakeProvider, null, LAUNCH_TEAM),
    )
    expect(result.current.loading).toBe(false)
    expect(result.current.role).toBe('observer')
  })

  it('gracefully falls back to observer on contract read failure', async () => {
    mockContractInstance.launchTeam.mockRejectedValue(new Error('RPC error'))
    mockContractInstance.securityCouncil.mockRejectedValue(new Error('RPC error'))
    mockContractInstance.treasury.mockRejectedValue(new Error('RPC error'))

    const { result } = renderHook(() =>
      useRole(fakeProvider, '0xContract', LAUNCH_TEAM),
    )
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.role).toBe('observer')
    expect(result.current.launchTeamAddress).toBeNull()
  })
})
