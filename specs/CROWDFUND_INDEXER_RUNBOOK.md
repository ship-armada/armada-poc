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

### Reorg Handling

`CROWDFUND_CONFIRMATION_DEPTH` (default 12) is the stated reorg guarantee: only data at
least that many blocks behind the chain head is verified. Reorgs deeper than that are
unhandled but acceptable on the Ethereum L1 mainnet hub (chain id 1), where a >12-block
reorg implies a consensus/finality failure rather than normal operation.

Raw logs are deduped by `(chainId, contract, txHash, logIndex)` — excluding `blockHash` —
so a tx re-mined at a new block cannot double-apply. Postgres enforces this via the
`crowdfund_indexer_raw_logs` primary key; the file store enforces it via `getLogDedupeKey`.

---

## Required Environment

Tracked sample files are provided at the repository root:

- `sample.env.dev` — local development against Sepolia, JSON file store, local indexer URL, polling enabled.
- `sample.env.production` — production-style Sepolia config, Postgres store, S3-compatible snapshots, polling enabled.

The Node indexer does not automatically load these files. Source a copied file before running commands:

```bash
cp sample.env.dev dev.env
set -a
source dev.env
set +a
npm run crowdfund:indexer
```

For the Vite frontends, sourced `VITE_*` variables are inherited by `npm run crowdfund:committer` and `npm run crowdfund:observer`.

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
export CROWDFUND_MAX_BLOCK_RANGE=500
```

API:

```bash
export CROWDFUND_INDEXER_PORT=3002
export CROWDFUND_POLL_ON_START=true
export CROWDFUND_POLL_INTERVAL_MS=15000
export CROWDFUND_POLL_ERROR_BACKOFF_MS=60000
export CROWDFUND_RPC_TIMEOUT_MS=15000
export CROWDFUND_RPC_MAX_RETRIES=3
export CROWDFUND_RPC_RETRY_BASE_DELAY_MS=1000
export CROWDFUND_RPC_RETRY_JITTER_MS=250
export CROWDFUND_PUBLISH_ON_POLL=true
export CROWDFUND_SNAPSHOT_PUBLISH_INTERVAL_MS=60000
export CROWDFUND_REPAIR_MAX_ATTEMPTS=6
export CROWDFUND_REPAIR_BACKOFF_BASE_MS=30000
export CROWDFUND_REPAIR_BACKOFF_MAX_MS=1800000
```

Frontend:

```bash
export VITE_CROWDFUND_INDEXER_URL=https://<indexer-api-host>
```

---

## Environment Variable Reference

Core deployment variables:

| Variable | Default | Behavior |
|----------|---------|----------|
| `CROWDFUND_CHAIN_ID` | `11155111` | Chain ID stamped into indexed raw logs and snapshot metadata. |
| `CROWDFUND_CONTRACT_ADDRESS` | required | Crowdfund contract address to scan and serve. API/CLI fail fast when missing. |
| `CROWDFUND_DEPLOY_BLOCK` | `0` | Initial cursor. Set to the deployment block to avoid scanning before deployment. |
| `CROWDFUND_PRIMARY_RPC_URL` | required for backfill/poll | Primary RPC used for head reads, range ingestion, and reconciliation. |
| `CROWDFUND_AUDIT_RPC_URL` | unset | Optional independent RPC used to verify range digests. If unset, primary RPC is used for audit too. |

Storage variables:

| Variable | Default | Behavior |
|----------|---------|----------|
| `CROWDFUND_INDEXER_STORE` | auto | `postgres` or `file`. If unset, database URL selects Postgres; otherwise file store is used. |
| `CROWDFUND_INDEXER_STORE_BACKEND` | unset | Backward-compatible alias for `CROWDFUND_INDEXER_STORE`. |
| `CROWDFUND_DATABASE_URL` | unset | Postgres connection string. Preferred production DB env. |
| `DATABASE_URL` | unset | Fallback Postgres connection string if `CROWDFUND_DATABASE_URL` is absent. |
| `CROWDFUND_INDEXER_STORE_PATH` | `data/crowdfund-indexer/store.json` | JSON file store path for local/dev mode. |

Cursor and range variables:

| Variable | Default | Behavior |
|----------|---------|----------|
| `CROWDFUND_CONFIRMATION_DEPTH` | `12` | Blocks behind chain head required before data is verified. Lower only for dev. |
| `CROWDFUND_MAX_BLOCK_RANGE` | `500` | Maximum inclusive block range per `eth_getLogs` chunk. |

API and polling variables:

| Variable | Default | Behavior |
|----------|---------|----------|
| `CROWDFUND_INDEXER_PORT` | `3002` | HTTP API port. |
| `CROWDFUND_POLL_ON_START` | `false` | Starts continuous supervised polling when `true`. Recommended for production. |
| `CROWDFUND_BACKFILL_ON_START` | `false` | Runs one startup catch-up pass when `true` and polling is disabled. |
| `CROWDFUND_POLL_INTERVAL_MS` | `15000` | Delay between successful poll cycles. |
| `CROWDFUND_POLL_ERROR_BACKOFF_MS` | `60000` | Delay after a cycle-level worker failure. |
| `CROWDFUND_RPC_TIMEOUT_MS` | `15000` | Timeout for each RPC call made by the polling worker. |
| `CROWDFUND_RPC_MAX_RETRIES` | `3` | Retry count after failed/timed-out RPC calls. |
| `CROWDFUND_RPC_RETRY_BASE_DELAY_MS` | `1000` | Base retry delay before exponential backoff. |
| `CROWDFUND_RPC_RETRY_JITTER_MS` | `250` | Random jitter added to retry delay. |
| `CROWDFUND_PUBLISH_ON_POLL` | `false` | Publishes a static snapshot after successful poll cycles when `true`. |
| `CROWDFUND_SNAPSHOT_PUBLISH_INTERVAL_MS` | `60000` | Minimum interval between automatic snapshot publishes. |
| `CROWDFUND_REPAIR_MAX_ATTEMPTS` | `6` | Total attempts (initial + auto-repair retries) before a range is exhausted and surfaced in `gapsRequiringIntervention`. Set to `0` to disable auto-reconcile entirely. |
| `CROWDFUND_REPAIR_BACKOFF_BASE_MS` | `30000` | Base delay for exponential backoff between auto-repair attempts. The Nth attempt waits `base * 2^(attempts-1)`, capped by `BACKOFF_MAX_MS`. |
| `CROWDFUND_REPAIR_BACKOFF_MAX_MS` | `1800000` | Cap on the backoff delay between auto-repair attempts (default 30 minutes). |
| `CROWDFUND_STALE_AFTER_MS` | `300000` | Wall-clock budget after which a frozen indexer is reported `stale` (or `unhealthy` if an error is pending) even when there are no gaps and block-lag reads 0. Detects a dead/stuck RPC where cursors stop advancing. Default 5 minutes. |

Snapshot publication variables:

| Variable | Default | Behavior |
|----------|---------|----------|
| `CROWDFUND_SNAPSHOT_PUBLISHER` | `file` | `file` writes local artifacts; `s3` writes to S3-compatible object storage. |
| `CROWDFUND_SNAPSHOT_DIR` | `data/crowdfund-indexer/snapshots` | Local output directory for `file` publisher. |
| `CROWDFUND_SNAPSHOT_BUCKET` | required for `s3` | Bucket name for object snapshot publication. |
| `CROWDFUND_SNAPSHOT_PREFIX` | unset | Object key prefix, e.g. `crowdfund/sepolia`. |
| `CROWDFUND_SNAPSHOT_REGION` | `AWS_REGION` | Region passed to the AWS SDK S3 client. |
| `CROWDFUND_SNAPSHOT_ENDPOINT` | unset | Optional S3-compatible endpoint, e.g. R2. |
| `CROWDFUND_SNAPSHOT_PUBLIC_BASE_URL` | unset | Public root URL used in health metadata for `latest.json`. Prefix is appended automatically. |
| `CROWDFUND_SNAPSHOT_FORCE_PATH_STYLE` | `false` | Enables path-style S3 requests for compatible providers that need it. |

Alert evaluator variables (used by `evaluate-alerts`; see [`MONITORING.md`](MONITORING.md)):

| Variable | Default | Behavior |
|----------|---------|----------|
| `CROWDFUND_TREASURY_ADDRESS` | required | Treasury address — used to read USDC balance for A13 mismatch detection. |
| `CROWDFUND_USDC_ADDRESS` | optional | USDC contract — required for A13 (treasury balance). Omit to skip A13. |
| `CROWDFUND_OPEN_TIMESTAMP` | `0` | Unix seconds when the commitment window opens. Drives A2/A8/A9. |
| `CROWDFUND_WEEK1_DEADLINE` | `0` | Unix seconds when week-1 ends (openTimestamp + 7 days). Marks the week-1 → weeks-2–3 phase boundary in the monitoring model. |
| `CROWDFUND_COMMITMENT_DEADLINE` | `0` | Unix seconds when the 3-week window closes (openTimestamp + 21 days). Drives A8/A9. |
| `CROWDFUND_ALERT_WEBHOOK_P0` | unset | Discord webhook URL for P0 (immediate) alerts. |
| `CROWDFUND_ALERT_WEBHOOK_P1` | unset | Discord webhook URL for P1 (same-day) alerts. |
| `CROWDFUND_ALERT_WEBHOOK_P2` | unset | Discord webhook URL for P2 (attention) alerts. |
| `CROWDFUND_ALERT_WEBHOOK_P3` | unset | Discord webhook URL for P3 (informational) alerts. |
| `CROWDFUND_ALERT_MENTION_P0` | unset | Mention prepended to P0 messages (e.g. `<@&ROLE_ID>` to ping the on-call role). |
| `CROWDFUND_ALERT_MENTION_P1` | unset | Mention prepended to P1 messages. |
| `CROWDFUND_ALERT_MENTION_P2` | unset | Mention prepended to P2 messages. |
| `CROWDFUND_ALERT_MENTION_P3` | unset | Mention prepended to P3 messages. |
| `CROWDFUND_ALERT_STATE_FILE` | `data/crowdfund-indexer/alerts.json` | JSON file persisting already-delivered dedupe keys (so cron ticks don't re-fire). |
| `CROWDFUND_ALERT_DUPLICATE_SLOT_FRACTION` | `0.10` | A6 — duplicate-slot watch threshold (fraction of occupied hop-1/2 nodes). MONITORING.md §13. |
| `CROWDFUND_ALERT_FINALIZE_GRACE_SECONDS` | `7200` | A9a — grace window after `commitmentDeadline` before P1 escalates to P0. MONITORING.md §13. |
| `CROWDFUND_ALERT_CLAIM_PARTICIPATION_FLOOR` | `0.50` | A18 — minimum fraction of claimers expected 14d after success finalization. |
| `CROWDFUND_ALERT_REFUND_UNCLAIMED_THRESHOLD` | `0.10` | A19 — maximum fraction of refundable USDC left unclaimed 30d after refundMode. |

Frontend variables:

| Variable | Default | Behavior |
|----------|---------|----------|
| `VITE_NETWORK` | `local` | Set to `sepolia` for Sepolia deployment files/RPCs. |
| `VITE_SEPOLIA_RPC` | public Sepolia RPC | Browser RPC used by observer/committer. |
| `VITE_SEPOLIA_RPC_FALLBACK` | unset | Optional browser RPC fallback. |
| `VITE_CROWDFUND_INDEXER_URL` | unset | Indexer API base URL used for snapshot/health loading. |
| `VITE_WALLETCONNECT_PROJECT_ID` | dev fallback | WalletConnect project ID for wallet connections. Set explicitly outside local dev. |
| `VITE_SENTRY_DSN` | unset | Sentry DSN for `committer` and `admin` apps. When unset, Sentry init is a no-op (local/dev). |
| `VITE_SENTRY_ENVIRONMENT` | `MODE` | Environment tag attached to Sentry events (e.g. `production`, `staging`). Falls back to Vite's `MODE`. |
| `VITE_SENTRY_RELEASE` | unset | Release identifier attached to Sentry events. Typically the git SHA injected at build time. |

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

**Single-writer only.** The JSON file store has no cross-process lock. Its writes are
read-modify-write, so running a mutating CLI command (`verify`, `repair`, `backfill`)
while the API's polling worker is active will race — the last writer wins and updates are
lost. Stop the polling worker before running mutating CLI commands against the file store,
or use the Postgres backend (which serializes writes via an advisory lock). Read-only
commands (`status`) are always safe.

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

With `CROWDFUND_POLL_ON_START=true`, the API starts serving immediately and runs a supervised polling worker in the background. The worker retries bounded RPC failures, times out non-responsive calls, avoids overlapping cycles, and records failures in store metadata without advancing over failed ranges.

For a one-shot startup catch-up without continuous polling, use:

```bash
export CROWDFUND_BACKFILL_ON_START=true
export CROWDFUND_POLL_ON_START=false
```

Health endpoint:

```bash
curl "$VITE_CROWDFUND_INDEXER_URL/health"
```

Expected healthy fields:

- `status: "healthy"`
- `hasGaps: false`
- `lagBlocks` near `0`
- `verifiedCursor` close to `confirmedHead`

### Health status semantics

`status` is derived in this order:

- `unhealthy` — one or more gaps have exhausted auto-repair (`gapsRequiringIntervention` non-empty); or a gap exists alongside a current `lastError`; or nothing has ever verified while an error is pending.
- `degraded` — gaps exist but auto-repair is still retrying them.
- `stale` — verification has not advanced within `CROWDFUND_STALE_AFTER_MS` (wall-clock), **or** block-lag exceeds the SLA threshold. The wall-clock check catches a dead/stuck RPC where the cursors freeze and `lagBlocks` would otherwise read `0`. If an error is pending during that window, status escalates to `unhealthy`.
- `healthy` — none of the above.

Two alerts watch the indexer itself (see `MONITORING.md` §8 addendum): **AH1** pages when `status` is `stale` (P2) or `unhealthy` (P1); **AH2** pages when `gapsRequiringIntervention` is non-empty (P1). While the indexer is `stale`/`unhealthy`, the time-based crowdfund alerts (A2/A8/A9a/A9b) are suppressed to avoid false pages off a lagging snapshot.

### Rate limiting

Rate limiting is enforced at the nginx reverse proxy, not in the Node process. The API
deliberately sets permissive CORS and ships no app-level limiter, so the reverse proxy is
the single throttling point in front of the public port (`CROWDFUND_INDEXER_PORT`, default
`3002`).

The chosen limits (in `deploy/nginx-indexer.conf`):

- **10 requests/second per IP** (`limit_req_zone ... rate=10r/s`, keyed on `$binary_remote_addr`).
- **Burst of 20** with `nodelay`, so short spikes are absorbed rather than queued.
- **HTTP 429** returned on excess (`limit_req_status 429`), not 503.

The limits are tunable — adjust `rate` and `burst` in the conf and reload nginx. The public
endpoints (`/health`, `/snapshot`, `/events`) are cheap and cached, so this budget is generous
for real users while throttling a request flood from a single source.

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

Or repair every currently failed/suspicious range, bypassing the auto-reconcile
attempt limit and backoff window:

```bash
npm run crowdfund:indexer:cli -- repair
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

