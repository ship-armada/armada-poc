// ABOUTME: Tests for useAdminState hook — aggregate contract state polling.
// ABOUTME: Verifies state derivation, hop stats parsing, error handling, and polling lifecycle.

import { renderHook, waitFor } from '@testing-library/react'
import { useAdminState } from './useAdminState'

// Mock contract methods
const mockPhase = vi.fn()
const mockArmLoaded = vi.fn()
const mockTotalCommitted = vi.fn()
const mockCappedDemand = vi.fn()
const mockSaleSize = vi.fn()
const mockWindowStart = vi.fn()
const mockWindowEnd = vi.fn()
const mockLaunchTeamInviteEnd = vi.fn()
const mockFinalizedAt = vi.fn()
const mockClaimDeadline = vi.fn()
const mockRefundMode = vi.fn()
const mockGetParticipantCount = vi.fn()
const mockGetHopStats = vi.fn()
const mockGetLaunchTeamBudgetRemaining = vi.fn()
const mockTotalAllocatedArm = vi.fn()
const mockTotalArmTransferred = vi.fn()
const mockGetBlock = vi.fn()

vi.mock('ethers', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ethers')>()
  return {
    ...actual,
    Contract: class MockContract {
      constructor() {
        return {
          phase: mockPhase,
          armLoaded: mockArmLoaded,
          totalCommitted: mockTotalCommitted,
          cappedDemand: mockCappedDemand,
          saleSize: mockSaleSize,
          windowStart: mockWindowStart,
          windowEnd: mockWindowEnd,
          launchTeamInviteEnd: mockLaunchTeamInviteEnd,
          finalizedAt: mockFinalizedAt,
          claimDeadline: mockClaimDeadline,
          refundMode: mockRefundMode,
          getParticipantCount: mockGetParticipantCount,
          getHopStats: mockGetHopStats,
          getLaunchTeamBudgetRemaining: mockGetLaunchTeamBudgetRemaining,
          totalAllocatedArm: mockTotalAllocatedArm,
          totalArmTransferred: mockTotalArmTransferred,
        }
      }
    },
  }
})

function setupMocks() {
  mockPhase.mockResolvedValue(0n)
  mockArmLoaded.mockResolvedValue(true)
  mockTotalCommitted.mockResolvedValue(500_000n * 10n ** 6n)
  mockCappedDemand.mockResolvedValue(500_000n * 10n ** 6n)
  mockSaleSize.mockResolvedValue(1_200_000n * 10n ** 6n)
  mockWindowStart.mockResolvedValue(1000n)
  mockWindowEnd.mockResolvedValue(100_000n)
  mockLaunchTeamInviteEnd.mockResolvedValue(50_000n)
  mockFinalizedAt.mockResolvedValue(0n)
  mockClaimDeadline.mockResolvedValue(0n)
  mockRefundMode.mockResolvedValue(false)
  mockGetParticipantCount.mockResolvedValue(42n)
  // Hop stats: [totalCommitted, cappedCommitted, uniqueCommitters, whitelistCount]
  mockGetHopStats.mockImplementation((hop: number) => {
    if (hop === 0) return Promise.resolve([200_000n * 10n ** 6n, 180_000n * 10n ** 6n, 50n, 100n])
    if (hop === 1) return Promise.resolve([200_000n * 10n ** 6n, 190_000n * 10n ** 6n, 80n, 200n])
    return Promise.resolve([100_000n * 10n ** 6n, 95_000n * 10n ** 6n, 60n, 150n])
  })
  mockGetLaunchTeamBudgetRemaining.mockResolvedValue([45n, 30n])
  mockTotalAllocatedArm.mockResolvedValue(0n)
  mockTotalArmTransferred.mockResolvedValue(0n)
  mockGetBlock.mockResolvedValue({ timestamp: 5000 })
}

const fakeProvider = { getBlock: mockGetBlock } as any

describe('useAdminState', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    setupMocks()
  })

  it('starts in loading state', () => {
    const { result } = renderHook(() =>
      useAdminState(fakeProvider, '0xContract', 60_000),
    )
    expect(result.current.loading).toBe(true)
  })

  it('fetches and parses contract state', async () => {
    const { result } = renderHook(() =>
      useAdminState(fakeProvider, '0xContract', 60_000),
    )
    await waitFor(() => expect(result.current.loading).toBe(false))

    expect(result.current.phase).toBe(0)
    expect(result.current.armLoaded).toBe(true)
    expect(result.current.totalCommitted).toBe(500_000n * 10n ** 6n)
    expect(result.current.windowStart).toBe(1000)
    expect(result.current.windowEnd).toBe(100_000)
    expect(result.current.participantCount).toBe(42)
    expect(result.current.blockTimestamp).toBe(5000)
  })

  it('parses hop stats correctly', async () => {
    const { result } = renderHook(() =>
      useAdminState(fakeProvider, '0xContract', 60_000),
    )
    await waitFor(() => expect(result.current.loading).toBe(false))

    expect(result.current.hopStats).toHaveLength(3)
    expect(result.current.hopStats[0].totalCommitted).toBe(200_000n * 10n ** 6n)
    expect(result.current.hopStats[0].cappedCommitted).toBe(180_000n * 10n ** 6n)
    expect(result.current.hopStats[0].uniqueCommitters).toBe(50)
    expect(result.current.hopStats[0].whitelistCount).toBe(100)
  })

  it('derives seedCount from hop-0 whitelistCount', async () => {
    const { result } = renderHook(() =>
      useAdminState(fakeProvider, '0xContract', 60_000),
    )
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.seedCount).toBe(100)
  })

  it('parses LT budget remaining', async () => {
    const { result } = renderHook(() =>
      useAdminState(fakeProvider, '0xContract', 60_000),
    )
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.ltBudgetHop1Remaining).toBe(45)
    expect(result.current.ltBudgetHop2Remaining).toBe(30)
  })

  it('sets error on contract read failure', async () => {
    mockPhase.mockRejectedValue(new Error('RPC timeout'))

    const { result } = renderHook(() =>
      useAdminState(fakeProvider, '0xContract', 60_000),
    )
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.error).toBe('RPC timeout')
  })

  it('does not fetch when provider is null', () => {
    const { result } = renderHook(() =>
      useAdminState(null, '0xContract', 60_000),
    )
    expect(result.current.loading).toBe(true)
    expect(mockPhase).not.toHaveBeenCalled()
  })

  it('does not fetch when contractAddress is null', () => {
    const { result } = renderHook(() =>
      useAdminState(fakeProvider, null, 60_000),
    )
    expect(result.current.loading).toBe(true)
    expect(mockPhase).not.toHaveBeenCalled()
  })
})
