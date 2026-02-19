# Insecure Defaults Report: Railgun CCTP POC

**Analyzed**: 2026-02-19
**Method**: Insecure Defaults Detection (Trail of Bits skill)
**Scope**: Contracts, deployment scripts, relayer, config, frontend

---

## Summary

| Severity | Count |
|----------|-------|
| CRITICAL | 3 |
| HIGH | 3 |
| MEDIUM | 4 |
| LOW | 4 |
| **Total** | **14** |

---

## CRITICAL Findings

### C-1: `testingMode` — Complete SNARK Proof Bypass

**Location:** `contracts/privacy-pool/PrivacyPool.sol:339`, `contracts/privacy-pool/modules/VerifierModule.sol:67`
**Pattern:** Owner-callable `setTestingMode(bool)` disables ALL zero-knowledge proof verification.

```solidity
// PrivacyPool.sol:339
function setTestingMode(bool _testingMode) external onlyOwner {
    testingMode = _testingMode;
}
```

**Verification:** When `testingMode == true`, the `verify()` function at `PrivacyPool.sol:378` returns `true` without checking the SNARK proof. This allows arbitrary commitments and nullifiers without mathematical verification.

**Production Impact:** CRITICAL. If the owner key is compromised or if testing mode is accidentally left on, anyone with access can forge transactions — creating fake commitments, double-spending nullifiers, and draining the pool.

**Mitigating Factor:** Deploy script (`scripts/deploy_privacy_pool.ts:203`) defaults to testing mode DISABLED. But the function remains callable by the owner at any time with no timelock or governance gate.

**Used in test files:** `test/privacy_pool_hardening.ts:123`, `test/privacy_pool_gas.ts:124`, `test/shielded_yield_integration.ts:146`, `test/privacy_pool_adversarial.ts:122`, `test/privacy_pool_integration.ts:489`

---

### C-2: `VERIFICATION_BYPASS` at `tx.origin == 0xdEaD`

**Location:** `contracts/railgun/logic/Globals.sol:10`, used in `PrivacyPool.sol:378` and `VerifierModule.sol:106`
**Pattern:** Verification returns `true` when `tx.origin == address(0xdEaD)`.

```solidity
// Globals.sol:10
address constant VERIFICATION_BYPASS = address(0xdEaD);

// PrivacyPool.sol:378
if (testingMode || tx.origin == VERIFICATION_BYPASS) return true;
```

**Verification:** Designed for `eth_estimateGas` calls (burn address, no known private key). However, if gas estimation results are used as proof of validity in any off-chain system, this creates a verification bypass vector. The 0xdEaD address is a well-known burn address.

**Production Impact:** Theoretically safe (no private key exists for 0xdEaD), but this is a code-level vulnerability. If any EVM implementation allows `tx.origin` spoofing in estimation contexts, or if a future precompile or account abstraction mechanism enables it, the entire proof system is bypassed.

---

### C-3: Hardcoded Private Keys in Production-Reachable Code

**Locations:**
- `hardhat.config.ts:8` — Anvil account 0 key
- `relayer/config.ts:64,69,74` — All 3 Anvil account keys

```typescript
// relayer/config.ts:64
privateKey: "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
```

**Verification:** These are well-known Anvil/Hardhat dev account keys. The relayer config module is imported by the production relayer entry point (`relayer/armada-relayer.ts`). There is NO environment variable fallback — the keys are hardcoded with no override mechanism.

**Production Impact:** If this relayer code runs against a real network without modification, the well-known private keys would be used. The relayer submits transactions and holds gas funds. Any attacker who recognizes the Anvil keys can front-run or drain the relayer's account.

**Fail-Open Analysis:** The app runs with these keys regardless of configuration. This is fail-open by design (local dev), but the code has no mechanism to prevent production use.

---

## HIGH Findings

### H-1: CORS Wide Open — No Origin Restrictions

**Location:** `relayer/modules/http-api.ts:36`
**Pattern:** `this.app.use(cors())` — allows requests from any origin.

**Verification:** The `cors()` middleware with no arguments defaults to `Access-Control-Allow-Origin: *`. This means any website can make cross-origin requests to the relayer API, including the `/relay` endpoint which submits transactions.

**Production Impact:** An attacker's website could submit relay requests to the relayer API from a user's browser. Combined with fee quote manipulation, this could lead to unauthorized transaction submission.

---

### H-2: No Rate Limiting on Relay API

**Location:** `relayer/modules/http-api.ts` — entire file
**Pattern:** No `express-rate-limit`, no throttling, no request budgeting.

**Verification:** Searched for `rate.?limit`, `throttl`, `max.?request`, `dos.?protect` — zero matches in the relayer codebase.

**Production Impact:** The relayer wallet is a shared resource. Without rate limiting, an attacker can:
- DoS the relayer by flooding `/relay` requests, keeping the wallet locked
- Drain the relayer's gas budget by submitting many valid transactions
- Exhaust fee quotes by spamming `/fees`

---

### H-3: No Security Headers

**Location:** `relayer/modules/http-api.ts` — no `helmet`, no `X-Frame-Options`, no CSP
**Pattern:** Missing standard HTTP security headers.

**Verification:** Searched for `helmet`, `security.?header`, `X-Frame`, `CSP`, `content.?security` — zero matches.

**Production Impact:** Missing headers enable clickjacking, MIME sniffing attacks, and information disclosure via stack traces (express default error handler).

---

## MEDIUM Findings

### M-1: Initializer Front-Running Risk

**Locations:**
- `contracts/privacy-pool/PrivacyPool.sol:64` — `require(!initialized)`
- `contracts/privacy-pool/PrivacyPoolClient.sol:76` — `require(!initialized)`

