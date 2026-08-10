// ABOUTME: Watcher quick-sync client — the QuickSyncEvents callback supplied to the engine (initForWallet arg 4).
// ABOUTME: Paginates GET /v1/quick-sync/:hubChainId and hands the engine our pre-indexed AccumulatedEvents; any failure degrades silently to the engine's slow on-chain scan.

import type { AccumulatedEvents, QuickSyncEvents } from '@railgun-community/engine'
import { getNetworkConfig } from '@/config/network'
import { track, trackError } from '@/lib/telemetry'

// TXIDVersion is a string enum in the engine; compare by value so this module never triggers a
// runtime import of @railgun-community/engine (which crashes under jsdom — see wallet.ts).
const TXID_VERSION_V2 = 'V2_PoseidonMerkle'

// Per-request timeout. The engine's slow scan is the safety net, so we fail fast rather than let a
// wedged indexer stall wallet warm-up.
const QUICK_SYNC_REQUEST_TIMEOUT_MS = 30_000

// Defensive upper bound on pages. The non-advancing-cursor guard is the real loop protection; this
// is a backstop against a misbehaving server that keeps advancing by a single block.
const QUICK_SYNC_MAX_PAGES = 100_000

/** A quick-sync page: engine AccumulatedEvents fields + the watcher's pagination cursors. */
interface QuickSyncPage extends AccumulatedEvents {
  servedThroughBlock: number
  indexedThrough: number
}

/** Fresh empty result each call — never share a mutable object with the engine. */
function emptyEvents(): AccumulatedEvents {
  return { commitmentEvents: [], unshieldEvents: [], nullifierEvents: [] }
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null
}

// Per-event shape checks against the engine 9.5.1 types. Not the security boundary (WI-4 merkleroot
// validation + WI-5 nullifier cross-check are) — just a first-line sanity gate so obviously-wrong
// payloads degrade to slow scan instead of being fed to the engine.
function isCommitmentEvent(e: unknown): boolean {
  return (
    isRecord(e) &&
    typeof e.txid === 'string' &&
    typeof e.treeNumber === 'number' &&
    typeof e.startPosition === 'number' &&
    Array.isArray(e.commitments) &&
    typeof e.blockNumber === 'number'
  )
}

function isNullifierEvent(e: unknown): boolean {
  return (
    isRecord(e) &&
    typeof e.nullifier === 'string' &&
    typeof e.treeNumber === 'number' &&
    typeof e.blockNumber === 'number'
  )
}

function isUnshieldEvent(e: unknown): boolean {
  return (
    isRecord(e) &&
    typeof e.txid === 'string' &&
    typeof e.toAddress === 'string' &&
    typeof e.amount === 'string' &&
    typeof e.blockNumber === 'number'
  )
}

function isValidPage(x: unknown): x is QuickSyncPage {
  if (!isRecord(x)) return false
  if (!Array.isArray(x.commitmentEvents) || !Array.isArray(x.unshieldEvents) || !Array.isArray(x.nullifierEvents)) {
    return false
  }
  if (typeof x.servedThroughBlock !== 'number' || typeof x.indexedThrough !== 'number') return false
  return (
    x.commitmentEvents.every(isCommitmentEvent) &&
    x.unshieldEvents.every(isUnshieldEvent) &&
    x.nullifierEvents.every(isNullifierEvent)
  )
}

async function fetchPage(url: string): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), QUICK_SYNC_REQUEST_TIMEOUT_MS)
  try {
    return await fetch(url, { signal: controller.signal, headers: { accept: 'application/json' } })
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Quick-sync source for the Railgun engine. Signature matches the SDK's `QuickSyncEvents`.
 *
 * Degrades to an empty result (→ engine slow scan) in every non-happy case:
 *   - non-V2 txid version (the watcher indexes our V2 pool only)
 *   - `indexerUrl` unset (B4 — the app must be fully functional without an indexer)
 *   - a non-hub chain (all Railgun events live on the hub pool)
 *   - any fetch / HTTP / parse / shape-validation failure at any page
 *
 * NEVER throws: a throw out of this callback would abort engine init. Genuine failures (as opposed
 * to the config-driven early returns) are surfaced via telemetry so a broken indexer is diagnosable.
 *
 * OBSERVABILITY: emits one `shielded.quicksync` telemetry line per attempt (dev + prod console) so
 * activation vs fallback is visible without reading the Network tab —
 * `{ outcome: 'served', commitments, … }` (commitments>0 ⇒ the watcher delivered events),
 * `{ outcome: 'no-indexer' }`, or `{ outcome: 'fell-back', reason }` (paired with a shielded.quicksync
 * error). Grep the console for `shielded.quicksync`.
 */
export const quickSyncEventsClient: QuickSyncEvents = async (
  txidVersion,
  chain,
  startingBlock,
): Promise<AccumulatedEvents> => {
  // Config-driven early returns — normal operation, not failures, so stay silent.
  if ((txidVersion as unknown as string) !== TXID_VERSION_V2) return emptyEvents()

  const cfg = getNetworkConfig()
  const indexerUrl = cfg.indexerUrl
  if (!indexerUrl) {
    // The common B4 case — no watcher configured. One info line so "quick sync off → slow scan"
    // is visible rather than inferred from the absence of network requests.
    track('shielded.quicksync', { outcome: 'no-indexer' })
    return emptyEvents()
  }

  const hubChainId = cfg.hub.chainId
  if (chain.id !== hubChainId) return emptyEvents()

  const base = indexerUrl.replace(/\/+$/, '')

  try {
    const acc = emptyEvents()
    let cursor = Math.max(0, Math.floor(startingBlock))
    let pages = 0
    let throughBlock = cursor

    for (let page = 0; page < QUICK_SYNC_MAX_PAGES; page += 1) {
      const url = `${base}/v1/quick-sync/${hubChainId}?startingBlock=${cursor}`
      const res = await fetchPage(url)
      if (!res.ok) {
        trackError('shielded.quicksync', new Error(`quick-sync HTTP ${res.status}`))
        track('shielded.quicksync', { outcome: 'fell-back', reason: `http-${res.status}`, pages })
        return emptyEvents()
      }

      const json: unknown = await res.json()
      if (!isValidPage(json)) {
        trackError('shielded.quicksync', new Error('quick-sync page failed shape validation'))
        track('shielded.quicksync', { outcome: 'fell-back', reason: 'invalid-page', pages })
        return emptyEvents()
      }

      acc.commitmentEvents.push(...json.commitmentEvents)
      acc.unshieldEvents.push(...json.unshieldEvents)
      acc.nullifierEvents.push(...json.nullifierEvents)
      pages += 1
      throughBlock = json.servedThroughBlock

      // Fully caught up: the server has served every fully-indexed block.
      if (json.servedThroughBlock >= json.indexedThrough) break
      // Defensive: the cursor must move forward, else a server bug would loop us forever.
      if (json.servedThroughBlock < cursor) break
      cursor = json.servedThroughBlock + 1
    }

    // Activation signal: `commitments` > 0 means the watcher actually delivered events.
    track('shielded.quicksync', {
      outcome: 'served',
      pages,
      commitments: acc.commitmentEvents.length,
      unshields: acc.unshieldEvents.length,
      nullifiers: acc.nullifierEvents.length,
      throughBlock,
    })
    return acc
  } catch (err) {
    // Fetch abort / network error / JSON parse failure → slow-scan fallback. Never rethrow.
    trackError('shielded.quicksync', err)
    track('shielded.quicksync', { outcome: 'fell-back', reason: 'fetch-error' })
    return emptyEvents()
  }
}
