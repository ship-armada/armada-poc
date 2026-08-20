// ABOUTME: Atoms for created payment-request links — the in-memory list + the "re-open at Share step" intent.
// ABOUTME: The list is hydrated from the encrypted per-wallet store by useRequestLinks; RequestModal consumes the intent.

import { atom } from 'jotai'
import type { RequestLinkRecord } from '@/lib/shielded/requestLinks'

/** Created payment-request links for the active wallet, newest first. Hydrated on unlock. */
export const requestLinksAtom = atom<RequestLinkRecord[]>([])

/**
 * When set (by clicking a "Payment link created" activity row), RequestModal opens directly on the
 * Share-link step seeded from this record, then clears it. Carries no funds/keys.
 */
export const requestShareIntentAtom = atom<RequestLinkRecord | null>(null)
