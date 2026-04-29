# Crowdfund Indexer Operator Runbook

Operate the hosted crowdfund indexer for Sepolia observer/committer apps. The indexer accelerates frontend state loading, but Ethereum Sepolia remains the source of truth.

---

## Goals

- Keep frontend cold loads fast by serving verified snapshots and event deltas.
- Never mark data verified across a missing, failed, or suspicious range.
- Preserve enough raw data to rebuild snapshots after derived-state bugs.
- Provide a static snapshot fallback when the API or database is unavailable.

---

## Runtime Model

The indexer tracks two cursors:

- `ingestedCursor` — highest block range fetched and staged.
- `verifiedCursor` — highest contiguous block verified without gaps.

Frontends should trust only `verifiedCursor`. If range `x` fails but later ranges are fetched, the verified cursor must stop before `x` until repair succeeds.

Data layers:

- Raw logs are canonical indexer input and should be append-only in normal operation.
- Snapshots are derived artifacts and can be rebuilt from raw logs.
- Static snapshots are outage fallback artifacts, published as `snapshot-{block}.json` plus `latest.json`.

---

## Required Environment

Core Sepolia config:

```bash
export CROWDFUND_CHAIN_ID=11155111
export CROWDFUND_CONTRACT_ADDRESS=<sepolia-crowdfund-address>
export CROWDFUND_DEPLOY_BLOCK=<deployment-block>
export CROWDFUND_PRIMARY_RPC_URL=<primary-rpc-url>
export CROWDFUND_AUDIT_RPC_URL=<optional-independent-rpc-url>
```

Cursor and range tuning:

```bash
export CROWDFUND_CONFIRMATION_DEPTH=12
export CROWDFUND_OVERLAP_WINDOW=100
export CROWDFUND_MAX_BLOCK_RANGE=500
```

API:

```bash
export CROWDFUND_INDEXER_PORT=3002
export CROWDFUND_BACKFILL_ON_START=true
```

Frontend:

```bash
export VITE_CROWDFUND_INDEXER_URL=https://<indexer-api-host>
```

---

## Storage Backends

### Production: Postgres

Use Postgres for production durability.

```bash
export CROWDFUND_INDEXER_STORE=postgres
export CROWDFUND_DATABASE_URL=postgres://<user>:<password>@<host>:5432/<database>
```

The indexer creates tables on startup:

- `crowdfund_indexer_cursor`
- `crowdfund_indexer_ranges`
- `crowdfund_indexer_raw_logs`
- `crowdfund_indexer_metadata`

### Local Development: JSON File

If no database URL is configured, the indexer uses a local JSON store.

```bash
export CROWDFUND_INDEXER_STORE=file
export CROWDFUND_INDEXER_STORE_PATH=data/crowdfund-indexer/store.json
```

Do not use the JSON file store for production campaigns.

---

## Static Snapshot Publishing

### Local File Publisher

Useful for local smoke tests.

```bash
export CROWDFUND_SNAPSHOT_PUBLISHER=file
export CROWDFUND_SNAPSHOT_DIR=data/crowdfund-indexer/snapshots
```

### S3-Compatible Object Storage

Use this for production fallback snapshots. This works with S3, Cloudflare R2, and other S3-compatible services supported by the AWS SDK.

```bash
export CROWDFUND_SNAPSHOT_PUBLISHER=s3
export CROWDFUND_SNAPSHOT_BUCKET=<bucket-name>
export CROWDFUND_SNAPSHOT_PREFIX=crowdfund/sepolia
export CROWDFUND_SNAPSHOT_REGION=<region>
export CROWDFUND_SNAPSHOT_ENDPOINT=<optional-s3-compatible-endpoint>
export CROWDFUND_SNAPSHOT_PUBLIC_BASE_URL=https://<cdn-or-public-bucket-host>
export CROWDFUND_SNAPSHOT_FORCE_PATH_STYLE=false
```

Credentials are read by the AWS SDK from the host environment. Do not commit access keys.

Published artifacts:

- `snapshot-{verifiedBlock}.json` — immutable, long cache lifetime.
- `latest.json` — mutable pointer, short cache lifetime.

---

## Start The API

```bash
npm run crowdfund:indexer
```

With `CROWDFUND_BACKFILL_ON_START=true`, the API starts serving immediately and runs one startup catch-up pass in the background.

Health endpoint:

```bash
curl "$VITE_CROWDFUND_INDEXER_URL/health"
```

Expected healthy fields:

- `status: "healthy"`
- `hasGaps: false`
- `lagBlocks` near `0`
- `verifiedCursor` close to `confirmedHead`

---

## Operator Commands

Run commands from the repository root.

```bash
npm run crowdfund:indexer:cli -- status
```

Backfill to the latest confirmed head:

```bash
npm run crowdfund:indexer:cli -- backfill latest
```

Verify a specific confirmed range:

```bash
npm run crowdfund:indexer:cli -- verify --from 123456 --to 123999
```

