# Threat Model: Yield & RelayAdapt

**Domain:** ArmadaYieldVault, ArmadaYieldAdapter, ArmadaTreasury, RelayAdapt integration  
**Date:** 2025-02-13

---

## Architecture Summary

- **ArmadaYieldVault:** ERC4626-style vault wrapping Aave Spoke; non-rebasing shares; 10% yield fee on redemption.
- **ArmadaYieldAdapter:** Trustless bridge between PrivacyPool and vault. Uses adaptContract/adaptParams to bind unshield → deposit/redeem → shield.
- **RelayAdapt flow:** User proves unshield + multicall (approve, deposit) + shield in single ZK proof. RelayAdapt executes.
- **POC fallback:** lendPrivate/redeemPrivate for relayer-executed flows (no proof; relayer trusted).

---

## Threat Table

| ID | Threat | Description | Mitigation | Test Coverage |
|----|--------|--------------|------------|---------------|
| Y-01 | **Share inflation** | Attacker mints shares without depositing assets | ERC20 _mint only in deposit(); deposit requires underlying transfer | Yield integration tests |
| Y-02 | **Rounding down on deposit** | User receives 0 shares for small deposit | require(shares > 0) | Yield tests |
| Y-03 | **Yield fee bypass** | Adapter or user avoids 10% fee | Fee applied in redeem(); no adapter bypass (comment says removed) | Yield fee tests |
| Y-04 | **Cost basis manipulation** | User manipulates costBasisPerShare to reduce fee | Weighted average on deposit; principalPortion clamped to totalPrincipal | Precision tests |
| Y-05 | **Reentrancy in vault** | External call during deposit/redeem | ReentrancyGuard on deposit/redeem | Slither flagged; accepted |
| Y-06 | **Adapter privilege abuse** | Adapter steals unshielded funds | adaptParams binds npk; adapter MUST shield to user's npk | lendAndShield/redeemAndShield |
| Y-07 | **Relayer abuse (POC)** | lendPrivate/redeemPrivate: relayer steals | onlyRelayer; relayers are trusted in POC | Access control tests |
| Y-08 | **Unchecked transfer (fixed)** | shareToken.transfer ignored return | Fixed: safeTransfer in lendPrivate | Slither fix applied |
| Y-09 | **Spoke failure** | MockAaveSpoke/Aave returns 0 or reverts | Vault reverts on failed supply/withdraw | Integration tests |
| Y-10 | **Treasury zero address** | Fee transfer to address(0) | Owner sets treasury; no zero-check in vault (consider adding) | — |
| Y-11 | **RelayAdapt wrong target** | Multicall calls malicious contract | Proof commits to exact calls; user signs. Trust in proof system | RelayAdapt design |
| Y-12 | **Exchange rate manipulation** | Attacker manipulates spoke rate to drain vault | MockAaveSpoke is trusted; real Aave has its own security | Document dependency |

---

## Coverage Matrix

| Component | Unit Tests | Integration | Fuzz/Invariant | Formal |
|-----------|------------|-------------|----------------|--------|
| Vault deposit/redeem | ✓ | ✓ | — | — |
| Yield fee calculation | ✓ | ✓ | — | — |
| Adapter lendAndShield | ✓ | ✓ | — | — |
| Adapter redeemAndShield | ✓ | ✓ | — | — |
| Cost basis tracking | ✓ | ✓ | — | — |
| totalAssets consistency | ✓ | ✓ | ✓ YieldInvariant | — |

---

## Gaps and Recommendations

1. **Invariant:** Add `totalAssets() == underlying.balanceOf(vault) + spoke.getUserSuppliedAssets(...)` (or equivalent) to catch accounting bugs.
2. **Treasury zero-check:** Consider require(treasury != address(0)) in redeem when yieldFee > 0.
3. **POC relayers:** Document that lendPrivate/redeemPrivate are trusted-relayer flows; production should use lendAndShield/redeemAndShield.
4. **Spoke dependency:** Document trust in Aave/MockAaveSpoke for exchange rate and solvency.
