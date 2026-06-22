// ABOUTME: sessionStorage persistence for broadcast-but-unconfirmed transactions.
// ABOUTME: Lets the app resume-watch a tx (and surface a pending indicator) after a reload.

/** A transaction that has been broadcast (has a hash) but not yet confirmed. */
export interface PendingTx {
  chainId: number
  address: string
  txHash: string
  label: string
  sentAt: number
}

const KEY = 'armada.crowdfund.pendingTxs'

/** All persisted pending txs. Returns an empty list if storage is missing or malformed. */
export function loadPendingTxs(): PendingTx[] {
  try {
    const raw = sessionStorage.getItem(KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? (parsed as PendingTx[]) : []
  } catch {
    return []
  }
}

function persist(txs: PendingTx[]): void {
  try {
    sessionStorage.setItem(KEY, JSON.stringify(txs))
  } catch {
    // sessionStorage unavailable / over quota — persistence is best-effort and
    // must never break the tx flow.
  }
}

/** Insert or replace (by txHash) a pending tx. */
export function savePendingTx(tx: PendingTx): void {
  const next = loadPendingTxs().filter((t) => t.txHash !== tx.txHash)
  next.push(tx)
  persist(next)
}

/** Drop a pending tx once it resolves (confirmed or reverted). */
export function removePendingTx(txHash: string): void {
  persist(loadPendingTxs().filter((t) => t.txHash !== txHash))
}

/** Clear all persisted pending txs. */
export function clearPendingTxs(): void {
  try {
    sessionStorage.removeItem(KEY)
  } catch {
    // ignore — see persist()
  }
}
