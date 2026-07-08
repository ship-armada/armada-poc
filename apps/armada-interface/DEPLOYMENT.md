# Deploying armada-interface (Vercel / Netlify)

> **Local vs deployed invariants (relayer, fees, env):** [`LOCAL_VS_DEPLOY.md`](./LOCAL_VS_DEPLOY.md) — read before changing `network.ts`, fee hooks, or hosting config.

## Required environment variables

| Variable | Vercel / Netlify | Purpose |
|----------|------------------|---------|
| `VITE_NETWORK` | `sepolia` | Use Sepolia manifests and RPCs (set in `vercel.json` for Vercel; `netlify.toml` for Netlify). |
| `VITE_RELAYER_URL` | **Public HTTPS URL** (optional) | Live `/fees` quotes. **Omit on Vercel** unless you host a relayer — wallet-submit flows use offline placeholders. Never use `localhost:3001` on hosted previews. |
| `VITE_WALLETCONNECT_PROJECT_ID` | Project ID | WalletConnect modal (optional for MetaMask-only testing). |
| `DEPLOYMENT_REF` | Optional, commit SHA (build-step, non-VITE) | Which `ship-armada/armada-deployments` commit the manifests are fetched from. **Defaults to the mutable `main` branch when unset.** These manifests carry fund-receiving contract addresses, so **pin to a specific SHA for production** to freeze them into the build (and bump deliberately per release); leaving it on `main` is convenient but means a repo change flows into the next build. |
| `DEPLOYMENT_INSTANCE` | Optional, defaults `demo1` (build-step, non-VITE) | Which instance directory under `testnet/` to fetch. |
| `VITE_SENTRY_DSN` | Optional | Sentry DSN. **Unset → Sentry init is a no-op** (local/dev + any build without it transmit nothing). Errors only (no perf/replay), `sendDefaultPii: false`, and a `beforeSend` scrubber redacts 0zk/EVM addresses + long hex. |
| `VITE_SENTRY_ENVIRONMENT` | Optional, falls back to Vite `MODE` | Environment tag on Sentry events (e.g. `production`, `sepolia`). |
| `VITE_SENTRY_RELEASE` | Optional | Release tag on events. Unset → the Sentry Vite plugin auto-detects the release from git and injects it, keeping runtime + uploaded maps aligned. |
| `SENTRY_AUTH_TOKEN` | Optional, **secret** (build-step, non-VITE) | Enables source-map **upload**. Unset → the Vite plugin self-disables AND no sourcemaps are emitted at all (so an un-configured build never publishes maps). Set it (+ `SENTRY_ORG`/`SENTRY_PROJECT`) to upload `hidden` maps that are deleted from `dist/` after upload. **Never commit.** |
| `SENTRY_ORG` / `SENTRY_PROJECT` | Optional (build-step, non-VITE) | Sentry org + project slugs the maps upload to. Required alongside `SENTRY_AUTH_TOKEN`. |

Hosted Sepolia builds work without `VITE_RELAYER_URL` for deposit/send (user wallet submits). Cross-chain completion still requires your team’s relayer process running on infrastructure.

When `VITE_RELAYER_URL` is unset on a Sepolia build, the app now resolves the relayer URL to `''` (never `localhost:3001`): `isRelayerConfigured()` is false, so fee quotes don't fetch, gasless toggles disable, and the modals show a **"No relayer is configured"** banner steering the user to wallet-submit. Set `VITE_RELAYER_URL` to the public **HTTPS** relayer origin and redeploy to enable relayer-mediated flows. (An `http://` relayer from an `https://` page is blocked as mixed content — HTTPS is mandatory.)

## Error monitoring (Sentry)

Sentry is wired in `src/lib/sentry.ts` (init) + funnelled through `lib/telemetry.ts`'s `trackError`
(so the root `AppErrorBoundary`, the global `unhandledrejection` handler, and every `trackError`
call report). It's **fully DSN-gated**: with `VITE_SENTRY_DSN` unset it's a no-op and transmits
nothing — so local/dev and any un-configured build are unaffected.

To enable on a deploy: set `VITE_SENTRY_DSN` (runtime capture) and, for source maps,
`SENTRY_AUTH_TOKEN` + `SENTRY_ORG` + `SENTRY_PROJECT` (build-step secrets). Source maps are emitted
`hidden`, uploaded, then deleted from `dist/` — and **not emitted at all** when the auth token is
absent, so maps are never published. The Sentry ingest host (`https://*.sentry.io`) is already in
the CSP `connect-src` of both `netlify.toml` and `vercel.json`. Privacy: errors-only,
`sendDefaultPii: false`, and a `beforeSend` scrubber redacts 0zk/EVM addresses + long hex from the
message, stack, breadcrumbs, and request URL before transmission.

## Pre-demo checklist (human actions)

- [ ] **`DEPLOYMENT_REF`** (recommended for production) pinned to a specific `ship-armada/armada-deployments` commit SHA on Netlify + Vercel — otherwise the build floats on `main` (P1-23).
- [ ] **Sentry** (optional): set `VITE_SENTRY_DSN` to enable error capture; add `SENTRY_AUTH_TOKEN` + `SENTRY_ORG` + `SENTRY_PROJECT` to upload source maps. All inert until set.
- [ ] **`VITE_RELAYER_URL`** set to the relayer's **HTTPS** origin and the VPS relayer confirmed reachable over HTTPS, if you want relayer-mediated flows (fees / gasless). Unset → wallet-submit only + a "no relayer configured" banner (P0-10).
- [ ] **WalletConnect** (P2): set a real `VITE_WALLETCONNECT_PROJECT_ID` and enable the **domain allowlist (Verify API)** for the deploy origin in WalletConnect Cloud, so the project ID can't be used from other origins.
- [ ] **CSP** promoted from `Content-Security-Policy-Report-Only` to enforcing only after a preview click-through with devtools open, and after adding the relayer origin + any IPFS gateway host to `connect-src` in both `netlify.toml` and `vercel.json` (P0-8).

## Running the relayer for Sepolia

On a VPS or your machine (with a tunnel if you need HTTPS for Vercel):

```bash
source config/sepolia.env
# config/secrets.env with DEPLOYER_PRIVATE_KEY
npm run relayer:sepolia
```

Expose port `3001` (or reverse-proxy to HTTPS) and set that origin as `VITE_RELAYER_URL`, then **redeploy** the frontend so Vite bakes the URL into the bundle.

## Local development

```bash
npm run chains          # Anvil (local mode only)
npm run setup           # local deploy
npm run armada-relayer  # http://localhost:3001
```

Copy `.env.example` → `.env.development` with `VITE_NETWORK=local` and `VITE_RELAYER_URL=http://localhost:3001`.
