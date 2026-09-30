# Paros Integration Layer

**Status:** Draft v1 — specification for the proposed Armada × Paros integration: Armada as the
"protected USDC movement layer" underneath Paros, a capital-management control plane (accounts,
strategies, venue deployment, payroll/vendor distributions, reporting), with custody gated by
Salt (secp256k1 DKLS23 threshold signing + policy templates).

**Audience:** an implementing agent starting fresh. Self-contained: it embeds the conclusions of
the Paros pitch brief and its repo reality-check (July 2026, branch
`iskay/railgun-sdk-usage-analysis`), which will not necessarily be available later.

**Relationship to `specs/ARMADA_SDK.md`:** this layer is a **consumer** of `@armada/sdk` and
becomes buildable once SDK Phase 2 ships (it needs the `SpendSigner`/`ExternalSigner` interface,
view-only wallets, the plan/prove pipeline, and the headless Node profile — all Phase 2
deliverables). **Nothing in this document may be implemented inside the
`ship-armada/armada-sdk` repo** — the SDK freezes the custody interface; this layer implements
connectors, gating, policy, and product surface against it. The SDK's Phase 2 acceptance
criteria enforce this boundary (`rg -i "salt|paros" src/` in the armada-sdk repo returns
nothing).

### Implementation readiness

| Section | Status |
|---|---|
| §1 Overview & product wedges | Ready |
| §2 Claim discipline | Ready — hold this line in all partner-facing text |
| §3 Architecture & custody topology | Ready |
| §4 Signer service | Ready — Salt off-chain-signing capability unconfirmed (§10) |
| §5 Movement API | Ready |
| §6 Reporting package | Ready |
| §7 Privacy policy engine | Ready (integrator-layer; presets enumerated) |
| §8 Yield wedge | Demo-scoped only — production gaps listed |
| §9 Threshold signing | Roadmap, not v1 |
| §10 Open questions | Ready |
| §11 Workstreams & sequencing | Ready |

---

## 1. Overview

### 1.1 The two systems

**Paros** operates internal accounts (e.g. Main Treasury, Yield Reserve, Operating, Trading
Desk), automated strategies (sweep/deploy, scheduled, distribute), venue deployment (Aave,
Morpho, Compound, Pendle, T-bills, Lido, …), recurring payroll/vendor/investor distributions,
and a reporting catalogue. Custody sits on **Salt** (threshold secp256k1 signing with fixed
policy templates: allow/deny lists, amount limits, contract-parameter restrictions). Today the
entire operating graph is public on-chain: who holds capital, where it routes, when strategies
fire, who gets paid.

**Armada** supplies protected balances, private in-pool movement, in-pool Aave-USDC yield, and
voluntary viewing-key disclosure — via the hub-and-spoke privacy pool and `@armada/sdk`.

**The fit:** Paros produces exactly the transaction types the pool wants (recurring,
USDC-native, latency-tolerant), and Paros customers already tolerate approval-gated,
latency-tolerant movement (Salt-gated routing) — which is the friction privacy needs.
**Honesty flag carried from the source brief:** flow-fit is argued; *demand* (will Paros
customers change behaviour) is not proven. Treat the pilot (§11.3) as the demand test.

### 1.2 Product wedges, ranked

1. **Protected USDC balance per Paros account** — the primitive. One Paros account ↔ one
   protected wallet ↔ one disclosure boundary. Shown in Paros as a balance bucket.
2. **Private internal transfers** — movement between two protected accounts stays inside the
   pool: no public unshield, no amount/timing trace. (Not "free" — see §2 note on fees.)
3. **Protected payroll/vendor distributions** — the commercial wedge. Recurring,
   schedule-tolerant, exactly the pool's comfort zone.
4. **Protected Aave-USDC yield** — the differentiator, scoped to **Aave-USDC only** and
   currently **demo-real, production-incomplete** (§8).
5. **Source-protected non-Aave deploys** (Morpho/Pendle/T-bills/…) — hides origin and account
   linkage; the destination action stays public. Never claim destination privacy for these.

**Cut from the pitch:** private gas refills (viable app-layer recipe, never a headline).

### 1.3 Scope note: single-chain v1

This integration's v1 is **single-chain (hub only)**. It does not exercise Armada's CCTP
hub-and-spoke cross-chain layer at all. That is a deliberate narrow start — but if Paros asks
for multi-chain protected balances, that is the CCTP layer doing work this spec never scopes;
flag it explicitly as new scope (the SDK's ops journal covers the client-side machinery, but
integration design would be net-new).