Evaluate alert rules (implements [`MONITORING.md`](MONITORING.md) §8 A1–A20) and dispatch any newly-fired alerts to Discord:

```bash
npm run crowdfund:indexer:cli -- evaluate-alerts
```

The command is a single pass — it reads the indexer store, optionally consults the chain for `finalizedAt` and treasury USDC balance, runs every rule, posts new alerts to the configured webhooks, persists which dedupe keys it has already delivered, and exits. Schedule it as a recurring job (cron, systemd timer, or external scheduler) at whatever cadence matches your runbook — once per minute is fine; the cost is dominated by RPC reads.

Required env: `CROWDFUND_CONTRACT_ADDRESS`, `CROWDFUND_TREASURY_ADDRESS`, the three timestamp vars (`CROWDFUND_OPEN_TIMESTAMP`, `CROWDFUND_WEEK1_DEADLINE`, `CROWDFUND_COMMITMENT_DEADLINE`), and at least one webhook URL. Without `CROWDFUND_PRIMARY_RPC_URL` + `CROWDFUND_USDC_ADDRESS`, A13 (treasury proceeds mismatch) and the time-gated rules that need `finalizedAt` (A18/A19/A20) self-skip rather than producing false positives. Alerts whose severity has no configured webhook are logged to stderr and skipped.

