# TX_SIGNING v2 Amendment

**Status:** Draft, accompanying the shielded-wallet redesign on branch
`feature/shielded-wallet-redesign`.

**Relationship to `TX_SIGNING.md`:** This document amends specific sections
of the parent spec. The parent spec remains the authoritative reference for
all unamended material. Where this amendment and the parent disagree, this
amendment governs for v2 and later.

**Scope of change:** This is a governance fork per the parent spec's
§"Enrollment Flow → Governance-frozen signing domain." The frozen identity
tuple is intentionally rotated:

- `domain.name` — unchanged ("Armada Protocol")
- `domain.verifyingContract` — derived from `'armada-enrollment:testnet:v2'`
  (was `'armada-enrollment:testnet:v1'`)
- `message.purpose` — unchanged
- `message.version` — `'2'` (was `'1'`)

All v1 identities are forked. Pre-mainnet status agreed; no migration is
provided per the project's "testnet wallets are disposable" policy.

---

## Amended sections

### Axiom 1 — Canonical Secret (revised)

**Original (parent §"Design Principles → Axiom 1"):**

> The `root_secret` is the authority. Wallet signatures are entropy
> sources, not identities. Users persist/export `root_secret`, not
> "re-sign later". Re-signing is unreliable convenience, not a recovery
> path.

**Revised (v2):**

> The `root_secret` is the authority. Wallet signatures are entropy
> sources. For deterministic-signing wallets (RFC 6979 ECDSA with EOAs)
> the re-sign path produces a reproducible signature and therefore a
> reproducible `root_secret`, making it a valid recovery path; for
> non-deterministic and smart-account wallets, the backup-file and
> paste-secret paths remain the canonical recovery mechanisms.
>
> All three recovery paths (re-sign, paste, backup file) terminate in the
> same `root_secret` and produce identity-equivalent state. The SDK
> verifies the re-sign path's reproducibility at first enrollment (by
> double-signing and comparing bytes) and on every subsequent sign-in (by
> re-deriving the walletId and comparing against the cached value). A
> mismatch hard-fails with a user-facing error directing the user to use
> the paste-secret or backup-file path.

**Rationale:** the parent spec's blanket "unreliable convenience" framing
predates the consolidation of EOA wallet behaviour around RFC 6979 and
predates the cost-benefit analysis of forced backup export as the *only*
recovery path. The amended axiom preserves the safety net (rootSecret-as-
authority, backup-canonical for non-deterministic signers) while accepting
the UX win for the common case.

### `issuedAt` (removed)

**Original (parent §"Enrollment Flow → Technical Flow" step 2):**

> message.issuedAt: <timestamp>
> ...
> Note: issuedAt MUST use millisecond precision (Unix epoch, milliseconds)
> and the SDK MUST enforce monotonicity (never reuse a previous timestamp).
> This ensures payload uniqueness even if a future wallet implements
> deterministic signing (RFC 6979), where identical payloads produce
> identical signatures.

**Revised (v2):** Field removed. The new `Enrollment` struct is:

```typescript
Enrollment {
  purpose: string,
  version: string,
  account: uint256,
}
```

**Rationale:** the parent spec used `issuedAt` *deliberately* to prevent
reproducible signatures. v2 wants reproducible signatures (see Axiom 1
revision). The replacement field `account: uint256` (default 0) provides
forward-compatible compartmentalization without re-introducing non-
determinism.

### Session Management → Daily Use (revised item 4)

**Original (parent §"Session Management → Daily Use" item 4):**

> 4. Re-signing — unreliable. Because enrollment includes `issuedAt`,
>    re-signing produces a different signature and therefore a different
>    identity. ... UX copy must never frame re-signing as a dependable
>    recovery path.

**Revised (v2):** Item 4 is promoted to item 1 and reframed as the primary
path for compatible wallets:

> 1. **Re-signing with the enrolling EVM wallet** — primary path. The SDK
>    re-runs the enrollment EIP-712 message and derives the same
>    `root_secret` deterministically (RFC 6979). Requires the wallet to
>    produce reproducible signatures; the SDK verifies this at first
>    enrollment and on every sign-in. On mismatch the SDK hard-fails and
>    directs the user to the paste-secret or backup-file path. UX may
>    frame this as a dependable recovery path for compatible wallets, but
>    must surface the existence of the other two paths in Settings.

