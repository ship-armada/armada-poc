// ABOUTME: Unit test for runYieldDifferential — build the SDK yield op, simulate it, and report
// ABOUTME: sdk.yieldDiff { mode, simulated }; never throws into the caller (observe-only).

import { describe, it, expect, vi, beforeEach } from 'vitest'

const hoisted = vi.hoisted(() => ({ buildYieldAdaptSdk: vi.fn(), simulateOrThrow: vi.fn() }))
vi.mock('./yield-sdk', () => ({ buildYieldAdaptSdk: hoisted.buildYieldAdaptSdk }))
vi.mock('@/lib/tx/simulate', () => ({ simulateOrThrow: hoisted.simulateOrThrow }))
vi.mock('@/lib/telemetry', () => ({ track: vi.fn(), trackError: vi.fn() }))

import { runYieldDifferential } from './yield-differential'
import { track, trackError } from '@/lib/telemetry'

const inputs = {
  mode: 'lend' as const,
  amount: 5n,
  unshieldToken: '0xaaaa000000000000000000000000000000000000' as const,
  shieldOutputToken: '0xbbbb000000000000000000000000000000000000' as const,
  adapterAddress: '0xcccc000000000000000000000000000000000000' as const,
  railgunAddress: '0zk_user',
  broadcasterFee: { amount: 2n, recipientAddress: '0zk_relayer' },
  from: '0xuser000000000000000000000000000000000000' as const,
  chainId: 31337,
}

beforeEach(() => {
  vi.clearAllMocks()
  hoisted.buildYieldAdaptSdk.mockResolvedValue({ to: inputs.adapterAddress, data: '0xdead' })
})

describe('runYieldDifferential', () => {
  it('reports simulated:true (with mode) when the SDK calldata passes on-chain simulation', async () => {
    hoisted.simulateOrThrow.mockResolvedValue(undefined)
    await runYieldDifferential(inputs)
    expect(hoisted.simulateOrThrow).toHaveBeenCalledWith(
      expect.objectContaining({ to: inputs.adapterAddress, data: '0xdead', account: inputs.from, chainId: 31337 }),
    )
    expect(track).toHaveBeenCalledWith('sdk.yieldDiff', { mode: 'lend', simulated: true })
  })

  it('reports simulated:false + trackError when the adapter rejects the SDK tx', async () => {
    hoisted.simulateOrThrow.mockRejectedValue(new Error('execution reverted'))
    await runYieldDifferential({ ...inputs, mode: 'redeem' })
    expect(track).toHaveBeenCalledWith('sdk.yieldDiff', { mode: 'redeem', simulated: false })
    expect(trackError).toHaveBeenCalledWith('sdk.yieldDiff.simulate', expect.any(Error), expect.any(Object))
  })

  it('never throws into the caller when the SDK build itself fails', async () => {
    hoisted.buildYieldAdaptSdk.mockRejectedValue(new Error('plan/prove/bundle failed'))
    await expect(runYieldDifferential(inputs)).resolves.toBeUndefined()
    expect(trackError).toHaveBeenCalledWith('sdk.yieldDiff.build', expect.any(Error), expect.any(Object))
    expect(track).not.toHaveBeenCalled()
  })
})