---

## 2. Claim discipline

Hold this line in any partner-facing or user-facing text:

| Say | Do NOT say |
|---|---|
| Protected balances break the public link between customer, account, source, and execution | "Armada makes Paros private" |
| Internal account movement is fully private once balances are protected | Anything implying destination privacy for unsupported venues |
| Aave-USDC idle yield can be structurally private inside the pool | "Paros DeFi strategies become private" |
| Non-Aave deploys are source-protected; the venue action stays public | "We hide your Morpho position" |
| Disclosure is voluntary, user-initiated, cryptographically precise | Anything resembling enforcement/gatekeeping by Armada |

- **Fees:** in-pool transfers carry a broadcaster fee (taken from the transferred amount per
  the relayer fee model) and the protocol fee surface (`specs/FEE_STRUCTURE.md`) applies.
  Verify against the live fee model before putting "free once shielded" in any deck.
- **If ARM/fundraising comes up:** governance authority over the treasury — never an
  investment/return story.

---

## 3. Architecture & custody topology

### 3.1 Components

```
┌ Paros platform (them) ──────────────────────────────────────────┐
│ accounts · strategies · scheduling · reporting UI · Salt custody │
└───────────────┬─────────────────────────────────────────────────┘
                │  movement API (§5) + reporting API (§6)
┌ Integration layer (this spec) ──────────────────────────────────┐
│                                                                  │
│  Movement service        — @armada/sdk instance(s), headless     │
│  (proof boundary)          Node profile; plan/prove/submit,      │
│                            ops journal for recurring flows       │
│                                                                  │
│  Signer service (§4)     — holds Baby Jubjub spending keys       │
│                            (HSM/enclave); implements the SDK's   │
│                            ExternalSigner transport; releases    │
│                            signatures ONLY against a verified    │
│                            Salt authorization over the intent    │
│                            digest; TTL + intent policy;          │
│                            append-only approval transcript       │
│                                                                  │
│  Reporting service (§6)  — per-account view-only wallets,        │
│                            reconciliation, receipts, disclosure  │
│                            log                                   │
└───────────────┬─────────────────────────────────────────────────┘
                │  relayer POST /relay (unchanged)
        Armada relayer → PrivacyPool (hub)
```

### 3.2 Non-negotiable design rule

> **No protected balance is controlled solely by an agent hot key.**

The movement service can *plan* transactions but can never sign them. The signer service can
*sign* but only against a cryptographically verified Salt authorization. Compromise of either
service alone cannot move funds.

### 3.3 Account model

- One Paros account ↔ one protected wallet ↔ one disclosure boundary. A shared viewing key
  exposes exactly one account's history, nothing else.
- Wallet identities derive from per-account rootSecrets generated and held inside the signer
  service boundary (never in the movement service, never in Paros's application tier).
- **Viewing-key hygiene (product constraint, not a bug):** viewing keys are irrevocable once
  shared — they expose the wallet's entire history, past and future. Rotation = create a new
  wallet + migrate balance + update the account mapping. The reporting service keeps a
  disclosure log (§6) of every key ever shared.

### 3.4 Proof boundary

Proof generation (and therefore decrypted-note visibility) lives in the **movement service**,
recommended to be operated by Paros's backend (their confidentiality boundary already holds
account data; keeping proofs there avoids Armada becoming a data processor for Paros customer
flows). Confirm this placement early — it determines who runs the `@armada/sdk` instances and
where viewing keys for *operational* (non-reporting) sync live. (Open question §10.3.)

---

## 4. Signer service

### 4.1 Interface