Example systemd timer (drop into `/etc/systemd/system/crowdfund-alerts.timer`):

```ini
[Unit]
Description=Run crowdfund alert evaluator every minute

[Timer]
OnBootSec=1min
OnUnitActiveSec=1min
Unit=crowdfund-alerts.service

[Install]
WantedBy=timers.target
```

Pair with a one-shot service that runs `npm run crowdfund:indexer:cli -- evaluate-alerts` in the indexer working directory with the env vars above.

To force a re-fire after operator intervention (e.g. you want a P0 to re-page after a Discord channel outage), remove the relevant `dedupeKey` entries from `data/crowdfund-indexer/alerts.json` or delete the file entirely.

### Delivery cadence

Each `evaluate-alerts` invocation is a single pass — it reads current indexer state, evaluates every rule, dispatches newly-fired alerts, and exits. **Worst-case alert latency is your cron interval.** Multiple alerts that become true between two ticks all deliver in the same tick, so you may see two or three messages arrive together; that's expected, not a bug.

If you need tighter latency than one minute, drop the timer to 30s — the evaluator is cheap (single store read + a few RPC calls when `chainState` is configured). Sub-30s is overkill at this scale and risks Discord rate limits.

### Where webhook URLs live

Webhook URLs are bearer credentials — anyone holding the URL can post to that channel — so they are **never** committed to git. The canonical home for them depends on environment:

