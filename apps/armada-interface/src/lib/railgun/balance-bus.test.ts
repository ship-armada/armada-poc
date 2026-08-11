// ABOUTME: Unit tests for the SDK-native balance-change + scan-status buses — fan-out, unsubscribe,
// ABOUTME: listener-error isolation, and resetSyncState clearing both listener sets.

import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  subscribeBalanceUpdates,
  emitBalanceChange,
  subscribeScanStatus,
  emitScanStatus,
  resetSyncState,
} from './balance-bus'

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

describe('scan-status bus', () => {
  it('fans a scan-status event out to every subscriber', () => {
    // WHY: `useShieldedBalanceSync` drives `syncStateAtom` (the sync gate/banner) solely off this
    // channel — every subscriber must see each scan lifecycle transition or the gate can hang.
    const a = vi.fn()
    const b = vi.fn()
    subscribeScanStatus(a)
    subscribeScanStatus(b)
    emitScanStatus({ status: 'syncing', progress: 0.5 })
    expect(a).toHaveBeenCalledWith({ status: 'syncing', progress: 0.5 })
    expect(b).toHaveBeenCalledWith({ status: 'syncing', progress: 0.5 })
  })

  it('unsubscribe detaches a single scan-status listener', () => {
    const a = vi.fn()
    const b = vi.fn()
    const off = subscribeScanStatus(a)
    subscribeScanStatus(b)
    off()
    emitScanStatus({ status: 'complete', progress: 1 })
    expect(a).not.toHaveBeenCalled()
    expect(b).toHaveBeenCalledOnce()
  })

  it('isolates a throwing scan-status listener from the others', () => {
    const bad = vi.fn(() => { throw new Error('boom') })
    const good = vi.fn()
    subscribeScanStatus(bad)
    subscribeScanStatus(good)
    expect(() => emitScanStatus({ status: 'failed', progress: 0 })).not.toThrow()
    expect(good).toHaveBeenCalledOnce()
  })

  it('resetSyncState clears scan-status listeners too', () => {
    const a = vi.fn()
    subscribeScanStatus(a)
    resetSyncState()
    emitScanStatus({ status: 'syncing', progress: 0 })
    expect(a).not.toHaveBeenCalled()
  })
})
