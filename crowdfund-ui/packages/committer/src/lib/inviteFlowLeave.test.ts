// ABOUTME: Unit tests for the /invite flow's leave guard — asks before leaving mid-transaction.
// ABOUTME: The prompt must tell the user how to resume (reopen the invite link), and never fire when idle.
import { describe, it, expect, vi, afterEach } from 'vitest'
import { confirmLeaveInviteFlow } from './inviteFlowLeave'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('confirmLeaveInviteFlow', () => {
  it('allows leaving without asking when nothing is in flight', () => {
    const confirm = vi.fn()
    vi.stubGlobal('confirm', confirm)
    expect(confirmLeaveInviteFlow(false)).toBe(true)
    expect(confirm).not.toHaveBeenCalled()
  })

  it('asks mid-transaction, pointing back to the invite link to resume', () => {
    const confirm = vi.fn().mockReturnValue(true)
    vi.stubGlobal('confirm', confirm)
    expect(confirmLeaveInviteFlow(true)).toBe(true)
    expect(confirm).toHaveBeenCalledOnce()
    expect(confirm.mock.calls[0][0]).toMatch(/invite link/)
  })

  it('stays when the user declines', () => {
    vi.stubGlobal('confirm', vi.fn().mockReturnValue(false))
    expect(confirmLeaveInviteFlow(true)).toBe(false)
  })
})
