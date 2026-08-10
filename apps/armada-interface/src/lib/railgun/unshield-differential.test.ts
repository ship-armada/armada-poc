// ABOUTME: Unit test for runUnshieldDifferential — build the SDK unshield, simulate it, and report
// ABOUTME: sdk.unshieldDiff { simulated }; never throws into the caller (observe-only).

import { describe, it, expect, vi, beforeEach } from 'vitest'

const hoisted = vi.hoisted(() => ({ buildUnshieldSdk: vi.fn(), simulateOrThrow: vi.fn() }))
vi.mock('./unshield-sdk', () => ({ buildUnshieldSdk: hoisted.buildUnshieldSdk }))
vi.mock('@/lib/tx/simulate', () => ({ simulateOrThrow: hoisted.simulateOrThrow }))
vi.mock('@/lib/telemetry', () => ({ track: vi.fn(), trackError: vi.fn() }))

import { runUnshieldDifferential } from './unshield-differential'
import { track, trackError } from '@/lib/telemetry'

const inputs = {
  recipient: '0xbob0000000000000000000000000000000000000' as const,
  amount: 5n,
  broadcasterFee: { amount: 2n, recipientAddress: '0zk_relayer' },
  poolAddress: '0xpool000000000000000000000000000000000000' as const,
  from: '0xuser000000000000000000000000000000000000' as const,
  chainId: 31337,
}

beforeEach(() => {
  vi.clearAllMocks()
  hoisted.buildUnshieldSdk.mockResolvedValue({ to: inputs.poolAddress, data: '0xdead' })
})

describe('runUnshieldDifferential', () => {
  it('reports simulated:true when the SDK calldata passes on-chain simulation', async () => {
    hoisted.simulateOrThrow.mockResolvedValue(undefined)
    await runUnshieldDifferential(inputs)
    expect(hoisted.simulateOrThrow).toHaveBeenCalledWith(
      expect.objectContaining({ to: inputs.poolAddress, data: '0xdead', account: inputs.from, chainId: 31337 }),
    )
    expect(track).toHaveBeenCalledWith('sdk.unshieldDiff', { simulated: true })
  })

  it('reports simulated:false + trackError when the contract rejects the SDK tx', async () => {
    // WHY: the on-chain verifier is the arbiter — a revert means the SDK unshield is NOT valid, and
    // must surface as a failed differential rather than a silent pass.
    hoisted.simulateOrThrow.mockRejectedValue(new Error('execution reverted'))
    await runUnshieldDifferential(inputs)
    expect(track).toHaveBeenCalledWith('sdk.unshieldDiff', { simulated: false })
    expect(trackError).toHaveBeenCalledWith('sdk.unshieldDiff.simulate', expect.any(Error), expect.any(Object))
  })

  it('never throws into the caller when the SDK build itself fails', async () => {
    hoisted.buildUnshieldSdk.mockRejectedValue(new Error('plan/prove failed'))
    await expect(runUnshieldDifferential(inputs)).resolves.toBeUndefined()
    expect(trackError).toHaveBeenCalledWith('sdk.unshieldDiff.build', expect.any(Error), expect.any(Object))
    expect(track).not.toHaveBeenCalled()
  })
})