| Environment | Location | Set by |
|---|---|---|
| **Local dev / testing** | `config/secrets.env` (gitignored; template at `config/secrets.env.template`) | Operator copies template, fills in values, `source`s the file before running the indexer or CLI. |
| **Production VPS** | systemd `EnvironmentFile=` pointing at a root-owned file under `/etc/crowdfund-alerts/` (mode `0640`, group-readable by the alerts service user) | Deploy script writes the file from your secret manager during host provisioning. Never check the file into the repo. |
| **Container / PaaS** | Platform secret manager (Render, Fly, Vercel, AWS Secrets Manager, GCP Secret Manager, …) injected at process start | Set via the platform's UI or `infra-as-code`; rotate via the same channel. |

`sample.env.production` keeps placeholder values (`https://discord.com/api/webhooks/<id>/<token>`) so the full env-var inventory is visible without leaking credentials. `config/secrets.env.template` carries the same env-var names with empty values, ready for `cp config/secrets.env.template config/secrets.env` then editing in place.

`.gitignore` already covers `config/secrets.env` — verify with `git check-ignore -v config/secrets.env` before pasting a real URL.

### Rotating or changing the Discord channel

The webhook URLs are env-var-driven (`CROWDFUND_ALERT_WEBHOOK_P0/P1/P2/P3`), so swapping channels is a config change, not a code redeploy:

