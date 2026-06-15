# `relayer/state/` — relayer persistent state

This directory holds the relayer's persistent state for the CCTP scan loop. The directory itself
is committed (so a fresh clone has the README) but the state files inside are gitignored.

All state files use the same atomic tmpfile + rename write primitive (`lib/json-state-store.ts`)
with per-key write serialisation and schema-versioned payloads, so a `kill -9` mid-write never
leaves a torn file. Files:

| File | Written by | Purpose |
|------|-----------|---------|
| `cursor-<chain>.json` | `lib/cursor-store.ts` | Per-chain scan cursor (highest block ingested). |
| `pending-<chain>.json` | `lib/pending-state-store.ts` | iris relay's in-flight messages + delivered-dedup records. |
| `cctp-retry-queue.json` | `lib/retry-queue-store.ts` | mock CCTP relay's failed-message retry queue. |
| `deadletter-<chain>.json` | `lib/dead-letter-store.ts` | Messages permanently given up on (surfaced as `/health` `deadLetterCount`). |
| `railgun-db/` | Railgun engine | The relayer's `0zk` wallet LevelDB (broadcaster-fee viewing key). |

Deleting any file is operator-actionable recovery: the relayer re-bootstraps that piece of state
(the scanner re-discovers messages from chain via the cursor). The exceptions worth understanding
are below.

## Pending / retry / dead-letter files

- **`pending-<chain>.json`** — survives a restart so an in-flight message awaiting Iris attestation
  isn't forgotten, and a delivered message isn't re-relayed (it's in the processed-dedup set, which
  is pruned by age). Schema v3 (`{ key, at }` processed records; v1/v2 auto-migrate forward).
- **`cctp-retry-queue.json`** — a failed mock-relay message that's queued for retry. WITHOUT this,
  a restart while a relay is queued would strand the message (its scan cursor already advanced past
  it). Single global file; the bigint nonce is serialised as a decimal string.
- **`deadletter-<chain>.json`** — a non-empty file means USDC may be stranded (retries exhausted /
  attestation expired / fee too low) and needs manual relay. Each record keeps the raw message
  bytes so an operator can relay it by hand. `/health` reports the per-chain count.

## Cursor files

## Cursor files

One JSON file per chain: `cursor-<chain-name>.json`. Created automatically by the relayer on
its first successful scan tick. Atomic writes via tmpfile + rename — a `kill -9` mid-write
leaves either the old cursor intact or the new one fully present, never a torn file.

Shape (schema version 1):

```json
{
  "lastProcessedBlock": 12345678,
  "updatedAt": 1716220800000,
  "version": 1
}
```

- **`lastProcessedBlock`** — highest block FULLY scanned + ingested into `pendingMessages`
  (inclusive). Next poll tick starts at `lastProcessedBlock + 1`.
- **`updatedAt`** — Unix ms of the last write. Future health endpoint surfaces this as
  "scanner staleness."
- **`version`** — schema version stamp. Bump and add a migration in `lib/cursor-store.ts` when
  the shape changes; loading an unsupported version throws loudly rather than misinterpreting.

## When to delete a cursor file

- **Suspected corruption.** Deleting the file is operator-actionable recovery: the relayer
  bootstraps from `currentBlock - bootLookbackBlocks` on next start.
- **Manually re-scanning a window.** Edit `lastProcessedBlock` to the floor of the window you
  want re-scanned. The cursor's `version` field must stay 1.
- **Switching deployments.** The cursor is chain-scoped (file per chain name). A redeploy that
  changes the chain name will start fresh; a redeploy that keeps the name will resume from the
  old cursor — usually fine, but if contract addresses changed, deleting the file forces a
  clean bootstrap.

## When NOT to delete a cursor file

Never delete during steady-state operation. The cursor's job is to ensure the relayer resumes
where it left off after a restart; deleting it forces a re-scan of the full lookback window,
which the contract's "already processed" check absorbs but wastes RPC quota and gas.

## Behaviour on cold start

1. If no cursor file exists → bootstrap from `currentBlock - bootLookbackBlocks`. Recovers any
   `MessageSent` events from the last ~30 min (default) so the relayer doesn't drop in-flight
   messages on first deploy.
2. If a cursor exists AND the gap to chain head is reasonable → resume exactly from cursor.
3. If a cursor exists BUT the gap exceeds `maxBootLookbackBlocks` → cap at the lookback floor
   and emit a loud warning. The operator is alerted that historical messages between the
   cursor and the lookback floor were skipped (Iris would have expired their attestations
   anyway; manual recovery via `relayWithHook` if needed).
