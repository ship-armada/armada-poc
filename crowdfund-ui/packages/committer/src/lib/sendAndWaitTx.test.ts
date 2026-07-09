// ABOUTME: Tests for sendAndWaitTx — the single-step send/wait engine shared by the pipeline store and ClaimFlow.
// ABOUTME: Classifies a send into success / reverted / timeout / rejected / error outcomes.

import { describe, it, expect, vi } from 'vitest'
import { sendAndWaitTx } from './sendAndWaitTx'

function fakeTx(hash: string, wait: () => Promise<unknown>) {
  return { hash, wait }
}

describe('sendAndWaitTx', () => {
  it('returns success with logs on a confirmed receipt', async () => {
    const logs = [{ address: '0x1' }]
    const send = vi.fn().mockResolvedValue(fakeTx('0xabc', () => Promise.resolve({ status: 1, logs })))
    const onSubmitted = vi.fn()

    const result = await sendAndWaitTx(send, onSubmitted)

    expect(result.outcome).toBe('success')
    expect(result.hash).toBe('0xabc')
    expect(result.logs).toBe(logs)
    expect(onSubmitted).toHaveBeenCalledWith('0xabc')
  })

  it('returns reverted on a status-0 receipt', async () => {
    const send = vi.fn().mockResolvedValue(fakeTx('0xdef', () => Promise.resolve({ status: 0, logs: [] })))
    const result = await sendAndWaitTx(send)
    expect(result.outcome).toBe('reverted')
    expect(result.hash).toBe('0xdef')
  })

  it('returns timeout when the wait times out (hash preserved)', async () => {
    const send = vi.fn().mockResolvedValue(
      fakeTx('0x111', () => Promise.reject({ code: 'TIMEOUT' })),
    )
    const result = await sendAndWaitTx(send)
    expect(result.outcome).toBe('timeout')
    expect(result.hash).toBe('0x111')
    expect(result.errorDetails).toContain('0x111')
  })

  it('returns rejected when the user declines in the wallet', async () => {
    const send = vi.fn().mockRejectedValue({ code: 'ACTION_REJECTED' })
    const result = await sendAndWaitTx(send)
    expect(result.outcome).toBe('rejected')
  })

  it('returns error on any other failure', async () => {
    const send = vi.fn().mockRejectedValue(new Error('insufficient funds'))
    const result = await sendAndWaitTx(send)
    expect(result.outcome).toBe('error')
    expect(result.errorMessage).toBeTruthy()
  })
})