1. Create the new webhook in Discord (Server Settings → Integrations → Webhooks → New Webhook).
2. Update the env var(s) in whichever store applies to your environment (see table above).
3. Reload the cron unit (`systemctl daemon-reload && systemctl restart crowdfund-alerts.timer`, or equivalent on your platform).
4. Optionally revoke the old webhook in Discord to prevent stale tokens from posting.

You can route different severities to different channels — e.g. P0/P1 to a paged channel with an `@on-call` role mention (`CROWDFUND_ALERT_MENTION_P0=<@&ROLE_ID>`), P2/P3 to a silent log channel. Or point all four at one channel for simplicity.

---

## Normal Operating Loop

1. Start the API with Postgres, object storage, and `CROWDFUND_POLL_ON_START=true` configured.
2. Run `status` and confirm the store initializes correctly.
3. Let the polling worker catch up until `verifiedCursor` reaches `confirmedHead`.
4. If `CROWDFUND_PUBLISH_ON_POLL=false`, run `publish-snapshot` manually.
5. Configure frontends with `VITE_CROWDFUND_INDEXER_URL`.
6. Monitor `/health` for `stale`, `degraded`, `unhealthy`, or nonzero gaps.

During active campaigns, the built-in polling worker replaces a cron loop. If the worker is disabled, run a scheduled loop equivalent to:

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
4. The worker will retry future cycles automatically. For immediate recovery, run `repair` for failed ranges, then `backfill latest`.
5. Publish a new snapshot after health returns to healthy.

