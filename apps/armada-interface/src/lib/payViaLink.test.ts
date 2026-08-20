// ABOUTME: Unit tests for the pay-via-link plumbing — URL build/parse, expiry, id, revoke stub.
// ABOUTME: Address validation reuses the app's isShieldedAddress (0zk shape check).

import { afterEach, describe, expect, it } from 'vitest'
import {
  REQUEST_LINK_EXPIRY_OPTIONS,
  buildPayViaLinkUrl,
  clearPendingPayViaLink,
  createPaymentRequestId,
  formatPaymentLinkExpiry,
  isPaymentLinkRevoked,
  parsePayViaLinkSearch,
  readPendingPayViaLink,
  requestLinkExpiryMs,
  writePendingPayViaLink,
} from './payViaLink'

// A shape-valid 0zk address (isShieldedAddress: /^0zk[a-zA-Z0-9]{32,}$/).
const VALID_0ZK = '0zk1testrecipientaddress0000000000000000000000'
const NOW = 1_700_000_000_000
const HOUR = 3_600_000

afterEach(() => {
  window.sessionStorage.clear()
})

describe('buildPayViaLinkUrl', () => {
  it('sets to/id/expires and points at /pay-via-link', () => {
    const url = new URL(
      buildPayViaLinkUrl({ recipientAddress: VALID_0ZK, requestId: 'req_a', expiresAt: NOW }),
    )
    expect(url.pathname).toBe('/pay-via-link')
    expect(url.searchParams.get('to')).toBe(VALID_0ZK)
    expect(url.searchParams.get('id')).toBe('req_a')
    expect(url.searchParams.get('expires')).toBe(String(NOW))
  })

  it('omits amount + note when absent, includes + trims them when present', () => {
    const without = new URL(
      buildPayViaLinkUrl({ recipientAddress: VALID_0ZK, requestId: 'req_a', expiresAt: NOW }),
    )
    expect(without.searchParams.has('amount')).toBe(false)
    expect(without.searchParams.has('note')).toBe(false)

    const withExtras = new URL(
      buildPayViaLinkUrl({
        recipientAddress: VALID_0ZK,
        requestId: 'req_a',
        expiresAt: NOW,
        amount: '  12.5  ',
        note: '  Invoice 7  ',
      }),
    )
    expect(withExtras.searchParams.get('amount')).toBe('12.5')
    expect(withExtras.searchParams.get('note')).toBe('Invoice 7')
  })
})

describe('parsePayViaLinkSearch', () => {
  function search(params: Record<string, string>): string {
    return `?${new URLSearchParams(params).toString()}`
  }

  it('accepts a well-formed link (with amount + note)', () => {
    const result = parsePayViaLinkSearch(
      search({ to: VALID_0ZK, id: 'req_a', expires: String(NOW + HOUR), amount: '25', note: 'hi' }),
      NOW,
    )
    expect(result).toEqual({
      status: 'ok',
      params: { recipient: VALID_0ZK, requestId: 'req_a', expiresAt: NOW + HOUR, amount: '25', note: 'hi' },
    })
  })

  it('accepts a link without an amount (amount-less request)', () => {
    const result = parsePayViaLinkSearch(
      search({ to: VALID_0ZK, id: 'req_a', expires: String(NOW + HOUR) }),
      NOW,
    )
    expect(result.status).toBe('ok')
    if (result.status === 'ok') expect(result.params.amount).toBeUndefined()
  })

  it('rejects a non-shielded recipient as invalid', () => {
    const result = parsePayViaLinkSearch(
      search({ to: '0xabc', id: 'req_a', expires: String(NOW + HOUR) }),
      NOW,
    )
    expect(result.status).toBe('invalid')
  })

  it('rejects a missing id and a non-numeric expiry as invalid', () => {
    expect(
      parsePayViaLinkSearch(search({ to: VALID_0ZK, id: '', expires: String(NOW + HOUR) }), NOW).status,
    ).toBe('invalid')
    expect(
      parsePayViaLinkSearch(search({ to: VALID_0ZK, id: 'req_a', expires: 'soon' }), NOW).status,
    ).toBe('invalid')
  })

  it('reports expired when the timestamp is at or before now', () => {
    const result = parsePayViaLinkSearch(
      search({ to: VALID_0ZK, id: 'req_a', expires: String(NOW - 1) }),
      NOW,
    )
    expect(result).toEqual({ status: 'expired', expiresAt: NOW - 1 })
  })

  it('rejects a malformed or non-positive amount as invalid', () => {
    for (const amount of ['abc', '-5', '0']) {
      const result = parsePayViaLinkSearch(
        search({ to: VALID_0ZK, id: 'req_a', expires: String(NOW + HOUR), amount }),
        NOW,
      )
      expect(result.status, `amount=${amount}`).toBe('invalid')
    }
  })

  it('reports revoked when the id is in the (dormant) revoked set', () => {
    window.sessionStorage.setItem('armada-revoked-payment-links', JSON.stringify(['req_a']))
    const result = parsePayViaLinkSearch(
      search({ to: VALID_0ZK, id: 'req_a', expires: String(NOW + HOUR) }),
      NOW,
    )
    expect(result.status).toBe('revoked')
  })
})

describe('isPaymentLinkRevoked', () => {
  it('is false by default (no UI writes the revoked set today)', () => {
    expect(isPaymentLinkRevoked('req_anything')).toBe(false)
  })
})

describe('requestLinkExpiryMs', () => {
  it('maps each known id to its ms and falls back to 7d', () => {
    expect(requestLinkExpiryMs('1d')).toBe(86_400_000)
    expect(requestLinkExpiryMs('7d')).toBe(7 * 86_400_000)
    expect(requestLinkExpiryMs('30d')).toBe(30 * 86_400_000)
    expect(REQUEST_LINK_EXPIRY_OPTIONS).toHaveLength(3)
  })
})

describe('createPaymentRequestId', () => {
  it('is req_-prefixed and unique per call', () => {
    const a = createPaymentRequestId()
    const b = createPaymentRequestId()
    expect(a).toMatch(/^req_/)
    expect(a).not.toBe(b)
  })
})

describe('pending pay-via-link hand-off', () => {
  const params = { recipient: VALID_0ZK, requestId: 'req_a', expiresAt: NOW, amount: '10', note: 'x' }

  it('roundtrips through session storage and clears', () => {
    expect(readPendingPayViaLink()).toBeNull()
    writePendingPayViaLink(params)
    expect(readPendingPayViaLink()).toEqual(params)
    clearPendingPayViaLink()
    expect(readPendingPayViaLink()).toBeNull()
  })

  it('returns null for a structurally incomplete stored payload', () => {
    window.sessionStorage.setItem('armada-pending-pay-via-link', JSON.stringify({ recipient: VALID_0ZK }))
    expect(readPendingPayViaLink()).toBeNull()
  })
})

describe('formatPaymentLinkExpiry', () => {
  it('renders Expired / singular / plural', () => {
    expect(formatPaymentLinkExpiry(NOW - 1, NOW)).toBe('Expired')
    expect(formatPaymentLinkExpiry(NOW + HOUR, NOW)).toBe('Expires in 1 day')
    expect(formatPaymentLinkExpiry(NOW + 3 * 86_400_000, NOW)).toBe('Expires in 3 days')
  })
})
