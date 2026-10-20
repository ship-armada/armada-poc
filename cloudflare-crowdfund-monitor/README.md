# Armada Crowdfund Monitor — Cloudflare Pages

Read-only monitor for Ethereum mainnet crowdfund:

`0xB4b0BBac50Df6c9479180AA788dAd8f88D520163`

## RPC failover

Browser requests go only to `/api/rpc`. The Pages Function tries:

1. Pocket Network — `https://eth.api.pocket.network`
2. PublicNode — `https://ethereum-rpc.publicnode.com`
3. LlamaRPC — `https://eth.llamarpc.com`

It falls back on network errors, non-2xx HTTP responses, timeouts, malformed JSON, rate-limit errors, and common upstream overload errors.

## CSV upload

The UI accepts both:

```csv
name,address
Alice,0x1111111111111111111111111111111111111111
Bob,0x2222222222222222222222222222222222222222
```

and Armada whitelist-style CSV:

```csv
address,hop,label
0x1111111111111111111111111111111111111111,0,Alice
```

CSV contents are parsed client-side. Names and watchlist data are stored in browser localStorage and are not uploaded to Cloudflare.

## Cloudflare Pages settings

Connect this GitHub repository to Cloudflare Pages and use:

- Production branch: `cloudflare-crowdfund-monitor`
- Root directory: `cloudflare-crowdfund-monitor`
- Framework preset: None
- Build command: leave blank (or `exit 0`)
- Build output directory: `public`

Keep `functions/api/rpc.js` at the project root. Cloudflare maps it to `/api/rpc`.

Cloudflare's dashboard Direct Upload does not compile a `functions` directory; use Git integration or Wrangler if you want the RPC failover Function.
