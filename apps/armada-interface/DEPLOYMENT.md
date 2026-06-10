# Deploying armada-interface (Vercel / Netlify)

> **Local vs deployed invariants (relayer, fees, env):** [`LOCAL_VS_DEPLOY.md`](./LOCAL_VS_DEPLOY.md) — read before changing `network.ts`, fee hooks, or hosting config.

## Required environment variables

| Variable | Vercel / Netlify | Purpose |
|----------|------------------|---------|
| `VITE_NETWORK` | `sepolia` | Use Sepolia manifests and RPCs (set in `vercel.json` for Vercel; `netlify.toml` for Netlify). |
| `VITE_RELAYER_URL` | **Public HTTPS URL** (optional) | Live `/fees` quotes. **Omit on Vercel** unless you host a relayer — wallet-submit flows use offline placeholders. Never use `localhost:3001` on hosted previews. |
| `VITE_WALLETCONNECT_PROJECT_ID` | Project ID | WalletConnect modal (optional for MetaMask-only testing). |
| `DEPLOYMENT_REF` | **Required, commit SHA** (build-step, non-VITE) | Pins which `ship-armada/armada-deployments` commit the manifests are fetched from. **The build fails if unset** — these manifests carry fund-receiving contract addresses, so we never float on a mutable branch like `main`. Set to a specific SHA and bump deliberately per release. |
| `DEPLOYMENT_INSTANCE` | Optional, defaults `demo1` (build-step, non-VITE) | Which instance directory under `testnet/` to fetch. |

Hosted Sepolia builds work without `VITE_RELAYER_URL` for deposit/send (user wallet submits). Cross-chain completion still requires your team’s relayer process running on infrastructure.

When `VITE_RELAYER_URL` is unset on a Sepolia build, the app now resolves the relayer URL to `''` (never `localhost:3001`): `isRelayerConfigured()` is false, so fee quotes don't fetch, gasless toggles disable, and the modals show a **"No relayer is configured"** banner steering the user to wallet-submit. Set `VITE_RELAYER_URL` to the public **HTTPS** relayer origin and redeploy to enable relayer-mediated flows. (An `http://` relayer from an `https://` page is blocked as mixed content — HTTPS is mandatory.)

## Pre-demo checklist (human actions)

- [ ] **`DEPLOYMENT_REF`** set to the intended `ship-armada/armada-deployments` commit SHA on Netlify + Vercel (build fails without it — P1-23).
- [ ] **`VITE_RELAYER_URL`** set to the relayer's **HTTPS** origin and the VPS relayer confirmed reachable over HTTPS (P0-10).
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
