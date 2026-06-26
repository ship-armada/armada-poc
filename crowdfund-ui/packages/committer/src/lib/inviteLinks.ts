// ABOUTME: EIP-712 invite link creation, encoding, and IndexedDB storage.
// ABOUTME: Pure functions for invite link lifecycle — no React dependency.

import { tryGetChecksumAddress } from '@armada/crowdfund-shared'

/** Max hop index in the URL — matches `HOP_CONFIGS.length - 1`. Anything
 * outside this band can't represent a real inviter so we reject pre-contract. */
const MAX_HOP_INDEX = 2

/** Standard EVM ECDSA signature: 65 bytes (r,s,v) → 130 hex chars + `0x`. */
const SIGNATURE_HEX_LENGTH = 132

/** Strict non-negative integer parse — rejects `"12abc"`, `""`, scientific
 * notation, leading `+`, etc. that `parseInt` silently accepts. */
function parseStrictNonNegativeInt(raw: string): number | null {
  if (!/^\d+$/.test(raw)) return null
  const n = Number(raw)
  if (!Number.isSafeInteger(n)) return null
  return n
}

export interface InviteLinkData {
  inviter: string
  fromHop: number
  nonce: number
  deadline: number
  signature: string
}

export interface StoredInviteLink extends InviteLinkData {
  createdAt: number
  status: 'pending' | 'redeemed' | 'revoked' | 'expired'
}

export function getEIP712Domain(chainId: number, contractAddress: string) {
  return {
    name: 'ArmadaCrowdfund',
    version: '1',
    chainId,
    verifyingContract: contractAddress,
  }
}

export const INVITE_TYPES = {
  Invite: [
    { name: 'inviter', type: 'address' },
    { name: 'fromHop', type: 'uint8' },
    { name: 'nonce', type: 'uint256' },
    { name: 'deadline', type: 'uint256' },
  ],
}

export function encodeInviteUrl(data: InviteLinkData): string {
  const params = new URLSearchParams({
    inviter: data.inviter,
    fromHop: String(data.fromHop),
    nonce: String(data.nonce),
    deadline: String(data.deadline),
    sig: data.signature,
  })
  const path = `/invite?${params.toString()}`
  // Emit an absolute URL so a pasted link resolves to the current deployment
  // (e.g. https://fund.armada.blue/invite?…) instead of being interpreted
  // as a relative path against whatever destination the user pastes into —
  // most notably the browser address bar, which falls back to `file:///` for
  // a bare leading-slash path.
  if (typeof window !== 'undefined' && window.location?.origin) {
    return `${window.location.origin}${path}`
  }
  return path
}

export function decodeInviteUrl(searchParams: URLSearchParams): InviteLinkData | null {
  const inviterRaw = searchParams.get('inviter')
  const fromHopStr = searchParams.get('fromHop')
  const nonceStr = searchParams.get('nonce')
  const deadlineStr = searchParams.get('deadline')
  const signatureRaw = searchParams.get('sig')

  if (!inviterRaw || !fromHopStr || !nonceStr || !deadlineStr || !signatureRaw) return null

  // Inviter must be a checksummable address. `tryGetChecksumAddress` covers
  // format (0x + 40 hex) AND EIP-55 checksum so a typoed pasted link gets
  // rejected here instead of as an opaque revert during the contract call.
  const inviter = tryGetChecksumAddress(inviterRaw.trim())
  if (!inviter) return null

  const fromHop = parseStrictNonNegativeInt(fromHopStr)
  const nonce = parseStrictNonNegativeInt(nonceStr)
  const deadline = parseStrictNonNegativeInt(deadlineStr)
  if (fromHop === null || nonce === null || deadline === null) return null
  if (fromHop > MAX_HOP_INDEX) return null

  // Signature must be the canonical 65-byte ECDSA hex string. `recoverAddress`
  // downstream would already reject malformed inputs, but rejecting at parse
  // time means a hostile / malformed link doesn't show the user a half-broken
  // landing page before failing.
  const signature = signatureRaw.trim()
  if (signature.length !== SIGNATURE_HEX_LENGTH) return null
  if (!/^0x[a-fA-F0-9]+$/.test(signature)) return null

  return { inviter, fromHop, nonce, deadline, signature }
}