Repair a known failed or suspicious range:

```bash
npm run crowdfund:indexer:cli -- repair --from 123456 --to 123999
```

Rebuild snapshot metadata from verified raw logs:

```bash
npm run crowdfund:indexer:cli -- rebuild-snapshot
```

Publish the latest verified snapshot:

```bash
npm run crowdfund:indexer:cli -- publish-snapshot
```

Publishing refuses failed contract-read reconciliation when `CROWDFUND_PRIMARY_RPC_URL` is configured.

---

## Normal Operating Loop

1. Start the API with Postgres and object storage configured.
2. Run `status` and confirm the store initializes correctly.
3. Run `backfill latest` until `verifiedCursor` reaches `confirmedHead`.
4. Run `publish-snapshot`.
5. Configure frontends with `VITE_CROWDFUND_INDEXER_URL`.
6. Monitor `/health` for `stale`, `degraded`, `unhealthy`, or nonzero gaps.

During active campaigns, run a scheduled loop equivalent to:

```bash
npm run crowdfund:indexer:cli -- backfill latest
npm run crowdfund:indexer:cli -- publish-snapshot
```

Use an independent `CROWDFUND_AUDIT_RPC_URL` where possible so range verification does not depend entirely on one RPC provider.

---

## Failure Recovery

### RPC Downtime

Symptoms:

- `/health` becomes `stale` or `unhealthy`.
- `status` shows `lastError`.
- Backfill records `failed` ranges.

Actions:

1. Confirm the RPC outage independently.
2. Switch `CROWDFUND_PRIMARY_RPC_URL` if needed.
3. Keep `CROWDFUND_AUDIT_RPC_URL` on a different provider.
4. Run `repair` for failed ranges, then `backfill latest`.
5. Publish a new snapshot after health returns to healthy.

### Missed Or Suspicious Event Range

Symptoms:

- `status` shows gaps.
- A range has `failed` or `suspicious` status.
- `verifiedCursor` stops before the problematic range.

Actions:

1. Do not manually advance `verifiedCursor`.
2. Run:

```bash
npm run crowdfund:indexer:cli -- repair --from <range-start> --to <range-end>
npm run crowdfund:indexer:cli -- backfill latest
```

3. If the range remains suspicious, compare primary and audit RPC logs manually before publishing.

### Indexer Process Crash

Actions:

1. Restart the API.
2. Run `status`.
3. Run `backfill latest`.
4. Run `publish-snapshot`.

Postgres range records and raw logs should allow the service to resume without replaying from deployment block.

### Postgres Corruption Or Accidental Data Loss

Sepolia is canonical, so recovery is possible by rebuilding from chain logs. The recovery time depends on RPC limits and deployment age.

Actions:

1. Stop the indexer API.
2. Restore the latest Postgres backup if available.
3. If no backup is usable, create a fresh database and keep the current object-storage `latest.json` available as frontend fallback.
4. Start the indexer against the fresh database.
5. Run `backfill latest`.
6. Run `publish-snapshot` after reconciliation passes.

Operational expectation: production should have managed Postgres backups enabled. Object snapshots reduce frontend outage impact but do not replace database backups.

### Static Snapshot Publisher Failure

Actions:

1. Confirm API health with `/health`.
2. Re-run `publish-snapshot`.
3. If object storage is unavailable, temporarily publish to local file storage only for debugging.
4. Do not point production frontends at an unverified manually edited snapshot.

---

## Backup Checklist

Before campaign launch:

- Managed Postgres automated backups enabled.
- Manual Postgres backup tested.
- Object bucket versioning enabled if available.
- `latest.json` public URL verified from a browser.
- `snapshot-{block}.json` public URL verified from a browser.
- Independent audit RPC configured.
- `status` returns healthy after a full backfill.
- `publish-snapshot` succeeds after reconciliation.

Suggested manual Postgres backup:

```bash
pg_dump "$CROWDFUND_DATABASE_URL" > crowdfund-indexer-$(date +%Y%m%d-%H%M%S).sql
```

Suggested restore drill:

```bash
psql "$CROWDFUND_DATABASE_URL" < crowdfund-indexer-backup.sql
npm run crowdfund:indexer:cli -- status
npm run crowdfund:indexer:cli -- backfill latest
```

Keep database dumps out of git.

---

## Smoke Test Checklist

1. Start indexer API.
2. Run `backfill latest`.
3. Run `publish-snapshot`.
4. Open `/health` and confirm healthy status.
5. Open `/snapshot` and confirm metadata matches:
   - `chainId`
   - `contractAddress`
   - `deployBlock`
   - `verifiedBlock`
6. Start observer with `VITE_CROWDFUND_INDEXER_URL`.
7. Start committer with `VITE_CROWDFUND_INDEXER_URL`.
8. Confirm both apps load current campaign state without full browser RPC replay.
9. Submit a test transaction and confirm the committer updates immediately from receipt logs.
10. Confirm the indexer catches up and the next snapshot includes the transaction.
