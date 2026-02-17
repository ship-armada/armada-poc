# Manual Review: Architecture Checklist

**Date:** 2025-02-17  
**Scope:** Upgradeability, proxy safety, trust assumptions, centralization

---

## Upgradeability

| Contract | Upgradeable? | Notes |
|----------|--------------|-------|
| PrivacyPool | ❌ | No proxy; initialized once. Module addresses set at init; no upgrade path. |
| ArmadaCrowdfund | ❌ | Immutable admin, usdc, armToken. |
| ArmadaYieldVault | ❌ | Immutable spoke, underlying, reserveId. Owner can set treasury/adapter. |
| ArmadaYieldAdapter | ❌ | Immutable usdc, vault. Owner can set relayers, privacyPool, tokenMessenger. |
| VotingLocker | ❌ | Immutable armToken. |
| ArmadaGovernor | ❌ | Immutable votingLocker, armToken, timelock, treasuryAddress. |
| ArmadaTreasuryGov | ❌ | Owner (timelock) transferable. |
| Railgun Proxy (lib) | ✅ | Proxy + ProxyAdmin pattern; used for Railgun legacy. |

**POC:** No upgradeable proxies for Armada contracts. Production may consider proxy for governance/treasury.

---

## Proxy Safety

| Item | Status | Notes |
|------|--------|-------|
| Storage layout | N/A | No Armada proxies. |
| Constructor vs init | ✅ | PrivacyPool uses `initialize()`; one-time `initialized` guard. |
| Delegatecall | ⚠️ | PrivacyPool delegates to modules. **Controlled:** Module addresses set by owner at init. Slither: controlled-delegatecall — accepted. |

---

## Trust Assumptions

| Component | Trust | Notes |
|-----------|-------|-------|
| Crowdfund admin | Centralized | Adds seeds, starts phases, finalizes, withdraws. Single admin. |
| Yield vault owner | Centralized | Sets treasury, adapter. |
| Yield adapter owner | Centralized | Sets relayers, privacyPool. Relayers execute private ops. |
| PrivacyPool owner | Centralized | Sets verification keys, fee, treasury, remote pools. Can enable testing mode (POC). |
| TimelockController | Decentralized | Governs treasury; multi-sig or DAO. |
| RelayAdapt | Trustless | User's proof binds calls; relay cannot deviate. |
| CCTP | Trusted | Circle attestation; bridge security. |
| Aave | Trusted | Yield source; protocol risk. |

---

## Centralization Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| Crowdfund admin finalizes late | Low | Commitment window ends; admin can delay but not steal. |
| Crowdfund admin withdraws proceeds early | Low | Proceeds accrue as users claim; admin can withdraw available. |
| Yield adapter owner sets malicious relayer | Medium | Relayer executes private ops; if malicious, could front-run or censor. Use trusted relayers. |
| PrivacyPool owner sets wrong verification key | High | Invalid proofs could be accepted. Owner must be trusted or DAO. |
| PrivacyPool testing mode | Critical | Bypasses SNARK. **POC only** — must be disabled for mainnet. |
| Treasury steward 1% budget | Low | Governance can replace steward; budget is per-token, per-period. |

---

## Module Pattern (PrivacyPool)

```
PrivacyPool (router)
  ├── ShieldModule   (delegatecall)
  ├── TransactModule (delegatecall)
  ├── MerkleModule   (delegatecall)
  └── VerifierModule (delegatecall)
```

- **State:** All in PrivacyPoolStorage; modules share storage via delegatecall.
- **insertLeaves:** Called via `address(this)` from modules; router restricts to self.
- **Module addresses:** Set at init; no runtime change.

---

## Summary

- **Upgradeability:** None for Armada; POC is immutable.
- **Proxy safety:** PrivacyPool init is safe; delegatecall to fixed modules.
- **Trust:** Admin/owner roles are centralized; timelock for treasury.
- **Centralization:** Documented; testing mode must be off for production.
