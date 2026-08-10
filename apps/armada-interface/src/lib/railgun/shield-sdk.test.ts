// ABOUTME: Unit test for createShieldRequestSdk — maps the @armada/sdk ShieldRequest into the interface's
// ABOUTME: ShieldRequestData shape (the drop-in for the engine builder) and validates its inputs.

import { describe, it, expect, vi, beforeEach } from 'vitest'

const hoisted = vi.hoisted(() => ({ buildShieldRequest: vi.fn() }))
vi.mock('@armada/sdk', () => ({
  buildShieldRequest: hoisted.buildShieldRequest,
  initPoseidonPromise: Promise.resolve(),
}))

import { createShieldRequestSdk } from './shield-sdk'

const NPK = '0x' + 'ab'.repeat(32)
const SHIELD_KEY = '0x' + 'cd'.repeat(32)
const BUNDLE = ['0x' + '1'.repeat(64), '0x' + '2'.repeat(64), '0x' + '3'.repeat(64)]
const ZK = '0zk1q' + 'a'.repeat(60)
const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'
const KEY = '11'.repeat(32)

describe('createShieldRequestSdk', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('maps the SDK ShieldRequest into ShieldRequestData and passes the key as bytes', async () => {
    hoisted.buildShieldRequest.mockResolvedValue({
      shieldRequest: {
        preimage: { npk: NPK, token: { tokenType: 0, tokenAddress: USDC, tokenSubID: 0n }, value: 5_000_000n },
        ciphertext: { encryptedBundle: BUNDLE, shieldKey: SHIELD_KEY },
      },
      random: 'ef'.repeat(16),
    })

    const r = await createShieldRequestSdk(ZK, 5_000_000n, USDC, KEY)

    expect(r).toEqual({
      npk: NPK,
      value: 5_000_000n,
      encryptedBundle: BUNDLE,
      shieldKey: SHIELD_KEY,
      random: 'ef'.repeat(16),
    })
    expect(hoisted.buildShieldRequest).toHaveBeenCalledWith(
      { railgunAddress: ZK, amount: 5_000_000n, tokenAddress: USDC },
      expect.any(Uint8Array),
    )
    // No random injected — the production path lets the SDK generate a fresh salt per deposit.
    expect(hoisted.buildShieldRequest.mock.calls[0]!.length).toBe(2)
  })

  it('rejects a non-0zk recipient before building', async () => {
    await expect(createShieldRequestSdk('0xnot-a-zk', 1n, USDC, KEY)).rejects.toThrow(/0zk address/)
    expect(hoisted.buildShieldRequest).not.toHaveBeenCalled()
  })

  it('rejects a non-positive amount', async () => {
    await expect(createShieldRequestSdk(ZK, 0n, USDC, KEY)).rejects.toThrow(/amount must be positive/)
  })
})
