// ABOUTME: EIP-712 invite link creation, encoding, and IndexedDB storage.
// ABOUTME: Pure functions for invite link lifecycle — no React dependency.

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
  return `/invite?${params.toString()}`
}

export function decodeInviteUrl(searchParams: URLSearchParams): InviteLinkData | null {
  const inviter = searchParams.get('inviter')
  const fromHopStr = searchParams.get('fromHop')
  const nonceStr = searchParams.get('nonce')
  const deadlineStr = searchParams.get('deadline')
  const signature = searchParams.get('sig')

  if (!inviter || !fromHopStr || !nonceStr || !deadlineStr || !signature) return null

  const fromHop = parseInt(fromHopStr, 10)
  const nonce = parseInt(nonceStr, 10)
  const deadline = parseInt(deadlineStr, 10)

  if (isNaN(fromHop) || isNaN(nonce) || isNaN(deadline)) return null
  if (!inviter.startsWith('0x') || inviter.length !== 42) return null
  if (!signature.startsWith('0x')) return null

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
