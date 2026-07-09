# Local vs deployed — armada-interface

**Read this before changing `network.ts`, `useFees`, `resolveFeeCacheId`, `vercel.json`, `netlify.toml`, or env examples.**

The app has two environments. They must stay split in code and in hosting env vars. Do not “simplify” by using one default for both.

## Quick reference

| Concern | Local (`VITE_NETWORK=local`) | Hosted Sepolia (Vercel / Netlify) |
|--------|------------------------------|-----------------------------------|
| **Network** | Anvil hub + client chains (`31337`…) | Sepolia + Base/Arb Sepolia |
| **Set in** | `.env.development` (from `.env.example`) | `vercel.json` `build.env` + Netlify `netlify.toml` → `VITE_NETWORK=sepolia` |
| **Relayer URL** | Defaults to `http://localhost:3001` | **Empty unless** `VITE_RELAYER_URL` is set to a **public HTTPS** origin |
| **Relayer HTTP** | `fetchFees` hits localhost (or override) | No localhost; `isRelayerConfigured()` is false → **offline fee schedule** |
| **Fee quote on submit** | Falls back to `offline-fees` if relayer down | Same offline id when no `VITE_RELAYER_URL` |
| **Wallet submit** | User wallet (deposit, send, …) | Same — does not require relayer `/fees` today |
| **Mock USDC** | `VITE_DEV_MOCK_BALANCE` / Debug drip | Off — real Sepolia USDC |
| **Unlock “Start over”** | Shown (`isLocalMode()`) | Hidden on testnet |

## Code invariants (do not regress)

1. **`resolveRelayerUrl()` in `src/config/network.ts`**
   - Explicit `VITE_RELAYER_URL` → use it (trim, no trailing slash).
   - `local` mode, unset env → `http://localhost:3001`.
   - `sepolia` mode, unset env → **`''` (empty string), never localhost.**

2. **`isRelayerConfigured()`** — `relayerUrl.length > 0`. Hosted builds without env must stay “not configured”.

3. **`useFees`** — query **disabled** when relayer not configured; seed `offlineFeeSchedule()` instead of calling `localhost:3001`.

4. **`resolveFeeCacheId`** — returns `offline-fees` when `!isRelayerConfigured()` or local relayer unreachable; do not throw on Vercel solely because `/fees` failed.

5. **Do not** add `?? 'http://localhost:3001'` to `sepoliaConfig()` relayer URL.

6. **Hosting files** — keep aligned:
   - `vercel.json` → `"VITE_NETWORK": "sepolia"`
   - `netlify.toml` → `[build.environment] VITE_NETWORK = "sepolia"`
   - Optional: `VITE_RELAYER_URL` only when a public relayer exists.

## Local setup

```bash
# repo root
npm run chains
npm run setup
npm run armada-relayer   # :3001
npm run armada:interface # :5176
```

```bash
cp apps/armada-interface/.env.example apps/armada-interface/.env.development
# VITE_NETWORK=local
# VITE_RELAYER_URL=http://localhost:3001
```

## Deploy checklist

- [ ] `VITE_NETWORK=sepolia` in Vercel/Netlify (or rely on committed `vercel.json` / `netlify.toml`).
- [ ] Do **not** set `VITE_RELAYER_URL=http://localhost:3001` on hosted previews.
- [ ] Set `VITE_WALLETCONNECT_PROJECT_ID` for WalletConnect.
- [ ] Optional: `VITE_RELAYER_URL=https://…` when team relayer is on HTTPS.
- [ ] Redeploy after changing any `VITE_*` (baked in at build time).

## Tests

- `src/config/network.relayer.test.ts` — sepolia without env → empty URL; local → localhost.
- `src/lib/relayer/resolveFeeCacheId.test.ts` — hosted path uses `offline-fees` without refresh.

If you change relayer resolution, run:

```bash
npm test --workspace=@armada/interface -- --run network.relayer resolveFeeCacheId useFees
```

## Related docs

- `DEPLOYMENT.md` — Vercel/Netlify env table and relayer ops
- `src/config/CLAUDE.md` — config module map