Implements the SDK's `SpendSigner` contract (`specs/ARMADA_SDK.md` §4.2.1) over an
out-of-process transport (transport choice is this project's decision — SDK open decision 8).
The SDK guarantees each `SpendSignRequest` carries the fully-bound intent: poseidon digest,
nullifiers, output commitments, merkle root, decoded `boundParams` including adapt contract and
decoded adapt calldata, and a human/policy-readable plan summary. **Batch semantics:** the
service sees the entire batch before releasing any signature — one approval = one fully-bound
intent (or one explicitly enumerated batch), including any adapter call it authorizes.

### 4.2 The Salt gate (cryptographic, not API-trust)

The signer service releases an EdDSA-Poseidon spend signature **only** against a
Salt-threshold-signed authorization over the Armada intent digest, verified locally by
`ecrecover` against the registered Salt group key. The gate is cryptographic — the service does
not trust any API's claim that "policy passed"; it verifies the signature itself.

- **Primary path:** Salt SDK off-chain message signing over
  `authDigest = keccak256("armada-intent-auth:v1" ‖ chainId ‖ poolAddress ‖ intentDigest ‖ ttl)`,
  with Salt policy templates evaluated on that signing request. **Unconfirmed** whether Salt
  exposes off-chain message signing with policy enforcement (open question §10.4).
- **Fallback — authorizer-contract pattern:** Salt signs a zero-value transaction to an
  `ArmadaAuthorizer` contract with the auth digest in calldata. Every Salt policy template
  (contract allow-lists, parameter restrictions, amount limits) then applies natively to that
  transaction. The authorizer contract needs no state and no privileged role — it exists so the
  digest transits a shape Salt policies can inspect. (New contract, but outside the privacy
  pool's trust surface; still requires normal review.)

### 4.3 Two-layer policy (unavoidable)

Salt templates gate what they can express (destinations, amounts, contracts). The signer
service enforces **intent-level policy Salt cannot express**:

- **TTL** between authorization and signature release, and between release and expected
  submission (see §4.4);
- intent-digest binding (the signature released matches exactly the digest authorized);
- velocity limits per account (value/period);
- purpose tags (payroll/vendor/rebalance/…) recorded in the transcript;
- batch-composition rules (e.g. a distribution batch may only contain whitelisted payee
  0zk addresses).

### 4.4 Signature lifecycle (must be documented to the partner)

A signed/proved Armada transaction has **no on-chain expiry** — it remains valid until one of
its input notes is nullified. Consequences, stated plainly:

1. The signer service enforces a TTL between signature release and expected submission and
   alarms on overdue submissions.
2. **Emergency revocation procedure:** spend one input note of the outstanding transaction
   elsewhere (an ordinary self-transfer built via the SDK) to consume its nullifier,
   invalidating the signed transaction. This is a documented runbook, exercised in tests.
3. Swap/delivery recipes carry only *incidental* expiry via quote deadlines.

Nobody may assume approvals lapse on-chain.

### 4.5 Transcript

Append-only, tamper-evident log of every request, authorization, release, refusal, and TTL
expiry, keyed by intent digest — the audit trail for §6's auditor package. Contains digests and
plan summaries; never key material.

---

## 5. Movement API (integration surface for Paros)

A thin, typed veneer over the SDK's plan/prove pipeline. Indicative surface:

| Endpoint | SDK mapping |
|---|---|
| `createProtectedAccount(parosAccountId)` | signer-service rootSecret provision + `wallet.fromRootSecret` + view-only key export to reporting service |
| `shieldUSDC(account, amount)` | `sdk.shield.buildRequest` (incl. gasless permit-wrapper path) → submit |
| `privateTransfer(from, to, amount, purposeTag)` | `wallet.planTransfer` → preflight → prove (ExternalSigner) → relayer `/relay` |
| `privateDistribution(from, payees[], schedule)` | batched `planTransfer` outputs; recurrence + resumability on `sdk.ops` journal |
| `privateWithdrawOrAdapt(account, dest, amount, adaptSpec?)` | `planTransfer` with unshield + typed adaptParams (yield adapter; delivery recipes stay app-layer) |

Requirements:

- Every mutating call flows through preflight (root freshness, nullifier liveness, fee-quote
  validity, pause state) before any signature is requested — failed preflight never reaches the
  signer service.
- Distributions are journal-backed: crash-safe, resumable, idempotent per (schedule, period,
  payee); a restarted service never double-pays.
- Relayer contract unchanged: fee quotes from `GET /fees`, fee output committed in-proof,
  submission via `POST /relay`, status via `GET /status/:txHash`.
- Delivery conversion (0x-style swap-on-unshield recipes) stays at this layer or above — do not
  enshrine any DEX in the protocol or SDK.

---

## 6. Reporting package

Built entirely on view-only wallets (SDK §4.2.2) — the reconciliation primitive already proven
in-stack by the relayer's viewing-key fee verification:

- **Private ledger per account:** view-only sync produces balances + decrypted history
  (amounts, counterpart 0zk where disclosed, memos, purpose tags) for exactly one account.
- **Distribution summaries:** per schedule run: intended vs confirmed payees, fees, tx refs —
  joined from the ops journal + view-only history.
- **Receipts:** per-payment disclosure via the SDK's disclosure-bundle export (one note, one
  receipt; verifier recomputes the commitment and checks on-chain inclusion).
- **Auditor package:** scoped viewing-key handover (one account, documented irrevocability) +
  transcript extract + receipts. Voluntary, customer-initiated — Armada never gatekeeps.
- **Disclosure log:** append-only record of every viewing key shared (when, to whom, scope) and
  every receipt exported. Feeds the rotation runbook.
- **Key-rotation runbook:** new wallet, migrate balance (an ordinary private transfer), update
  account mapping, mark old wallet's key as disclosed-historical.

---

## 7. Privacy policy engine (Paros-layer presets)

Lives at the Paros/integration layer — the protocol and SDK stay policy-free. Presets applied
per account or per flow:

- **immediate** — submit as soon as proved (lowest latency, weakest timing privacy);
- **scheduled** — submit inside a randomized window (payroll default);
- **rounded** — round amounts to configured quanta to resist amount-correlation;
- **split** — divide large movements across multiple notes/submissions over time;
- **caps** — value ceilings per movement/period (composes with signer-service velocity);
- **whitelist** — payee 0zk allow-lists (composes with Salt templates);
- **purpose tags** — labels bound into the transcript and reporting, never on-chain.

These are recommendations enforced by the movement + signer services; none are protocol
guarantees, and partner-facing text must not present them as such.

---

## 8. Yield wedge — honesty constraints

Current repo state (verify at implementation time):

- The in-pool form genuinely matches the pitch: `ArmadaYieldVault` (deliberately non-standard
  ERC-4626 — do not "fix") aggregates idle USDC into a single pooled Aave position; two-token
  model, shielded USDC ↔ shielded ayUSDC via `ArmadaYieldAdapter` (`lendAndShield`,
  `redeemAndShield`); no public per-user venue deposit.
- **Aave is 100% mocked** (`MockAaveSpoke`, simulated linear interest) — including on Sepolia.
- Yield integration tests run with `setTestingMode(true)` (ZK bypass — a tracked POC
  shortcut). **Any partner-facing demo claiming "real proofs" must run with testing mode OFF**,
  and no one may enable a verification bypass as a convenience (repo-wide rule).
- **Timing fingerprint:** the protocol fee settles on the public Aave withdrawal at redeem
  time; a lone redeemer can be correlated. Partially mitigated by the permissionless,
  cadence-gated `harvestProtocolFee`.
- Hub-only; no cross-chain yield.

**Pitch verdict:** "protected USDC earning yield" is honestly demoable today against mock Aave;
production requires real Aave integration, real-proof test coverage, fingerprint mitigation
review, and remains hub-only. Scope every claim to **Aave-USDC**.

---

## 9. Threshold signing (roadmap, not v1)

**Ship single-signer first.** Threshold is a pure signer swap behind the SDK's `SpendSigner`
interface — circuits/contracts/tx semantics only ever see a standard EdDSA-Poseidon signature.

Candidate: fork-and-harden `f3rmion/fy` (Go, FROST on Baby Jubjub, RFC 9591). Mandatory
hardening list from the spike, in priority order:

1. **Independent viewing keypair.** fy derives the viewing key deterministically from the group
   key — giving every signing participant permanent, unrotatable view access. Fix: generate an
   independent viewing keypair (the shareable-viewing-key path accepts an arbitrary one).
2. Add the group key to the binding-factor input (RFC 9591 §4.4).
3. Blake2b for H1/H3/H4/H5 domain-separated hashes.
4. DKG proof-of-possession.
5. Side-channel review.
6. Independent audit — the long pole; schedule it before any production custody claim.

---

## 10. Open questions (resolve before serious commitment)

| # | Question | Owner/route |
|---|---|---|
| 1 | ~~Circuit artifact EdDSA-Poseidon encoding byte-identical?~~ | Closed by SDK Phase 0 vector suite (ARMADA_SDK §10, spend-authorization vectors) |
| 2 | ~~External-signer connector interface in engine 9.5.1?~~ | Obsolete — the SDK defines `SpendSigner`; this project builds against it (frozen end of SDK Phase 2) |
| 3 | Proof-generation boundary: Paros backend vs Armada-operated service | Product/legal decision; recommendation §3.4 (Paros backend) |
| 4 | Does the Salt SDK expose off-chain message signing with policy enforcement? | Determines §4.2 primary vs authorizer-contract fallback; ask Salt early |
| 5 | Which deployment instance/chain does the pilot target? | `armada-deployments` instance selection; hub-only for v1 |
| 6 | Viewing-key retention: what Paros stores, where, rotation cadence | §3.3/§6 hygiene policy → partner agreement |
| 7 | Signed-but-unsubmitted revocation runbook sign-off | §4.4; write + test before pilot |
| 8 | Demand validation: will pilot customers actually route flows through protected balances? | The pilot itself (§11.3) is the test |

**Deferred:** threshold signing (§9), 0x delivery recipes, gas refills, non-USDC assets,
non-Aave private venue support, cross-chain protected balances (§1.3).

---

## 11. Workstreams & sequencing

### 11.1 Workstreams

| WS | Scope | Start state / dependency |
|---|---|---|
| A | Account mapping (Paros acct ↔ protected wallet, 1 per disclosure boundary) | Greenfield; needs SDK Phase 2 wallet APIs |
| B | Balance & history sync + reconciliation | View-only wallets (SDK Phase 2); primitive proven by relayer fee verifier |
| C | Movement API (§5) | Greenfield veneer over SDK plan/prove; needs Phase 2 |
| D | Signer service + Salt gate (§4) | Greenfield against frozen `SpendSigner` interface; `ecrecover` gate buildable **now** as a pure function (no Salt, no SDK dependency) |
| E | Privacy policy engine (§7) | Greenfield, Paros layer |
| F | Aave-USDC yield readiness (§8) | Partially built; production gaps are protocol work outside this spec |
| G | Source-protected deploys (adapter substrate + review-step privacy summary) | Adapter substrate live (`AdapterRegistry`, `ArmadaYieldAdapter` pattern); policy/UX net-new |
| H | Reporting package (§6) | View-only + disclosure bundles (SDK Phase 2/3); transcript from WS-D |

### 11.2 Early spikes (before/parallel to SDK Phase 2)

1. **`ecrecover` Salt-authorization gate as a pure function** — digest format, TTL check,
   group-key verification. No Salt SDK, no armada-sdk needed; permanent tests.
2. **Salt capability probe** — resolve open question 4 (off-chain signing + policy) with Salt
   directly; decide primary vs authorizer-contract path.
3. **View-only reconciliation e2e on the stock SDK** — `fromShareableViewingKey` exists in
   pinned 9.5.1; proving the WS-B reconciliation flow early de-risks reporting and produces
   fixtures the SDK's view-only implementation must match.

### 11.3 Pilot shape (v1)

One Paros account → protected USDC balance → private internal transfer → recurring
vendor/payroll distribution → reconciled reporting via view-only access → Salt-gated single
external signer. Aave-USDC protected yield included **only** as an explicitly-labeled demo
(mock Aave, §8). Hub-only. Success criterion: a real customer routes a real recurring flow
through it (open question 8).

---

## 12. Repo constraints & landmines (read before touching code)

- `contracts/railgun/logic/` is adapted Railgun — changes silently break ZK circuit
  compatibility. The signing/verification scheme is stock-compatible
  (`hashBoundParams` = keccak-mod-field on-chain is **stock**, not a divergence); keep it that
  way. Do not "improve" bound-params hashing.
- `ArmadaYieldVault` deliberately deviates from ERC-4626 — do not conform it.
- Frozen Launch-1 interfaces (`IShieldPauseController`, `IFeeCollector`) are external ABI.
- Never rely on or enable `setTestingMode()` / `VERIFICATION_BYPASS` (tracked POC shortcuts).
  Partner demos claiming real proofs run with testing mode OFF.
- Check "free once shielded" claims against the live fee model (broadcaster fee + shield fee +
  `specs/FEE_STRUCTURE.md`) before any partner deck.
- Relayer runs on a VPS — changes to `relayer/` or `config/*.env` need a pull+restart there.
- Git: feature branches + PR only; commit only when explicitly told. Named deployment instances
  live in `ship-armada/armada-deployments` (`npm run fetch-deployment -- <name>`).
