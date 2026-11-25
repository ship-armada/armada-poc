// ABOUTME: Tests for the first-sale refund address resolution: built-in on mainnet, env override elsewhere.
// ABOUTME: Guards that a Netlify setting can never redirect the mainnet refund target.

import { describe, expect, it } from 'vitest'
import { SALE1_CROWDFUND_MAINNET, resolveRefundOnlyCrowdfundAddress } from './refundOnly'

const OVERRIDE = '0x5FbDB2315678afecb367f032d93F642f64180aa3'

describe('resolveRefundOnlyCrowdfundAddress', () => {
  // WHY: the panel asks users to send a transaction to this address, so on mainnet it is the
  // immutable Sale 1 contract, never something a deploy setting can change.
  it('always uses the built-in Sale 1 address on mainnet, ignoring any override', () => {
    expect(resolveRefundOnlyCrowdfundAddress('mainnet', undefined)).toBe(SALE1_CROWDFUND_MAINNET)
    expect(resolveRefundOnlyCrowdfundAddress('mainnet', OVERRIDE)).toBe(SALE1_CROWDFUND_MAINNET)
  })

  // WHY: Sepolia and local rehearsals point the feature at their own cancelled crowdfund.
  it('uses a valid override off mainnet', () => {
    expect(resolveRefundOnlyCrowdfundAddress('sepolia', OVERRIDE)).toBe(OVERRIDE)
    expect(resolveRefundOnlyCrowdfundAddress('local', `  ${OVERRIDE}  `)).toBe(OVERRIDE)
  })

  // WHY: with no (or a malformed) override there is no first sale to refund on that network.
  it('turns the feature off when the override is unset or malformed off mainnet', () => {
    expect(resolveRefundOnlyCrowdfundAddress('sepolia', undefined)).toBeNull()
    expect(resolveRefundOnlyCrowdfundAddress('local', '')).toBeNull()
    expect(resolveRefundOnlyCrowdfundAddress('sepolia', '0x1234')).toBeNull()
  })
})
