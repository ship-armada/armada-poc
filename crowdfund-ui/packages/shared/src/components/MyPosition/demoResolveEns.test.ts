// ABOUTME: Tests for the showcase-only ENS resolver used by demo invite surfaces.
// ABOUTME: It must return an obviously-fake but well-formed address, never a random one.
import { describe, it, expect } from 'vitest'
import { isAddress } from 'ethers'
import { demoResolveEns, DEMO_ENS_ADDRESS } from './myPositionDemo'

describe('demoResolveEns', () => {
  it('resolves any name to the fixed placeholder address', async () => {
    expect(await demoResolveEns('friend.eth')).toEqual({ address: DEMO_ENS_ADDRESS })
    expect(isAddress(DEMO_ENS_ADDRESS)).toBe(true)
  })

  it("fails 'invalid.eth' so the demo can show the error state", async () => {
    expect(await demoResolveEns('invalid.eth')).toHaveProperty('error')
  })
})
