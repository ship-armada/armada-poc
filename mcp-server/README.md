# Armada MCP Server

Development tooling server that exposes read-only inspection tools for AI coding agents via the [Model Context Protocol](https://modelcontextprotocol.io/).

## Tools

| Tool | Description |
|------|-------------|
| `get_deployment_state` | Scan deployment artifacts, report addresses, flag missing files and cross-reference mismatches |
| `get_chain_health` | Check RPC connectivity, block numbers, chain ID correctness, deployer balances, contract deployment status |
| `get_contract_state` | Query live on-chain state for privacy-pool, governance, yield, or crowdfund components |

## Setup

No extra setup needed if you're using Claude Code — the `.claude/mcp.json` config auto-starts this server.

For other MCP clients, point them at:

```bash
npx ts-node --project tsconfig.json mcp-server/src/server.ts
```

The `DEPLOY_ENV` environment variable controls which environment's deployment artifacts are loaded (`local` or `sepolia`). Defaults to `local`.

## Testing

```bash
npm run test:mcp              # Unit tests (no chains needed)
npm run test:mcp:e2e          # E2E protocol tests (no chains needed)
npm run test:mcp:integration  # Integration tests (requires `npm run chains` + `npm run setup`)
npm run test:mcp:all          # All MCP tests
```
