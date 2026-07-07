# Crowdfund Indexer — Docker Deploy

Containerized deploy for the indexer API + Discord alert loop, with an optional
Postgres store. Default store is **file** (a Docker volume). Coexists with other
infra on the same host — each service runs its own commit-tagged image.

## Layout

- `indexer.Dockerfile` — build recipe (stays in this repo, builds from a checkout).
- `docker-compose.yml` — the fleet (indexer, alerts, optional postgres). **Copy this
  + your `.env` to a live ops dir outside the build checkout**, e.g. `/opt/armada-infra/`.
- `indexer.env.template` — copy to `.env` and fill in. Never commit the real `.env`.
- `nginx-indexer.conf` — host nginx server block; edit hostname + cert paths.

## 1. Build (on the VPS)

```bash
# from a checkout of this repo
SHA=$(git rev-parse --short HEAD)
docker build -f deploy/indexer.Dockerfile -t crowdfund-indexer:$SHA crowdfund-ui
```

## 2. Configure (in your ops dir, e.g. /opt/armada-infra/)

```bash
cp /path/to/repo/deploy/docker-compose.yml .
cp /path/to/repo/deploy/indexer.env.template .env
# edit .env: set INDEXER_IMAGE=crowdfund-indexer:<sha>, RPC URLs, contract
# addresses, alert window timestamps, and Discord webhooks.
```

## 3. Run

```bash
docker compose up -d            # file store (default)
docker compose ps
docker compose logs -f indexer
curl -s localhost:3002/health   # sanity check
```

Postgres instead of file store — set in `.env`:
`CROWDFUND_INDEXER_STORE=postgres`,
`CROWDFUND_DATABASE_URL=postgres://crowdfund:<pw>@postgres:5432/crowdfund`,
`POSTGRES_PASSWORD=<pw>`, then:

```bash
docker compose --profile postgres up -d
```

## 4. nginx

Edit `nginx-indexer.conf` (hostname + cert paths), drop it into your host nginx,
reload. It proxies `https://<host>` → `127.0.0.1:3002`.

## Update / redeploy

Images are commit-tagged, so redeploying is a `.env` bump + `up -d`, and rolling
back is the same in reverse (see **Rollback** below). Tag the release so the exact
image can always be rebuilt:

```bash
git pull && SHA=$(git rev-parse --short HEAD)
docker build -f deploy/indexer.Dockerfile -t crowdfund-indexer:$SHA crowdfund-ui
git tag "indexer-$(date -u +%Y%m%d)-$SHA" && git push --tags
# bump INDEXER_IMAGE in .env to crowdfund-indexer:$SHA, then:
docker compose up -d            # add --profile postgres if used
```

Keep the previous image on the host (don't prune it) so a rollback needs no rebuild.

## Rollback

The indexer holds no authoritative state the chain can't replay — snapshots are
derived and rebuildable from raw logs — so rollback is low-risk.

```bash
# 1. Point back at the previous image and restart.
#    (INDEXER_IMAGE=crowdfund-indexer:<previous-sha> in .env)
docker compose up -d            # add --profile postgres if used

# 2. If a bad build corrupted derived state, rebuild snapshots from raw logs:
docker compose exec indexer node_modules/.bin/tsx packages/indexer/src/cli/index.ts rebuild-snapshot
#    …or, if raw data itself is suspect, restore the last good backup (below).
```

The committer frontend rolls back independently on Netlify — redeploy a previous
(immutable) deploy from the Netlify UI/CLI. See issue #362 for the mainnet pin.

## Teardown

```bash
docker compose down             # stop; volumes (data) are kept
docker compose down -v          # also delete data — destructive
```

## Persistence & backups

State lives in named volumes: `crowdfund-indexer_indexer-data` (file store,
snapshots, alert dedupe) and `crowdfund-indexer_postgres-data`. Both survive
`down`/restart.

### Nightly backup

`backup-indexer.sh` tars the `indexer-data` volume and, when Postgres is running,
adds a `pg_dump` — with local retention pruning. Run it from the ops dir (where
`docker-compose.yml` + `.env` live) via cron:

```bash
cp /path/to/repo/deploy/backup-indexer.sh .
chmod +x backup-indexer.sh
# crontab -e  — daily 03:15 UTC:
15 3 * * *  cd /opt/armada-infra && ./backup-indexer.sh >> backup.log 2>&1
```

Tunables (env): `BACKUP_DIR` (default `./backups`), `RETENTION_DAYS` (default 14),
`BACKUP_REMOTE_CMD` (optional off-host copy — a backup on the same VPS does **not**
survive VPS loss; set this to an `rclone`/`scp` command receiving the file path as
`$1`, e.g. `export BACKUP_REMOTE_CMD='rclone copy "$1" r2:armada-indexer-backups'`).

### Restore

Stop the stack first so nothing writes during restore:

```bash
docker compose down                      # keeps volumes

# File store + snapshots (wipe the volume, then unpack the tarball into it):
docker run --rm -v crowdfund-indexer_indexer-data:/data -v "$PWD/backups":/backup alpine:3 \
  sh -c 'rm -rf /data/* /data/.[!.]* /data/..?* 2>/dev/null; tar xzf /backup/indexer-data-<STAMP>.tar.gz -C /data'

docker compose up -d                     # add --profile postgres if used
```

Postgres (restore into a fresh/empty DB — drop & recreate first if it has data):

```bash
gunzip -c backups/postgres-<STAMP>.sql.gz \
  | docker compose exec -T postgres sh -c 'psql -U "$POSTGRES_USER" "$POSTGRES_DB"'
```

Because raw logs are canonical and snapshots are derived, restoring Postgres (or the
file store) recovers everything; the indexer resumes polling from the restored
`verifiedCursor`. Verify with `curl -s localhost:3002/health` and the `status` CLI.
