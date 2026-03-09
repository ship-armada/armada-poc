# Armada — Cross-Chain Privacy with Shielded Yield

## Project Overview

Armada combines a Railgun-style ZK shielded pool with Circle's CCTP V2 for cross-chain USDC bridging and DeFi yield integration. Hub-and-spoke architecture: the Hub chain holds the privacy pool and yield contracts; Client chains hold lightweight `PrivacyPoolClient` contracts. Users shield/unshield USDC across chains via a relayer.

**Status:** Actively transitioning from POC to production. Code quality expectations are rising — no new shortcuts, but existing POC-era shortcuts are known and tracked (see Known POC Shortcuts below).

For detailed architecture, see @.claude/ARCHITECTURE_NOTES.md

## Technology Stack

| Layer | Technology |
|-------|-----------|
| Smart Contracts | Solidity 0.8.17, OpenZeppelin 4.9.3 |
| ZK Cryptography | Groth16 SNARKs (snarkjs), Poseidon hash (BN254), EdDSA/BabyJubJub |
| EVM Tooling | Hardhat (compilation, deploy, integration tests), Foundry (fuzz/invariant tests) |
| Formal Verification | Halmos (symbolic execution) |
| Package Manager | npm (with workspaces for frontend) |
| TypeScript Runtime | ts-node |
| Relayer | Express v5, ethers v6 |
| Frontend (temporary) | React 19, Vite, Jotai, Tailwind v4, Radix UI |
| Railgun SDK | @railgun-community/engine 9.5.1, wallet 10.8.1 |

## Build & Test Commands

```bash
# Local environment
npm run chains              # Start 3 Anvil instances (hub:8545, clientA:8546, clientB:8547)
npm run setup               # Compile + deploy all contracts to local chains
npm run armada-relayer      # Start unified relayer (HTTP API + CCTP relay)
npm run demo                # Start frontend dev server

# Testing — run these before committing
npm run test                # Core privacy pool integration test (Hardhat/Mocha)
npm run test:all            # All Hardhat integration tests
npm run test:forge          # All Foundry fuzz/invariant tests (offline, no chains needed)
npm run halmos              # Halmos symbolic verification

# Specific test suites
npm run test:governance     # Governance lifecycle + adversarial tests
npm run test:crowdfund      # Crowdfund lifecycle + adversarial tests

# Crowdfund testing tools
npm run crowdfund-ui        # Start crowdfund frontend (port 5174)
npm run crowdfund:populate  # Fill crowdfund to $1M+ minimum (local only)

# Sepolia testnet
npm run setup:sepolia       # Deploy to Sepolia (requires config/secrets.env)
npm run relayer:sepolia     # Start relayer in real CCTP mode (Iris attestation)
```

## Known POC Shortcuts (Do Not Replicate)

The following are known security shortcuts inherited from the POC phase. They are tracked and will be addressed before production. **Do not create additional shortcuts like these:**

- `setTestingMode()` in PrivacyPool bypasses ZK proof verification
- `VERIFICATION_BYPASS` at `tx.origin == 0xdead` in Snark.sol
- Hardcoded Anvil private keys in config (acceptable for local only)
- Shield fee formula mismatch between contract and SDK
- ~~Missing `onlyDelegatecall` guards on pool modules~~ (Fixed: guards added to all module external functions)

**NEVER enable testing mode (`setTestingMode()`) or any SNARK verification bypass without explicit human instruction.** These exist for specific test scenarios and must not be turned on as a convenience shortcut.

When writing new code, follow production security practices even though these legacy shortcuts exist.

## Common Pitfalls

- `npm install` without `--legacy-peer-deps` will fail due to Railgun SDK peer dependency conflicts.
- Hardhat tests require Anvil chains running — if tests fail with connection/RPC errors, check `npm run chains`.
- Changing anything in `contracts/railgun/logic/` can silently break ZK circuit compatibility. Contracts compile fine, but proofs fail at runtime.
- Deployment scripts must run in order (see Deployment Order below). Deploying a component before its dependencies will produce silent misconfigurations.
- The Railgun SDK's LevelDB database (`data/railgun-db/`) can get into a stale state. If shield/transact operations fail unexpectedly after redeploying contracts, delete `data/railgun-db/` and restart.

## Relayer

- Entry point: `relayer/armada-relayer.ts`
- Two CCTP modes controlled by `CCTP_MODE` env var:
  - `mock` (local): Direct relay without attestation
  - `real` (Sepolia): Uses Circle's Iris attestation service
- HTTP API on port 3001: `/relay` (submit transactions), `/fees` (fee quotes)
- Fee quotes are cached with a 5-minute TTL

## File Organization