### Missed Or Suspicious Event Range

Symptoms:

- `status` shows gaps.
- A range has `failed` or `suspicious` status.
- `/health` reports `degraded` (transient — auto-reconcile is still retrying)
  or `unhealthy` with non-empty `gapsRequiringIntervention` (auto-reconcile gave up).

Actions:

1. Do not manually advance `verifiedCursor`.
2. The polling worker auto-reconciles failed/suspicious ranges with exponential
   backoff. Tunable via `CROWDFUND_REPAIR_MAX_ATTEMPTS` (default 6),
   `CROWDFUND_REPAIR_BACKOFF_BASE_MS` (default 30000),
   `CROWDFUND_REPAIR_BACKOFF_MAX_MS` (default 1800000). Set
   `CROWDFUND_REPAIR_MAX_ATTEMPTS=0` to disable auto-reconcile entirely.
3. If a range is reported in `gapsRequiringIntervention` (auto-reconcile exhausted),
   force an immediate retry:

```bash
npm run crowdfund:indexer:cli -- repair
```

   Or target one range manually:

```bash
npm run crowdfund:indexer:cli -- repair --from <range-start> --to <range-end>
npm run crowdfund:indexer:cli -- backfill latest
```

4. If the range remains suspicious after a manual retry, compare primary and audit
   RPC logs manually before publishing.

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

### Automated backups (Dockerized deploy)

For the containerized deploy (`deploy/docker-compose.yml`), `deploy/backup-indexer.sh`
runs nightly via cron: it tars the `indexer-data` volume (file store + snapshots +
alert dedupe) and, when the `postgres` service is running, adds a `pg_dump`, with local
retention pruning and an optional off-host copy hook (`BACKUP_REMOTE_CMD`). Set up cron
and off-host copy per `deploy/README.md` → **Persistence & backups**; the full **Restore**
and **Rollback** procedures live there too. A backup on the same VPS does not survive VPS
loss — always configure the off-host copy before launch.

Because raw logs are canonical and snapshots are derived, restoring Postgres (or the file
store) recovers everything; the indexer resumes from the restored `verifiedCursor`.

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
