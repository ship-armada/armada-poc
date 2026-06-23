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

```bash
git pull && SHA=$(git rev-parse --short HEAD)
docker build -f deploy/indexer.Dockerfile -t crowdfund-indexer:$SHA crowdfund-ui
# bump INDEXER_IMAGE in .env, then:
docker compose up -d            # add --profile postgres if used
```

## Teardown

```bash
docker compose down             # stop; volumes (data) are kept
docker compose down -v          # also delete data — destructive
```

## Persistence & backups

State lives in named volumes: `crowdfund-indexer_indexer-data` (file store,
snapshots, alert dedupe) and `crowdfund-indexer_postgres-data`. Both survive
`down`/restart. Automated snapshot/restore of these volumes is a planned
follow-up; for Postgres, `pg_dump`/`psql` per the indexer runbook works today.