// IndexedDB helpers
const DB_NAME = 'armada-invite-links'
const STORE_NAME = 'links'
const DB_VERSION = 1

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION)
    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, { keyPath: ['inviter', 'nonce'] })
        store.createIndex('inviter', 'inviter', { unique: false })
      }
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

export async function storeInviteLink(link: StoredInviteLink): Promise<void> {
  const db = await openDB()
  // Lowercase the inviter on write so the keyPath + `inviter` index always match
  // the lowercased lookups in getStoredInviteLinks / updateInviteLinkStatus,
  // even if a caller passes a checksummed address.
  const normalized: StoredInviteLink = { ...link, inviter: link.inviter.toLowerCase() }
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite')
    tx.objectStore(STORE_NAME).put(normalized)
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
}

export async function getStoredInviteLinks(inviter: string): Promise<StoredInviteLink[]> {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly')
    const index = tx.objectStore(STORE_NAME).index('inviter')
    const request = index.getAll(inviter.toLowerCase())
    request.onsuccess = () => resolve(request.result as StoredInviteLink[])
    request.onerror = () => reject(request.error)
  })
}

export async function updateInviteLinkStatus(
  inviter: string,
  nonce: number,
  status: StoredInviteLink['status'],
): Promise<void> {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite')
    const store = tx.objectStore(STORE_NAME)
    const getRequest = store.get([inviter.toLowerCase(), nonce])
    getRequest.onsuccess = () => {
      const link = getRequest.result as StoredInviteLink | undefined
      if (link) {
        link.status = status
        store.put(link)
      }
    }
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
}

/** Block timestamp for signing, falling back to wall-clock when state hasn't
 *  hydrated yet (blockTimestamp === 0) — never sign a 1970-relative deadline. */
export function effectiveTimestamp(blockTimestamp: number): number {
  return blockTimestamp > 0 ? blockTimestamp : Math.floor(Date.now() / 1000)
}

/**
 * Recompute each stored link's status against chain truth:
 *  - any link whose nonce was redeemed on-chain becomes `redeemed` (terminal —
 *    never re-expired), unless it was explicitly revoked;
 *  - only a still-`pending` link past its deadline becomes `expired`.
 * Pure — the hook persists the newly-redeemed ones separately.
 */
export function classifyStoredLinks(
  stored: StoredInviteLink[],
  redeemedNonces: ReadonlySet<number>,
  blockTimestamp: number,
): StoredInviteLink[] {
  return stored.map((link) => {
    if (redeemedNonces.has(link.nonce) && link.status !== 'revoked') {
      return { ...link, status: 'redeemed' as const }
    }
    if (link.status === 'pending' && link.deadline < blockTimestamp) {
      return { ...link, status: 'expired' as const }
    }
    return link
  })
}

/**
 * Random invite nonce in the JS safe-integer range. The contract treats `nonce`
 * as an arbitrary per-inviter `uint256` key, so any unused value is valid. A
 * large random space makes cross-device collisions (two devices each minting a
 * pending link) astronomically unlikely WITHOUT any on-chain coordination —
 * pending links touch no chain state, so a sequential "max + 1" scheme can't see
 * another device's outstanding links. Staying under 2^53 keeps `nonce` a plain
 * `number` end to end (signing, URL, IndexedDB key). Never returns 0 — that's
 * reserved on-chain for direct (non-link) invites.
 */
export function randomSafeNonce(): number {
  const buf = new Uint32Array(2)
  crypto.getRandomValues(buf)
  // 53-bit value: 21 high bits from buf[0], 32 low bits from buf[1].
  const n = (buf[0] % 0x20_0000) * 0x1_0000_0000 + buf[1]
  return n === 0 ? 1 : n
}

/**
 * Allocate a fresh invite nonce: pick at random and confirm it is free on-chain
 * via `isUsedOnChain` (which should read the contract's `usedNonces` mapping —
 * authoritative for both redeemed and revoked nonces, immune to indexer lag).
 * Re-rolls on the (astronomically rare) clash with an already-consumed value.
 */
export async function pickInviteNonce(
  isUsedOnChain: (nonce: number) => Promise<boolean>,
): Promise<number> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const candidate = randomSafeNonce()
    if (!(await isUsedOnChain(candidate))) return candidate
  }
  throw new Error('Could not allocate a free invite nonce')
}
