// ABOUTME: Unit test for runTransferDifferential — build the SDK transfer, simulate it, and report
// ABOUTME: sdk.transferDiff { simulated }; never throws into the caller (observe-only).

import { describe, it, expect, vi, beforeEach } from 'vitest'

const hoisted = vi.hoisted(() => ({ buildTransferSdk: vi.fn(), simulateOrThrow: vi.fn() }))
vi.mock('./transfer-sdk', () => ({ buildTransferSdk: hoisted.buildTransferSdk }))
vi.mock('@/lib/tx/simulate', () => ({ simulateOrThrow: hoisted.simulateOrThrow }))
vi.mock('@/lib/telemetry', () => ({ track: vi.fn(), trackError: vi.fn() }))

import { runTransferDifferential } from './transfer-differential'
import { track, trackError } from '@/lib/telemetry'

const inputs = {
  recipient: '0zk_bob',
  amount: 5n,
  broadcasterFee: { amount: 2n, recipientAddress: '0zk_relayer' },
  poolAddress: '0xpool000000000000000000000000000000000000' as const,
  from: '0xuser000000000000000000000000000000000000' as const,
  chainId: 31337,
}

beforeEach(() => {
  vi.clearAllMocks()
  hoisted.buildTransferSdk.mockResolvedValue({ to: inputs.poolAddress, data: '0xdead' })
})

describe('runTransferDifferential', () => {
  it('reports simulated:true when the SDK calldata passes on-chain simulation', async () => {
    hoisted.simulateOrThrow.mockResolvedValue(undefined)
    await runTransferDifferential(inputs)
    expect(hoisted.simulateOrThrow).toHaveBeenCalledWith(
      expect.objectContaining({ to: inputs.poolAddress, data: '0xdead', account: inputs.from, chainId: 31337 }),
    )
    expect(track).toHaveBeenCalledWith('sdk.transferDiff', { simulated: true })
  })

  it('reports simulated:false + trackError when the contract rejects the SDK tx', async () => {
    // WHY: the on-chain verifier is the arbiter — a revert means the SDK transfer is NOT valid, and
    // must surface as a failed differential rather than a silent pass.
    hoisted.simulateOrThrow.mockRejectedValue(new Error('execution reverted'))
    await runTransferDifferential(inputs)
    expect(track).toHaveBeenCalledWith('sdk.transferDiff', { simulated: false })
    expect(trackError).toHaveBeenCalledWith('sdk.transferDiff.simulate', expect.any(Error), expect.any(Object))
  })

  it('never throws into the caller when the SDK build itself fails', async () => {
    hoisted.buildTransferSdk.mockRejectedValue(new Error('plan/prove failed'))
    await expect(runTransferDifferential(inputs)).resolves.toBeUndefined()
    expect(trackError).toHaveBeenCalledWith('sdk.transferDiff.build', expect.any(Error), expect.any(Object))
    expect(track).not.toHaveBeenCalled()
  })
})
