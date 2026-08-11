// ABOUTME: Unit tests for the SDK-native balance-change bus — fan-out, unsubscribe, listener-error
// ABOUTME: isolation, and resetSyncState clearing the listener set.

import { describe, it, expect, vi, afterEach } from 'vitest'
import { subscribeBalanceUpdates, emitBalanceChange, resetSyncState } from './balance-bus'

afterEach(() => resetSyncState())

describe('balance-bus', () => {
  it('fans an event out to every subscriber', async () => {
    const a = vi.fn()
    const b = vi.fn()
    await subscribeBalanceUpdates(a)
    await subscribeBalanceUpdates(b)
    emitBalanceChange({ reason: 'scan' })
    expect(a).toHaveBeenCalledWith({ reason: 'scan' })
    expect(b).toHaveBeenCalledWith({ reason: 'scan' })
  })

  it('unsubscribe detaches a single listener', async () => {
    const a = vi.fn()
    const b = vi.fn()
    const off = await subscribeBalanceUpdates(a)
    await subscribeBalanceUpdates(b)
    off()
    emitBalanceChange({ reason: 'balance' })
    expect(a).not.toHaveBeenCalled()
    expect(b).toHaveBeenCalledOnce()
  })

  it('isolates a throwing listener from the others', async () => {
    const bad = vi.fn(() => { throw new Error('boom') })
    const good = vi.fn()
    await subscribeBalanceUpdates(bad)
    await subscribeBalanceUpdates(good)
    expect(() => emitBalanceChange({ reason: 'note' })).not.toThrow()
    expect(good).toHaveBeenCalledOnce()
  })

  it('resetSyncState clears all listeners', async () => {
    const a = vi.fn()
    await subscribeBalanceUpdates(a)
    resetSyncState()
    emitBalanceChange({ reason: 'scan' })
    expect(a).not.toHaveBeenCalled()
  })
})