| Directory | Purpose |
|-----------|---------|
| `contracts/` | All Solidity — privacy pool, clients, yield, governance, crowdfund, mocks |
| `test/` | Hardhat/Mocha integration tests (TypeScript) |
| `test-foundry/` | Foundry fuzz, invariant, and Halmos symbolic tests (Solidity) |
| `scripts/` | Hardhat deployment and utility scripts |
| `relayer/` | Node.js relayer service |
| `usdc-v2-frontend/` | Temporary React frontend |
| `crowdfund-frontend/` | Crowdfund testing UI (React, Vite, Jotai) |
| `lib/` | Foundry deps (forge-std, halmos) + Railgun SDK helpers |
| `config/` | Environment configs (local.env, sepolia.env, networks.ts) |
| `deployments/` | Generated deployment manifests (Sepolia ones are committed) |
| `audit-reports/` | AI-assisted security audit (57 findings, Trail of Bits methodology) |
| `reports/` | Threat models, formal verification notes, analysis reports |
| `docs/` | Implementation plans and specs |
| `_legacy/` | Deprecated earlier approach — do not modify |

## Environment & Secrets

- Local config: `config/local.env` (committed)
- Sepolia config: `config/sepolia.env` (committed, no secrets)
- Secrets: `config/secrets.env` (gitignored — contains deployer private keys for testnets)
- **Never commit private keys or secrets.** The Anvil default key in `hardhat.config.ts` is the sole exception (it's publicly known).

### Pre-Commit Sensitive Data Check

**Before every commit**, review the staged changes (`git diff --cached`) for accidentally included sensitive data:
- Private keys, mnemonics, or seed phrases
- API keys, auth tokens, or service credentials
- RPC endpoint URLs that contain API keys (e.g. Alchemy/Infura URLs with embedded keys)
- Absolute filesystem paths or usernames that leak system information

If a new file type or directory could contain secrets (e.g. `.env` files, key exports, wallet backups), add it to `.gitignore` **before** staging. When in doubt, gitignore first and ask — it is far easier to un-ignore a file than to scrub a secret from git history.

### `.gitignore` Hygiene

- When creating new config files, scripts that reference secrets, or any file that could contain environment-specific data, check whether it needs a `.gitignore` entry.
- Patterns to always gitignore: `*.key`, `*.pem`, `*.secret`, `.env.local`, `secrets.*` (unless already covered).
- Never rely on "I just won't commit it" — if a file should not be tracked, make `.gitignore` enforce it.

## Dependencies & Installation

```bash
npm install --legacy-peer-deps  # Required due to Railgun SDK peer dep conflicts
```

The `--legacy-peer-deps` flag is required. Do not remove it or switch to `--force`. The Railgun SDK packages have peer dependency conflicts that npm's strict resolution cannot resolve.

## Deployment Order Matters

Contracts must be deployed in this order (the `npm run setup` script handles this):
1. CCTP contracts (all chains)
2. PrivacyPool modules (all chains)
3. Aave mock (hub only)
4. Yield contracts (hub only)
5. Pool linking (hub — connects clients to hub)
6. Faucets (all chains)
7. Governance (hub only)
8. Crowdfund (hub only)

If you need to redeploy a single component, understand its dependencies first.

## Do Not Modify Without Discussion

The following are intentional design decisions or inherited code that may look like they need fixing but should not be changed without explicit human approval:

- **Railgun internals** (`contracts/railgun/logic/`) — Adapted from Railgun's open-source codebase. Changes break ZK circuit compatibility silently.
- **Non-standard ERC-4626 vault** (`ArmadaYieldVault`) — Intentionally deviates from the standard. Do not "fix" it to conform.
- **Frontend legacy code** (`usdc-v2-frontend/`) — Residual Namada/Noble/Cosmos code paths are harmless. The frontend is temporary and will be replaced.
- **Testing mode / verification bypass code** — These POC shortcuts exist in the codebase. Do not remove them (they're tracked), but never enable them without human instruction.
- **`_legacy/` directory** — Deprecated earlier approach. Do not modify or reference in new code.

## Simplifying Assumptions & TODOs

When you make a simplifying assumption, use a placeholder, create a stub, or skip a concern for later — **say so explicitly in chat and document it in the code.** Use `// TODO:` comments with enough context that the issue can be found and addressed later without needing the original conversation. Do not silently cut corners; the human needs to know what is deferred so nothing falls through the cracks.

## Issue Tracker (GitHub)

Issues are tracked on GitHub. Use the `gh` CLI for creating and editing issues.

When creating issues via Claude Code:
1. **Label**: Always add the `claude-generated` label.
2. **Annotation**: Always prepend this line as the first line of the issue description:
   ```
   > *This issue was generated by Claude Code agent and may require human review for accuracy and prioritization.*
   ```
3. Use `gh issue create` and `gh issue edit` for all issue operations.

## Documentation Upkeep

After changes or refactors, check whether related documentation needs updating. This includes: this CLAUDE.md, READMEs, inline doc comments, files in `docs/`, deployment manifests, and architecture notes. Stale documentation is worse than no documentation — keep it accurate.
