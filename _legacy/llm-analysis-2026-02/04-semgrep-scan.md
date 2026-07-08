# Semgrep Static Analysis Report: Railgun CCTP POC

**Analyzed**: 2026-02-19
**Method**: Semgrep OSS 1.152.0 (no Pro engine)
**Scope**: All Solidity contracts in `contracts/`

---

## Scan Configuration

| Ruleset | Files | Rules | Findings |
|---------|-------|-------|----------|
| `p/security-audit` (baseline) | 44 | 2 | 0 |
| `p/secrets` (full project) | 643 | 43 | 0 |
| Decurity smart contracts | 44 | 42 | 30 |
| **Total** | — | **87** | **30** |

**Note:** Semgrep OSS has very limited Solidity support. The `p/security-audit` ruleset only matched 2 rules to Solidity files. Decurity third-party rules provided the bulk of coverage.

---

## Triage Summary

| Verdict | Count |
|---------|-------|
| True Positive | 2 |
| False Positive (Solidity 0.8.x overflow protection) | 24 |
| False Positive (intentional pattern / mock code) | 4 |
| **Total** | **30** |

---

## True Positives

### TP-1: Arbitrary Low-Level Call in Delegator (ERROR)

**Rule:** `basic-arbitrary-low-level-call`
**Location:** `contracts/railgun/governance/Delegator.sol:161`
**Severity:** ERROR

```solidity
return _contract.call{ value: _value }(_data);
```

**Analysis:** The `callContract()` function performs an arbitrary low-level call with user-supplied `_contract`, `_data`, and `_value`. The `call()` return value is returned but not explicitly checked for success.

**Mitigating Factor:** Access is controlled via `checkPermission(msg.sender, _contract, selector)` at line 155, which validates caller-contract-selector triples. This is a governance delegation pattern by design.

**Verdict:** TRUE POSITIVE — arbitrary low-level call exists but is gated by permission system. Risk depends on permission configuration. If a permissioned caller is compromised, arbitrary calls can be executed.

---

### TP-2: Unused `sender` Parameter in Hub CCTP Handler (WARNING)

**Rule:** `missing-assignment`
**Location:** `contracts/privacy-pool/PrivacyPool.sol:177`
**Severity:** WARNING

```solidity
(sender); // Silence unused variable warning
```

**Analysis:** The `handleReceiveFinalizedMessage()` function receives a `sender` parameter identifying the remote contract that initiated the CCTP message. This parameter is silently discarded. The comment acknowledges this: "For now, we trust that TokenMessenger only forwards valid messages."

**Cross-reference:** This was independently identified in the audit context report (02-audit-context.md) as "HIGH: Source Domain Not Validated on Hub." The Hub does NOT check `remoteDomain` against `remotePools`, nor does it validate the `sender`.

**Verdict:** TRUE POSITIVE — the `sender` and `remoteDomain` parameters should be validated to ensure messages only come from registered `PrivacyPoolClient` contracts.

---

## False Positives

### FP-1: Arithmetic Underflow in Solidity 0.8.x (24 findings, INFO)

**Rule:** `basic-arithmetic-underflow`
**Files:** MockAaveSpoke (3), ArmadaCrowdfund (1), ArmadaTreasuryGov (3), VotingLocker (2), MerkleModule (3), RailgunLogic (5), ArmadaYieldVault (7)

**Reasoning:** All contracts use Solidity 0.8.17, which has built-in overflow/underflow protection. Arithmetic operations revert automatically on underflow. The Decurity rule does not account for Solidity version. **All 24 are false positives.**

---

### FP-2: `(attestation);` in MockCCTPV2 (WARNING)

**Rule:** `missing-assignment`
**Location:** `contracts/cctp/MockCCTPV2.sol:420`

**Reasoning:** This is a mock contract. The real CCTP verifies attestation signatures, but the mock intentionally ignores it. This is correct test-infrastructure behavior.

---

### FP-3: `(sender);` in PrivacyPoolClient (WARNING)

**Rule:** `missing-assignment`
**Location:** `contracts/privacy-pool/PrivacyPoolClient.sol:201`

**Reasoning:** Unlike the Hub (TP-2), the Client already validates `remoteDomain == hubDomain` at line 198. The `sender` is less critical here since domain validation constrains the source to the Hub chain. Lower risk than TP-2.

---

### FP-4: Exact Balance Check in ShieldModule (WARNING)

**Rule:** `exact-balance-check`
**Location:** `contracts/privacy-pool/modules/ShieldModule.sol:238`

```solidity
require(balanceAfter - balanceBefore == base, "ShieldModule: Transfer failed");
```

**Reasoning:** This pattern defends against fee-on-transfer tokens by verifying the exact amount was received. For USDC (non-fee-on-transfer, 6 decimals), this is always true. The check is intentionally strict — if a fee-on-transfer token were used, the contract should revert rather than credit incorrect amounts. This is a security feature, not a bug.

---

### FP-5: Exact Balance Check in RailgunLogic (WARNING)

**Rule:** `exact-balance-check`
**Location:** `contracts/railgun/logic/RailgunLogic.sol:276`

**Reasoning:** Same pattern as FP-4 in legacy code.

---

## Observations

1. **Limited Solidity Coverage:** Semgrep OSS has minimal Solidity rules. The `p/security-audit` ruleset only ran 2 rules against Solidity files. For production audits, Slither or Mythril provide much deeper Solidity analysis.

2. **Decurity Rules Effective:** The Decurity third-party rules found 30 findings including 2 true positives. The arithmetic underflow rules need version-awareness to reduce false positives.

3. **No Secrets Found:** The `p/secrets` scan across 643 files found no hardcoded secrets matching its patterns. However, the insecure-defaults scan (03-insecure-defaults.md) did find hardcoded private keys that Semgrep missed — these use Anvil-specific key patterns not in the secrets ruleset.

---

## Output Files

- `semgrep-results-001/security-audit.json` — security-audit raw results (0 findings)
- `semgrep-results-001/security-audit.sarif` — SARIF format
- `semgrep-results-001/secrets.json` — secrets raw results (0 findings)
- `semgrep-results-001/secrets.sarif` — SARIF format
- `semgrep-results-001/decurity.json` — Decurity raw results (30 findings)
- `semgrep-results-001/decurity.sarif` — SARIF format