The previous item 1 ("Pasting recovery secret") and item 2 ("Importing
encrypted backup file") remain available and are renumbered accordingly.
Item 3 ("Encrypted local storage") is unchanged.

### Enrollment Flow → User Experience (revised paragraph)

**Original:**

> One wallet signature, one forced backup, done. The backup is the
> recovery path — not re-signing. The enrollment signature includes a
> timestamp (`issuedAt`) that makes it inherently non-reproducible...

**Revised:**

> One wallet signature, no required backup export, done. For compatible
> wallets, re-signing is the recovery path; the user does not need to
> save any file. For non-deterministic and smart-account wallets, the
> SDK falls back to forced backup export per the original v1 flow.
> Backup export is always available in Settings as a recommended belt-
> and-suspenders option for cross-device portability.

### Enrollment Flow → Backup confirmation round-trip (downgraded)

**Original (parent §"Enrollment Flow" step 7):**

> Minimum confirmation requirement: ... For encrypted file export, the
> SDK MUST require a full round-trip before enrollment completes ...
> Enrollment does not complete until this round-trip succeeds.

**Revised (v2):** The round-trip requirement applies *only when the user
explicitly chooses to export a backup during enrollment*. When the user
relies on the re-sign path (the default), enrollment completes without a
backup round-trip. If the determinism check (see Axiom 1) succeeds at
first sign, the user's identity is recoverable via re-signing and the
forced-backup-round-trip requirement is satisfied by an equivalent
"re-sign verification" round-trip (the SDK signs twice and confirms byte
equality before completing enrollment).

When the user IS exporting a backup (either during enrollment via the
"recommended" link, or later via Settings), the round-trip requirement
from the original spec applies in full.

---

## Unchanged sections (explicit)

The following sections of the parent spec are NOT amended and remain in
full force:

- §"Design Principles → Axiom 2" (One Shielded Identity, Many Rails)
- §"Design Principles → Axiom 3" (Spending Keys Never Leave User Context)
- §"Enrollment Flow → Technical Flow" steps 1, 3, 4, 5 (wallet connect,
  signature normalization, HKDF derivation, anti-phish checksum display)
- §"Enrollment Flow → Backup file format" — `armada-backup-v1` / `v2`
  schema is preserved. Interop contract (parsers must accept argon2id,
  scrypt, pbkdf2-sha256) preserved.
- §"Key Derivation Hierarchy" — HKDF semantics, subkey derivation,
  versioning, bytes-to-field-element mapping
- §"Implementation Constraints" IC-1 through IC-5 in full. IC-5 (Bug-
  Triggered Migration Capability) is specifically preserved by the
  retention of the backup-file and paste-secret paths: `root_secret` is
  still recoverable from disk, so a re-derivation through a corrected
  code path is always possible.
- §"Anti-Phish Checksum" in full
- §"Session Management → Encrypted Local Storage" in full
- §"Integrator Access Model" in full
- §"Key Material Handling → Web Worker Isolation" — addressed by Phase 7a
  of the implementation, NOT amended
- §"Key Material Handling → Clear-After-Use" in full
- §"Security Model" in full (acknowledging phishing as residual risk)

---

## Open spec questions (unchanged status)

The parent spec's §"Implementation Checklist → Spec blockers" remain open:

- Canonical enrollment address (testnet `verifyingContract` is now
  `keccak256('armada-enrollment:testnet:v2')[:20]`; mainnet value still
  TBD)
- Andrew's confirmations on spending key modulus, viewing key
  architecture, byte endianness, zero-scalar acceptance
- IC-4 concrete vectors (blocked on SDK implementation finalization)

This amendment does not resolve them; it does not introduce new ones.

---

## Implementation cross-reference

This amendment accompanies the implementation work tracked in
`.context/shielded-wallet-redesign-plan.md`. The plan's phases map to
amended sections:

- Plan Phase 1 → Axiom 1 revision, `issuedAt` removal, schema fork
- Plan Phase 2 → Lifecycle changes (signIn primary, backup/paste retained)
- Plan Phase 2a → Determinism verification (Axiom 1 revision support)
- Plan Phase 3 → UI changes (Session Management item-4 → item-1 promotion)
- Plan Phase 7a → Web Worker isolation (parent §"Key Material Handling"
  compliance, NOT amended — this just closes the gap)
