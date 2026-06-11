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
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite')
    tx.objectStore(STORE_NAME).put(link)
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

export async function getNextNonce(inviter: string): Promise<number> {
  const links = await getStoredInviteLinks(inviter)
  if (links.length === 0) return 1
  return Math.max(...links.map((l) => l.nonce)) + 1
}