**Pattern:** The `initialize()` function checks `require(!initialized)` but does NOT restrict who can call it. Anyone who sees the deployment transaction can front-run the `initialize()` call and set themselves as owner.

```solidity
function initialize(
    address _shieldModule, ..., address _owner
) external {
    require(!initialized, "PrivacyPool: already initialized");
    // ... sets owner = _owner
}
```

**Production Impact:** MEDIUM. If deployment and initialization are not atomic (separate transactions), an attacker can front-run with their own parameters, becoming the owner. The deploy script calls `initialize()` in a separate transaction after `deploy()`.

---

### M-2: Privacy Pool Modules Lack ReentrancyGuard

**Location:** `contracts/privacy-pool/PrivacyPool.sol`, `modules/ShieldModule.sol`, `modules/TransactModule.sol`
**Pattern:** No `nonReentrant` modifier on any privacy pool entry point.

**Verification:** All other stateful contracts use `ReentrancyGuard`:
- ArmadaYieldVault, ArmadaYieldAdapter, ArmadaCrowdfund, ArmadaGovernor, VotingLocker, TreasurySteward, ArmadaTreasuryGov

But the privacy pool and its modules — which handle the highest-value operations (shield, transact, cross-chain transfers) — have ZERO reentrancy protection.

**Mitigating Factor:** The delegatecall pattern makes reentrancy harder to exploit since state is on the router, and USDC is not a reentrant token. But the adapter integration (`adaptContract` calls) could introduce reentrancy vectors.

---

### M-3: `fail_on_revert = false` in Foundry Invariant Config

**Location:** `foundry.toml:20`
```toml
[invariant]
fail_on_revert = false
```

**Verification:** With `fail_on_revert = false`, invariant tests silently swallow reverts. Functions that should never revert can fail without being detected. The fuzzer may explore only non-reverting paths, missing state-transition bugs that happen after a revert.

**Production Impact:** MEDIUM. This weakens the effectiveness of invariant testing by hiding potential issues behind reverts.

---

### M-4: Test Wallet Mnemonic in Repository

**Location:** `wallets/test-wallet.json`
```json
{
  "mnemonic": "crisp latin club cotton quarter wheel cherry just gallery armor job truly",
  "derivationIndex": 0,
  "railgunAddress": "0zk1..."
}
```

**Verification:** This file is tracked in git. While labeled as a test wallet, if a user generates a real wallet with this mnemonic (or if the mnemonic is used in any context beyond local testing), funds would be at risk. The mnemonic is publicly visible.

---

## LOW Findings

### L-1: Debug Mode Enabled in Frontend

**Location:** `usdc-v2-frontend/.env.local`
```
VITE_DEBUG=true
VITE_LOG_LEVEL=debug
```

**Verification:** Debug logging may expose internal state, transaction details, or key material in browser console. The `.env.local` file is typically not committed, but it exists in the repo.

---

### L-2: Hardcoded Hub Chain ID in Privacy Relay

**Location:** `relayer/modules/privacy-relay.ts:67`
```typescript
if (chainId !== 31337) {
    throw new RelayError("INVALID_CHAIN", ...);
}
```

**Verification:** The chain ID `31337` is the Hardhat/Anvil dev chain ID. This hardcoded value means the relayer can never work on mainnet or testnet without code modification. Not a security vulnerability, but a fail-closed deployment risk (relayer would refuse all requests on real networks).

---

### L-3: No TLS/HTTPS for Relayer Communication

**Location:** `relayer/modules/http-api.ts:156`
```typescript
this.server = this.app.listen(this.port, () => {
    console.log(`[http-api] Listening on http://localhost:${this.port}`);
```

**Verification:** Express server listens on plain HTTP. In production, transaction data (including calldata for shielded operations) would be transmitted in plaintext. Relay requests contain raw transaction data.

**Mitigating Factor:** Typically handled by a reverse proxy (nginx, cloudflare) in production. But no documentation or config for this exists in the repo.

---

### L-4: RPC URL Fallbacks to Localhost

**Location:** `hardhat.config.ts:26,32,38`, `scripts/link_privacy_pool.ts:142-143`
```typescript
url: process.env.HUB_RPC || "http://localhost:8545",
```

**Verification:** If environment variables are not set, the app silently falls back to localhost RPC. This is fail-open for local dev but fail-closed for production (no local node = all requests fail). The pattern is acceptable for dev-only tooling but should not reach production.

---

## Not Flagged (Intentional / Acceptable)

| Pattern | Why Not Flagged |
|---------|-----------------|
| TimelockController with 2-day delay | Reasonable for governance timelock |
| Deployer as initial admin | Standard pattern, roles are renounced after setup |
| Shield fee of 50 bps | Explicit configuration in deploy script |
| `setTestingMode` tested in test files | Test fixtures are out of scope |

---

## Recommendations

1. **Remove `setTestingMode`** from production contracts entirely. Use a compile-time flag or separate test contract.
2. **Remove `VERIFICATION_BYPASS`** from production code. Use a mock verifier contract for gas estimation instead.
3. **Move private keys to environment variables** with fail-secure behavior (crash if missing).
4. **Add CORS origin whitelist** to the relayer HTTP API.
5. **Add rate limiting** (e.g., `express-rate-limit`) to all relayer endpoints.
6. **Add security headers** (e.g., `helmet` middleware).
7. **Make `initialize()` atomic** with deployment, or add a deployer-only restriction.
8. **Add `nonReentrant`** to privacy pool entry points, especially `shield()`, `transact()`, and `atomicCrossChainUnshield()`.
9. **Set `fail_on_revert = true`** in Foundry invariant config.
10. **Remove `wallets/test-wallet.json`** from git tracking (add to `.gitignore`).
