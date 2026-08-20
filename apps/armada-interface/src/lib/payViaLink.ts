// ABOUTME: Pay-via-link plumbing — builds + parses the shareable payment-request URL that prefills a Send.
// ABOUTME: A link is a self-contained deep link (recipient 0zk + amount + expiry + note); no on-chain or backend state.

import { isShieldedAddress } from '@/lib/address'
import { hasActiveAmount } from '@/utils/amountInput'
import { parseUsdcInput } from '@/lib/format'

const DAY_MS = 86_400_000

export const REQUEST_LINK_EXPIRY_OPTIONS = [
  { id: '1d', label: '1 day', ms: DAY_MS },
  { id: '7d', label: '7 days', ms: 7 * DAY_MS },
  { id: '30d', label: '30 days', ms: 30 * DAY_MS },
] as const

export type RequestLinkExpiryId = (typeof REQUEST_LINK_EXPIRY_OPTIONS)[number]['id']

export const DEFAULT_REQUEST_LINK_EXPIRY_ID: RequestLinkExpiryId = '7d'

export const REQUEST_NOTE_MAX_LENGTH = 120

export function requestLinkExpiryMs(expiryId: RequestLinkExpiryId): number {
  return REQUEST_LINK_EXPIRY_OPTIONS.find((option) => option.id === expiryId)?.ms ?? 7 * DAY_MS
}

/** Client-generated, non-secret request id. Not a security token — it only tags the link. */
export function createPaymentRequestId(): string {
  return `req_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

/**
 * Origin for shareable app URLs. Uses the live host in prod; on localhost an optional
 * `VITE_PUBLIC_APP_ORIGIN` override lets a shared link point at a real host during testing.
 */
export function getPublicAppOrigin(): string {
  const { origin, hostname } = window.location
  const isLocal = hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]'
  if (!isLocal) return origin
  const configured = import.meta.env.VITE_PUBLIC_APP_ORIGIN?.trim()
  return configured ? configured.replace(/\/$/, '') : origin
}

export interface BuildPayViaLinkInput {
  recipientAddress: string
  requestId: string
  expiresAt: number
  amount?: string
  note?: string
}

/** Builds `<origin>/pay-via-link?to=&id=&expires=&amount=&note=`. All params are plaintext. */
export function buildPayViaLinkUrl({
  recipientAddress,
  requestId,
  expiresAt,
  amount,
  note,
}: BuildPayViaLinkInput): string {
  const url = new URL('/pay-via-link', getPublicAppOrigin())
  url.searchParams.set('to', recipientAddress)
  url.searchParams.set('id', requestId)
  url.searchParams.set('expires', String(expiresAt))

  const trimmedAmount = amount?.trim()
  if (trimmedAmount) url.searchParams.set('amount', trimmedAmount)

  const trimmedNote = note?.trim()
  if (trimmedNote) url.searchParams.set('note', trimmedNote)

  return url.toString()
}

/** Human "Expires in N days" label. Note: expiry is a soft nudge — the timestamp is in the link
 *  and only checked client-side, so it can't hard-prevent a payment (the address stays payable). */
export function formatPaymentLinkExpiry(expiresAt: number, now = Date.now()): string {
  const diffMs = expiresAt - now
  if (diffMs <= 0) return 'Expired'
  const diffDays = Math.ceil(diffMs / DAY_MS)
  return diffDays === 1 ? 'Expires in 1 day' : `Expires in ${diffDays} days`
}

export interface PayViaLinkParams {
  recipient: string
  requestId: string
  expiresAt: number
  amount?: string
  note?: string
}

export type PayViaLinkParseResult =
  | { status: 'ok'; params: PayViaLinkParams }
  | { status: 'invalid' }
  | { status: 'expired'; expiresAt: number }
  | { status: 'revoked' }

// ---------------------------------------------------------------------------
// Revocation — PLACEHOLDER. A link can only be truly revoked via shared state
// (a backend list the payer's landing page queries), which does not exist yet.
// The session-scoped store below is dormant: no UI writes to it today (the
// Revoke button is disabled), so `isPaymentLinkRevoked` is always false. It
// exists so the 'revoked' parse branch + the Link-revoked screen are ready to
// wire once real revocation lands. Do NOT present revoke as a guarantee.
// ---------------------------------------------------------------------------
const REVOKED_PAYMENT_LINKS_KEY = 'armada-revoked-payment-links'

function readRevokedPaymentLinkIds(): Set<string> {
  if (typeof window === 'undefined') return new Set()
  try {
    const raw = window.sessionStorage.getItem(REVOKED_PAYMENT_LINKS_KEY)
    if (!raw) return new Set()
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return new Set()
    return new Set(parsed.filter((value): value is string => typeof value === 'string'))
  } catch {
    return new Set()
  }
}

export function isPaymentLinkRevoked(requestId: string): boolean {
  return readRevokedPaymentLinkIds().has(requestId)
}

// ---------------------------------------------------------------------------
// Pending hand-off — carries a parsed link from the payer landing page to the
// dashboard's Send flow across the client navigation (survives a full reload).
// ---------------------------------------------------------------------------
const PENDING_PAY_VIA_LINK_KEY = 'armada-pending-pay-via-link'

export function writePendingPayViaLink(payload: PayViaLinkParams): void {
  if (typeof window === 'undefined') return
  try {
    window.sessionStorage.setItem(PENDING_PAY_VIA_LINK_KEY, JSON.stringify(payload))
  } catch {
    // ignore quota / private mode
  }
}

export function readPendingPayViaLink(): PayViaLinkParams | null {
  if (typeof window === 'undefined') return null
  try {
    const raw = window.sessionStorage.getItem(PENDING_PAY_VIA_LINK_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as PayViaLinkParams
    if (!parsed.recipient || !parsed.requestId || !parsed.expiresAt) return null
    return parsed
  } catch {
    return null
  }
}

export function clearPendingPayViaLink(): void {
  if (typeof window === 'undefined') return
  window.sessionStorage.removeItem(PENDING_PAY_VIA_LINK_KEY)
}

/**
 * Validates a `/pay-via-link` query string. Order matters: structural validity → revoked →
 * expired → amount sanity. `now` is injectable for tests.
 */
export function parsePayViaLinkSearch(search: string, now = Date.now()): PayViaLinkParseResult {
  const params = new URLSearchParams(search)
  const recipient = params.get('to')?.trim() ?? ''
  const requestId = params.get('id')?.trim() ?? ''
  const expiresRaw = params.get('expires')?.trim() ?? ''
  const amount = params.get('amount')?.trim() ?? ''
  const note = params.get('note')?.trim() ?? ''

  const expiresAt = Number.parseInt(expiresRaw, 10)
  if (!isShieldedAddress(recipient) || !requestId || !Number.isFinite(expiresAt) || expiresAt <= 0) {
    return { status: 'invalid' }
  }

  if (isPaymentLinkRevoked(requestId)) return { status: 'revoked' }

  if (expiresAt <= now) return { status: 'expired', expiresAt }

  if (amount) {
    const parsed = parseUsdcInput(amount)
    if (!hasActiveAmount(amount) || parsed.error || parsed.value <= 0n) {
      return { status: 'invalid' }
    }
  }

  return {
    status: 'ok',
    params: {
      recipient,
      requestId,
      expiresAt,
      amount: amount || undefined,
      note: note || undefined,
    },
  }
}
