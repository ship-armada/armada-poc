# Security Policy

## Reporting a Vulnerability

**Do not open a public GitHub issue for security vulnerabilities.**

If you discover a vulnerability in the Armada protocol, please report it responsibly:

- **Email:** security@armada.fi *(placeholder — update before mainnet)*
- **Subject line:** `[SECURITY] <brief description>`
- **Include:** affected contract(s), reproduction steps, potential impact

### Disclosure Timeline

| Step | Target |
|------|--------|
| Acknowledgement | 48 hours |
| Initial assessment | 5 business days |
| Fix development | Varies by severity |
| Coordinated disclosure | After fix is deployed or 90 days, whichever comes first |

We ask that you do not publicly disclose the vulnerability until we have had a reasonable opportunity to address it.

## Scope

### In Scope

- Smart contracts in `contracts/` (excluding `contracts/test/`, `contracts/railgun/`, `contracts/aave-mock/`, `contracts/cctp/`)
- Deployment scripts in `scripts/`
- Relayer service in `relayer/`

### Out of Scope

- Third-party dependencies (OpenZeppelin, Railgun, Circle CCTP) — report upstream
- Frontend applications (`usdc-v2-frontend/`, `crowdfund-ui/`) — temporary UIs, not production
- Known findings documented in `reports/slither-report.txt`
- Mock contracts used only in local/test environments

## Emergency Controls

The protocol includes several emergency mechanisms, each with built-in accountability constraints.

### Shield Pause (ShieldPauseController)

The Security Council can pause shield (deposit) operations for up to **24 hours**. Key properties:

- **Auto-expiry:** Pauses expire automatically after 24 hours — the SC cannot permanently freeze deposits
- **Governance override:** The timelock can unpause shields at any time
- **Unshields unaffected:** Withdrawals are never blocked by a shield pause (pre-wind-down)
- **SC address:** Read live from ArmadaGovernor — SC ejection via denied veto is automatically reflected

### Security Council Veto

The SC can veto queued governance proposals. Every veto triggers a mandatory community ratification vote:

- If the community **upholds** the veto, the proposal is permanently canceled
- If the community **overrides** the veto, the SC is ejected and the original proposal is re-queued
- A new SC can only be appointed via governance proposal — no self-reinstatement

### Governance Wind-Down

An irreversible protocol shutdown mechanism, activated via governance proposal:

- Disables all new proposals — governance ends permanently
- Pool enters **withdraw-only mode** — only unshields permitted
- SC gets exactly **one** post-wind-down emergency pause (24h, non-renewable) for final user protection
- Yield vault continues operating for withdrawals

## Incident Response Outline

### 1. Detection

Monitor on-chain events from:
- `ShieldPauseController` — pause/unpause activity
- `ArmadaGovernor` — proposal creation, vetoes, wind-down activation
- `PrivacyPool` modules — unusual shield/unshield patterns

### 2. Triage

Classify severity (Critical / High / Medium / Low) based on:
- Funds at risk
- Exploitability (requires specific conditions vs. freely exploitable)
- Scope of affected users

### 3. Containment

- **Immediate:** SC triggers shield pause (blocks new deposits for 24h)
- **Short-term:** Governance proposal for targeted fix or parameter change
- **Last resort:** Wind-down activation (irreversible — use only if protocol integrity is compromised)

### 4. Resolution

- Deploy fix via governance proposal through timelock
- If governance is compromised, wind-down is the fail-safe

### 5. Post-Mortem

- Root cause analysis
- Timeline of events and response
- Remediation steps and preventive measures
- Public disclosure per the timeline above

## Existing Security Documentation

- [Threat Model — Privacy Pool](reports/threat-model-privacy-pool.md)
- [Threat Model — Governance & Crowdfund](reports/threat-model-governance-crowdfund.md)
- [Threat Model — Yield](reports/threat-model-yield.md)
- [Manual Security Review](reports/manual-review-security.md)
- [Slither Report](reports/slither-report.txt)
- [Audit Reports](audit-reports/)
