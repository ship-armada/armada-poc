// ABOUTME: Unit test for runXchainUnshieldDifferential — build the SDK xchain unshield, simulate it, and
// ABOUTME: report sdk.xchainUnshieldDiff { simulated }; never throws into the caller (observe-only).

import { describe, it, expect, vi, beforeEach } from 'vitest'

const hoisted = vi.hoisted(() => ({ buildXchainUnshieldSdk: vi.fn(), simulateOrThrow: vi.fn() }))
vi.mock('./unshield-xchain-sdk', () => ({ buildXchainUnshieldSdk: hoisted.buildXchainUnshieldSdk }))
vi.mock('@/lib/tx/simulate', () => ({ simulateOrThrow: hoisted.simulateOrThrow }))
vi.mock('@/lib/telemetry', () => ({ track: vi.fn(), trackError: vi.fn() }))

import { runXchainUnshieldDifferential } from './unshield-xchain-differential'
import { track, trackError } from '@/lib/telemetry'

const inputs = {
  amount: 5n,
  broadcasterFee: { amount: 2n, recipientAddress: '0zk_relayer' },
  privacyPoolAddress: '0xpool000000000000000000000000000000000000' as const,
  finalRecipient: '0xbob0000000000000000000000000000000000000' as const,
  destinationDomain: 6,
  maxFee: 1_000n,
  uniqueNonce: `0x${'11'.repeat(32)}` as const,
  from: '0xuser000000000000000000000000000000000000' as const,
  chainId: 31337,
}

beforeEach(() => {
  vi.clearAllMocks()
  hoisted.buildXchainUnshieldSdk.mockResolvedValue({ to: inputs.privacyPoolAddress, data: '0xdead' })
})

describe('runXchainUnshieldDifferential', () => {
  it('reports simulated:true when the SDK calldata passes on-chain simulation', async () => {
    hoisted.simulateOrThrow.mockResolvedValue(undefined)
    await runXchainUnshieldDifferential(inputs)
    expect(hoisted.simulateOrThrow).toHaveBeenCalledWith(
      expect.objectContaining({ to: inputs.privacyPoolAddress, data: '0xdead', account: inputs.from, chainId: 31337 }),
    )
    expect(track).toHaveBeenCalledWith('sdk.xchainUnshieldDiff', { simulated: true })
  })

  it('reports simulated:false + trackError when the contract rejects the SDK tx', async () => {
    // WHY: the on-chain verifier is the arbiter — a revert means the SDK xchain unshield (or its
    // adaptParams↔args binding) is NOT valid, and must surface rather than silently pass.
    hoisted.simulateOrThrow.mockRejectedValue(new Error('execution reverted'))
    await runXchainUnshieldDifferential(inputs)
    expect(track).toHaveBeenCalledWith('sdk.xchainUnshieldDiff', { simulated: false })
    expect(trackError).toHaveBeenCalledWith('sdk.xchainUnshieldDiff.simulate', expect.any(Error), expect.any(Object))
  })

  it('never throws into the caller when the SDK build itself fails', async () => {
    hoisted.buildXchainUnshieldSdk.mockRejectedValue(new Error('plan/prove/encode failed'))
    await expect(runXchainUnshieldDifferential(inputs)).resolves.toBeUndefined()
    expect(trackError).toHaveBeenCalledWith('sdk.xchainUnshieldDiff.build', expect.any(Error), expect.any(Object))
    expect(track).not.toHaveBeenCalled()
  })
})
