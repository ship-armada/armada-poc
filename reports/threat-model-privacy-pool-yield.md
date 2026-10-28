# Threat Model: Privacy Pool & Yield

**Domain:** PrivacyPool (router + Shield/Transact/Merkle/Verifier modules), PrivacyPoolClient, CCTPHookRouter, GaslessShieldWrapper / GaslessShieldWrapperClient, ArmadaYieldAdapter, ArmadaYieldVault, ArmadaFeeModule
**Date:** 2026-10-28, reviewed against `main` at `d2f69747`
**Authorities:** `specs/PRIVACY_POOL_CONTRACT.md` (pool behaviour and consensus-critical surface), `specs/CONTRACT_REWRITE_DEVIATIONS.md` (D-n decisions), `specs/FEE_STRUCTURE.md` (fees)

Off-chain components (relayers, `@armada/sdk`, armada-interface, Circle CCTP, Aave, the circuits and their trusted setup, governance) appear only as trust assumptions (§ Trust Assumptions). The Launch 1 governance and crowdfund contracts are covered by `threat-model-governance-crowdfund.md`.

References name the contract and function, or the revert string, rather than line numbers, so they survive edits.

---

## Architecture Summary

- **PrivacyPool (hub):** non-upgradeable router. Delegatecalls four modules that are assigned once in `initialize()` (deployer-only) and have no setter (module immutability, #79). All state lives in `PrivacyPoolStorage` (append-only layout, `__gap`). `shield`, `transact` and `atomicCrossChainUnshield` are `nonReentrant`. Groth16 verification runs in the router's `verify` (D-17); there is no verification bypass (D-26).
- **ShieldModule:** local `shield` (balance-delta-checked pull) and `processIncomingShield` for CCTP shield-ins. Charges the shield fee through the fee module, or a flat fee when none is wired (D-24).
- **TransactModule:** `transact` (private transfers + local unshield) and `atomicCrossChainUnshield` (nullify, then burn USDC via CCTP to a client chain).
- **MerkleModule:** depth-16 Poseidon incremental Merkle tree with rollover; `rootHistory` keeps every root.
- **VerifierModule:** owner-set verifying keys per (nullifiers, commitments) shape.
- **PrivacyPoolClient (client chains):** no pool. Burns USDC to the hub for cross-chain shields (validating notes first, D-25) and pays out cross-chain unshields.
- **CCTPHookRouter:** atomically calls `receiveMessage` and dispatches the hook; dispatches only messages addressed to the local TokenMessenger (D-22).
- **Gasless wrappers:** permit + EIP-712 intent; anyone may submit.
- **ArmadaYieldAdapter:** `lendAndShield` / `redeemAndShield`; a fee-exempt shield caller through the adapter registry. Outputs are bound to the proof via `YieldAdaptParams`.
- **ArmadaYieldVault:** intentionally non-standard ERC-4626 over an Aave V4 spoke (mocked locally by `MockAaveSpoke`). Shares are ayUSDC. Locks `LOCKED_SHARES` on first deposit (#365). Protocol yield fee measured from lifetime flows with a high-water mark.
- **ArmadaFeeModule:** UUPS proxy. Shield fee = Armada take (base rate, volume tiers, custom terms) + integrator fee; yield fee rate; records USDC fees as revenue.
- **Supplied by governance:** `AdapterRegistry` and `ShieldPauseController` are Launch 1 contracts that are being replaced (#381 §3).

## Roles and Powers

| Role | Holder today | Powers |
|------|--------------|--------|
| Pool / client owner | Deployer EOA on every network, until the governance handover (#381 §3) | Verifying keys; `hookRouter`; remote pools and hook routers; fee module; shield-pause controller; blocklist; flat shield fee (≤10%, only with no fee module); outbound finality; adapter registry (set once); two-step ownership transfer |
| Fee module owner | Deployer locally; Launch 1 timelock on non-local deploys | Rates within caps; `privacyPool` / `yieldVault` pointers; UUPS upgrade |
| Vault / adapter owner | Same as fee module | Vault: local yield fee (1–50%, only with no fee module), fee module pointer. Adapter: `privacyPool` pointer, `rescueTokens` |
| Governance | Launch 1 timelock (being replaced) | Adapter registry contents; shield pause and wind-down |
| Relayers | Anyone | No on-chain privilege: CCTP delivery and gasless submission are permissionless |

---

## Threat Table: Pool Core

| ID | Threat | Description | Mitigation | Test Coverage | Status |
|----|--------|-------------|------------|---------------|--------|
| PC-01 | **Proof verification bypass** | A transaction is accepted without a valid Groth16 proof | `PrivacyPool.verify` always runs `Snark.verify`; no testing mode, no `tx.origin` path; the `testingMode` slot is inert (D-26) | `PrivacyPoolNoVerificationBypass.t.sol`; `SnarkVerifier.t.sol` `test_routerVerifiesRealTransaction` | Mitigated (#633). Soundness still depends on the trusted setup (TA-04) |
| PC-02 | **Test-only bypass deployed** | `contracts/test/PrivacyPoolProofBypass.sol` (owner toggle makes `verify` return true) is deployed instead of `PrivacyPool` | Lives only under `contracts/test/`; `deploy_privacy_pool.ts` deploys `PrivacyPool`; no script, task or relayer references the bypass | None automated. `scripts/verify_snark_mode.ts` can't detect it (#646) | Partially mitigated (review only) |
| PC-03 | **Malformed proof or inputs** | Inputs ≥ field order (nullifier aliasing), off-curve points, wrong IC length, unregistered shape | Every public input `< SNARK_SCALAR_FIELD`; IC length check; G1 curve and base-field checks; precompile failures revert; unregistered shape reverts | `SnarkVerifier.t.sol`: `test_inputAtFieldOrderReverts`, `test_offCurveProofPointReverts`, `test_icLengthMismatchReverts`, `testFuzz_mutatedPublicInputRejected`, `test_routerRevertsForUnregisteredShape` | Mitigated |
| PC-04 | **Bound-params / public-input tampering** | Relayer alters ciphertext, adaptParams, chain ID, unshield type, root, nullifiers or commitments | boundParams hash is public input 1; adaptContract must equal `msg.sender`; chain ID check | `SnarkVerifier.t.sol`: `test_routerRejectsAlteredBoundParams`, `test_routerRejectsAlteredNullifierCommitmentOrRoot`; adversarial "transact with wrong chainID reverts" | Mitigated. The hash exists twice (router and `VerifierModule.hashBoundParams`) with no test pinning them (#645) |
| PC-05 | **Unshield note substitution** | Valid proof paired with another payout preimage, an aliased npk, zero value or non-zero `tokenSubID` | Canonical npk; value > 0; ERC-20 `tokenSubID == 0`; preimage hash must equal the last commitment; payout to the pool itself rejected (D-18/D-21) | hardening: "rejects a local unshield whose npk is not a canonical field element", "rejects a zero-value unshield", "rejects an ERC-20 unshield with a non-zero tokenSubID"; `PrivacyPoolSolvencyInvariant` `invariant_tamperedTransactionsRejected` | Mitigated (#606) |
| PC-06 | **Double spend** | Nullifier reused in a batch, across calls, or across `transact` and `atomicCrossChainUnshield` | `nullifiers[tree][n]` checked and set before any payout; field check blocks aliased nullifiers | adversarial: "same nullifier in single batch reverts", "same nullifier across two transact() calls — second reverts", "nullifier marked after atomicCrossChainUnshield" | Mitigated |
| PC-07 | **Cross-tree nullifier namespace** | Old-tree note proven under a newer `treeNumber` for a fresh nullifier namespace | `treeNumber` is inside the proven boundParams; root must be in `rootHistory[treeNumber]`. A cross-tree root collision would need every leaf re-paid | None (analysis only) | Mitigated by design |
| PC-08 | **Fabricated or stale root** | Proof against a root never on chain | Root must be in `rootHistory`; written only after insertion and at init, never removed. Old roots stay valid by design (spec I-2) | adversarial: "invalid merkle root reverts", "old root remains valid after new insertions" | Mitigated; no root expiry (Accepted) |
| PC-09 | **Tree corruption / rollover desync** | External leaf writes, or rollover events report the wrong position so notes become unspendable | Router `insertLeaves` is self-call only; modules are `onlyDelegatecall`; router position getter mirrors the module's rollover (#372) | `RolloverDesyncPoC.t.sol`; adversarial "insertLeaves rejects external callers"; `PrivacyPoolFullInvariant` | Partially mitigated. The real `MerkleModule.insertLeaves` rollover is untested (#645) |
| PC-10 | **Reentrancy** | Token hook re-enters shield, transact or unshield | Router `nonReentrant`; nullifiers marked before payout. CCTP handlers have no guard but only call trusted USDC, fee module, pause controller and registry | adversarial "Reentrancy Guard (#369)" suite; golden vector `v2-shield-reentrancy-revert` | Mitigated (#369) |
| PC-11 | **Initialize hijack / re-init** | Front-runner initializes with hostile modules or owner | Immutable deployer checked in `initialize`; `!initialized`; zero-address checks (D-18) | adversarial: "initialize rejects a non-deployer (front-run) on PrivacyPool", "double-initialize reverts on PrivacyPool" | Mitigated (#368) |
| PC-12 | **Direct module call / module swap** | Module called directly against its own storage, or re-pointed | `onlyDelegatecall` on every state-changing module function; no module setter; router not behind a proxy | `OnlyDelegatecall.t.sol` (all nine module entry points) | Mitigated (#79) |
| PC-13 | **Storage layout collision** | Router and module layouts drift | Single shared `PrivacyPoolStorage`, append-only rule, `__gap`; modules declare no state | `PrivacyPoolOwnership.t.sol` `test_pendingOwnerDoesNotShiftExistingStorage` (spot checks only) | Partially mitigated (low risk: non-upgradeable, deployed together). Full layout snapshot: #645 |

## Threat Table: Shield Paths

| ID | Threat | Description | Mitigation | Test Coverage | Status |
|----|--------|-------------|------------|---------------|--------|
| SH-01 | **Shield pause bypass** | Shields succeed while paused or after wind-down | `_requireShieldsNotPaused` on `shield` and `processIncomingShield`; wind-down pauses shields permanently. Owner can repoint the pause controller (AD-04). `MAX_PAUSE_DURATION = 0` (#589), so there is no pre-wind-down emergency brake | winddown_redemption_integration "shield reverts after wind-down"; `ShieldPauseController.t.sol` | Partially mitigated (owner trust, #381) |
| SH-02 | **Invalid note** | Zero value or npk ≥ field (aliasing) inserted | `_validateCommitmentPreimage`: value > 0, npk < `SNARK_SCALAR_FIELD`; client validates before burning (D-25) | adversarial: "shield with value=0 reverts", "shield with npk >= SNARK_SCALAR_FIELD reverts"; `PrivacyPoolClientNoteValidation.t.sol` | Mitigated. ERC-20 `tokenSubID` is not checked on shield (Info, #646) |
| SH-03 | **Commitment hash / circuit mismatch** | Leaf hash differs from what the circuit expects | `_hashCommitment` = Poseidon(npk, tokenID, value); ERC-20 only | CI Real-Proof E2E; v2 golden-vector replay | Mitigated |
| SH-04 | **Fee-on-transfer / rebasing tokens** | Pool credits more than it received | Balance-delta check on every pull into the pool. Rebasing tokens pass (each transfer is exact at the time); damage is isolated per token; blocklist is reactive | `PrivacyPoolSolvencyInvariant` `invariant_poolCoversUnspentNotesPerToken` (well-behaved tokens only); no fee-on-transfer mock (#645) | Fee-on-transfer mitigated; rebasing Accepted |
| SH-05 | **Blocklist bypass or abuse** | Shield a blocked token; block USDC to strand shield-ins; trap holders | Blocklist checked on shield; USDC can't be blocklisted; exits never blocked | adversarial: "cannot blocklist USDC (protects the cross-chain shield path)", "still allows unshielding a token after it is blocklisted (exit path)" | Mitigated (owner can still block ayUSDC, halting `lendAndShield`) |
| SH-06 | **Fee-exempt privilege abuse** | Non-adapter shields fee-free | `_isPrivilegedShieldCaller` reads the registry (authorized or withdraw-only); registry pointer set-once (#370) | adversarial "(#370)" cases; golden vectors `v2-shield-privileged-adapter`, `v2-shield-unprivileged-with-registry` | Mitigated |
| SH-07 | **Fee split / conservation error** | Take or integrator fee mis-paid, or note + fee ≠ amount pulled | `ArmadaFeeModule.calculateShieldFee` caps (take ≤ 10%, integrator ≤ 5%); checked subtraction; treasury fixed at init | `FeeAccountingIntegrationInvariant.t.sol`; `ArmadaFeeModule.t.sol` `testFuzz_calculateShieldFee_withIntegrator_totalNeverExceedsAmount`; `HalmosFee` `check_feeConservation` (mirrored flat-fee formula) | Mitigated for the shipped module. The pool doesn't check the module's split (FM-10, #640) |
| SH-08 | **Gasless note / integrator substitution** | Submitter changes npk, inflates fee note, swaps integrator, maxFee or finality | Hub intent signs the full shield array + integrator; client intent signs both notes, maxFee, finality | `gasless/GaslessShieldWrapper.t.sol`: `test_gaslessShield_substitutedUserNpkReverts`, `test_gaslessShield_inflatedFeeNoteReverts`, `test_gaslessShield_substitutedIntegratorReverts`; client: `test_gaslessCrossChainShield_substitutedMaxFeeReverts` | Mitigated (client fee-note and finality substitution untested, #645) |
| SH-09 | **Intent replay** | Replay, use after deadline, or on another chain or wrapper | Sequential per-user nonce consumed before external calls; deadline; EIP-712 domain with chain ID, verifying contract and distinct names | `test_gaslessShield_nonceReplayReverts`, `test_gaslessShield_expiredDeadlineReverts`, `test_gaslessCrossChainShield_nonceReplayReverts` | Mitigated (no nonce cancellation) |
| SH-10 | **Permit front-run griefing** | Someone submits the public permit first so the wrapper's permit call reverts | `try permit … catch { require(allowance >= total) }`; the signed intent authorizes the spend | `test_gaslessShield_frontRunPermitDoesNotBlock`, `test_gaslessShield_permissionlessResubmitSucceeds` | Mitigated. Users can still waste relayer gas; relayers must simulate |
| SH-11 | **Shield-in split error** | Relayer under- or over-paid; CCTP fee charged to the wrong note; credit exceeds the declared amount | Fee notes get full declared value; only index 0 absorbs the CCTP fee; `amount > feeSum` and `amount ≤ Σ declared` | `testFuzz_gaslessCrossChainShield_noDust`; `CrossChainConservationInvariant` `invariant_usdcConservedAcrossChains`; golden vector `v2-shieldin-multi-note` | Mitigated (the adversarial test for the declared-amount check is hollow, #645) |

## Threat Table: Unshield and Cross-Chain

| ID | Threat | Description | Mitigation | Test Coverage | Status |
|----|--------|-------------|------------|---------------|--------|
| XC-01 | **Cross-chain exit redirection** | Relayer resubmits a proof with another recipient, domain or `maxFee` | `adaptParams` must equal `CCTPBindingLib.encode(recipient, domain, maxFee)`; `adaptContract == 0`; adaptParams is proven | `CCTPBindingLib.t.sol` (incl. `testFuzz_verify_rejectsAnyDeviation`); adversarial "#378: rejects an inflated maxFee not bound in the proof" | Mitigated (#364, #378) |
| XC-02 | **Cross-path replay** | Cross-chain proof replayed through `transact` (pool→pool strand) or a local proof through the atomic path | Cross-chain npk pinned to the pool; local payout to the pool rejected; canonical npk; local proofs carry zero adaptParams | hardening "rejects a cross-chain proof replayed through transact() with an aliased pool npk"; solvency-invariant tamper actions | Mitigated (#364, #606) |
| XC-03 | **Non-USDC note burned as USDC** | Pool burns its own USDC for a non-USDC note | Atomic path requires an ERC-20 note with `tokenAddress == usdc` (D-20) | hardening "rejects a cross-chain unshield of a non-USDC note and leaves pool USDC untouched" | Mitigated |
| XC-04 | **`maxFee` eats the payout** | Fee ≥ amount reverts the burn, or the CCTP fee eats the recipient note | Hub: `maxFee < base`; client: `maxFee < amount` and `< userNote.value`; hub requires `amount > feeSum` | adversarial: "maxFee exceeding base amount reverts", "crossChainShieldWithFee with maxFee >= userNote.value reverts" | Mitigated |
| XC-05 | **destinationCaller stranding** | With `destinationCaller = 0`, a third party can `receiveMessage` without the hook firing | Pinned to `remoteHookRouters[domain]`, required non-zero (D-16); client pins `hubHookRouter` | `CrossChainUnshieldHookRouterRequired.t.sol`; client-side check untested (#645) | Mitigated (#64) |
| XC-06 | **Forged burn-shaped message** | Permissionless `sendMessage` delivers a burn-shaped body that minted nothing | Router dispatches only messages addressed to the local TokenMessenger; handlers don't accept the MessageTransmitter (D-22) | hardening: "hub rejects a forged shield message that minted nothing", "client rejects a forged unshield message that minted nothing"; `CrossChainConservationInvariant` `invariant_noReplayOrForgeryAccepted` | Mitigated (#613). The mock TokenMessenger doesn't check the envelope sender |
| XC-07 | **Untrusted source pool or domain** | Burn from another contract or domain reaches the hook | Hub: `messageSender == remotePools[sourceDomain]` (non-zero); client: `remoteDomain == hubDomain`, `messageSender == hubPool` | integration: "hub rejects cross-chain shield from an untrusted source pool", "hub rejects cross-chain shield from an unconfigured source domain", "client rejects cross-chain unshield from an untrusted source pool" | Mitigated (#366). Client domain check untested (#645) |
| XC-08 | **Direct handler call** | Anyone calls `handleReceive*` with a fabricated body | `msg.sender == hookRouter || tokenMessenger` (the TokenMessenger branch is unused) | adversarial "Hub rejects handleReceiveFinalizedMessage from non-TokenMessenger" and client equivalents | Mitigated (but see AD-02) |
| XC-09 | **Message replay** | Same attested message delivered twice | MessageTransmitterV2 used-nonce tracking; router is atomic, so a reverted hook doesn't consume the nonce | `CrossChainConservationInvariant` `invariant_noReplayOrForgeryAccepted` | Mitigated (trusts Circle) |
| XC-10 | **Fast-finality reorg / finality spoofing** | FAST-attested message, then the source reorgs; or too little finality | Unfinalized path needs ≥1000, finalized ≥2000; outbound threshold limited to 1000/2000 | fast_finality suite; adversarial "finality below FAST (1000) rejected on PrivacyPool" | Accepted (Circle Fast Transfer bears reorg risk) |
| XC-11 | **Undeliverable cross-chain shield** | Client burns USDC but every hub delivery attempt reverts | Client validates notes and fee bounds before burning (D-25). Open triggers: wind-down pause, owner reconfiguration in flight, a blacklisted integrator or treasury, a reverting fee module | `PrivacyPoolClientNoteValidation.t.sol`; `CrossChainConservationInvariant` `invariant_everyAcceptedShieldIsDelivered` (no pause in the harness) | **Open (#607)** |
| XC-12 | **Undeliverable cross-chain unshield** | Hub burns and nullifies, but every client delivery attempt reverts: blacklisted recipient, client config changed in flight, mismatched hook routers | Recipient ≠ 0; hub requires a hook router. No refund path | None (mock USDC has no blacklist) | **Open (#607, widened)** |
| XC-13 | **Withdraw-only bypass** | After wind-down, a transfer plus a 1-wei unshield still moves value privately; the atomic path never checks withdraw-only | `_requireNotWithdrawOnly` rejects only pure transfers | `TransactModuleWindDown.t.sol` (documents the bypass) | **Open (#620)**; the fix must cover the atomic path |
| XC-14 | **Exits blocked by pause** | Pause stops users exiting | Only `emergencyPaused()` blocks exits, and it is never true with `MAX_PAUSE_DURATION = 0`; client has no pause | `TransactModuleWindDown.t.sol` `test_scPause_doesNotBlockTransfers` | Mitigated (Launch 1 parameters; owner can still repoint the controller, AD-04) |
| XC-15 | **Out-of-order delivery** | CCTP delivers in arbitrary order | Messages are independent; all historical roots valid; position computed at delivery | `CrossChainConservationInvariant` `test_handlerActionsAreLive` (out-of-order relay) | Mitigated |
| XC-16 | **Relayer censorship** | One relayer refuses to deliver | `relayWithHook` and gasless resubmission are permissionless | `test_gaslessCrossChainShield_permissionlessResubmitSucceeds` | Mitigated on-chain |
| XC-17 | **`uniqueNonce` tampering** | Front-runner changes `uniqueNonce` on an atomic unshield | Not bound; only echoed into hook data. Funds still reach the bound recipient | None | Accepted (wallet delivery matching only, #287) |

## Threat Table: Yield

| ID | Threat | Description | Mitigation | Test Coverage | Status |
|----|--------|-------------|------------|---------------|--------|
| YD-01 | **Re-shield destination substitution** | Submitter changes the re-shielded npk or ciphertext | Proof binds `adaptContract`; adapter checks `adaptContract == this` and `YieldAdaptParams.verify`; lend and redeem encodings differ | shielded_yield_integration: "reverts when adaptContract is wrong", "reverts when adaptParams mismatch (wrong npk)"; `YieldAdaptParamsFee.t.sol` | Mitigated |
| YD-02 | **Relayer fee tampering on redeem** | Fee redirected or inflated | Fee npk, ciphertext and amount bound in adaptParams; fee ≤ proceeds; no fee without a destination | `YieldAdaptParamsFee.t.sol` `testFuzz_verify_rejectsAnyFeeDeviation`; shielded_yield_integration fee cases | Mitigated (#312) |
| YD-03 | **Unshield that doesn't pay the adapter** | NONE / REDIRECT / wrong-recipient unshield makes the adapter act on stray balance | Adapter requires a NORMAL unshield to itself, the expected token, and the received balance equal to the claimed amount | shielded_yield_integration: "rejects a lend whose unshield type is not NORMAL", "rejects a lend that does not unshield to the adapter" | Mitigated (some reverts untested, #645) |
| YD-04 | **Proof hijack** | Third party calls `pool.transact` directly with an adapter-bound proof, unshielding with no re-shield | Pool rejects `adaptContract != msg.sender` ("Invalid Adapt Contract") | None (#645) | Mitigated in code, untested |
| YD-05 | **Adapter privilege abuse** | Fee-exempt shield misused, or funds stuck in the adapter | Exemption only for registry-listed adapters; adapter shields only what it just received; owner-only `rescueTokens` | adversarial "(#370)" cases; solvency invariant ayUSDC leg | Mitigated |
| YD-06 | **First-depositor inflation** | Attacker donates to round later deposits down | First deposit locks `LOCKED_SHARES = 1e6` at `0x…dEaD`; a first deposit ≤ 1e6 reverts | `YieldInflationDefense.t.sol` | Mitigated (#365) |
| YD-07 | **Rounding extraction** | Deposit/redeem cycles extract value | Shares and assets round in the vault's favour; zero-share deposits revert | `YieldFullInvariant` `testFuzz_noFreeProfit`; `YieldInvariant` `invariant_noShareInflation` | Mitigated |
| YD-08 | **Fee accounting when shares move** | Fee depends on who deposited or redeems | Fee from lifetime totals with a high-water mark; no per-holder cost basis | `YieldFeeAccountingInvariant` `invariant_protocolFeeMatchesYieldWhenSharesMove`, `test_feeCorrectAfterRedemptionByNonDepositor` | Mitigated (#609, #618) |
| YD-09 | **Retroactive fee-rate change** | New rate applied to unsettled past yield | Vault setters checkpoint first. A fee-module rate change can't checkpoint the vault and applies back to the last settle (documented) | `YieldFeeAccountingInvariant` `test_feeRateChangeIsNotRetroactive` (vault setter only) | Accepted by design |
| YD-10 | **Donations** | Anyone supplies to the spoke on the vault's behalf | Treated as yield (fee taken, rest to holders); unprofitable with YD-06 | `YieldInflationDefense` (via donation) | Accepted |
| YD-11 | **Aave loss or illiquidity** | Spoke can't pay out or loses principal | Redeem is atomic; losses shared pro-rata; high-water mark prevents re-charging fee on recovery. No minimum-out | `YieldFeeAccountingInvariant` `test_noFeeOnRecoveringALoss` (mocked view); no illiquidity test | Accepted; min-out is #600 |
| YD-12 | **Broken fee module (vault side)** | Reverting module blocks deposit, redeem, harvest and its own detach; returned rate not clamped | None in the vault | None | **Open (#643)** |
| YD-13 | **Vault migration** | Redeploying the vault strands old positions; repointing the fee module bricks old-vault redeems | Decision on #77: withdraw-only old adapter; the same proposal must detach the old vault's fee module | None | Procedure (#77 correction) |
| YD-14 | **Wind-down** | Shield pause blocks the private exit | `lendAndShield` / `redeemAndShield` revert atomically at the re-shield, so nothing strands; the public exit (unshield ayUSDC, `vault.redeem`) stays open | None for the adapter under pause | Accepted (#607, #620) |
| YD-15 | **Adapter lifecycle** | Deauthorization closes the private exit | Lend needs full authorization; redeem accepts withdraw-only; full deauthorization closes the private exit (public exit remains) | `AdapterRegistryEnforcement.t.sol` | Mitigated (relies on procedure) |
| YD-16 | **Linkable amounts** | Lend and redeem amounts and events are public | Inherent to an on-chain vault | None | Accepted |

## Threat Table: Fee Module

| ID | Threat | Description | Mitigation | Test Coverage | Status |
|----|--------|-------------|------------|---------------|--------|
| FM-01 | **Abusive rates** | Owner retunes take, tiers, custom terms, yield fee, harvest interval | Hard caps: take ≤ 10%, integrator ≤ 5%, yield 1–50%, harvest 1h–365d, ≤ 10 tiers. No delay; tiers aren't forced below the base rate | `ArmadaFeeModule.t.sol` bound and `onlyOwner` tests; `setHarvestInterval` bounds untested (#645) | Bounded; owner TBD (#381) |
| FM-02 | **Unauthorized recording** | Third party calls `recordShieldFee` / `recordYieldFee` | `msg.sender == privacyPool` / `== yieldVault` | `test_recordShieldFee_onlyPrivacyPool`, `test_recordYieldFee_onlyYieldVault` | Mitigated |
| FM-03 | **Owner-forged revenue** | Owner points `privacyPool` / `yieldVault` at itself and records arbitrary fees | Owner-only setters | Positive cases only | Accepted (owner trust) |
| FM-04 | **Integrator fee raised before a shield lands** | `setIntegratorFee` is permissionless and immediate; users can't cap it | Cap only (≤ 5%) | `test_setIntegratorFee_permissionless` | **Open (#642)** |
| FM-05 | **Custom-terms piggyback** | Anyone naming an integrator gets its custom terms; for registered integrators the discount goes to the integrator as bonus | Referral model by design | `test_calculateShieldFee_withCustomTerms` | Accepted (spec wording, #646) |
| FM-06 | **Tier gaming / wash volume** | Lifetime volume bought by cycling funds | Every dollar of volume pays the take to the treasury (~$1.25k to reach $250k); USDC only (#605) | `test_recordShieldFee_nonUsdc_doesNotAdvanceTier`; `invariant_integratorVolumeMatchesUsdcShielded` | Accepted (economically bounded) |
| FM-07 | **Rounding** | Floors produce dust or overcharge | `take + integratorFee ≤ amount`; floors favour the user | `testFuzz_calculateShieldFee_totalNeverExceedsAmount`; `invariant_feeCounterMatchesTreasuryUsdc` | Mitigated |
| FM-08 | **Revenue inflation** | Non-USDC fees counted; vault donations counted as yield fee | USDC-only recording; each recorded unit is real USDC to the treasury (revenue can be bought at ≥ par, not forged) | `test_recordShieldFee_nonUsdc_notCountedAsRevenue`; fee_module_integration "charges the fee in the shielded token but records nothing" | Mitigated (#605); donations Accepted |
| FM-09 | **Reverting fee module (pool side)** | Broken module blocks all fee-paying shields | `setFeeModule(0)` makes no call into the module; flat fee settable again (D-24) | `PrivacyPoolShieldFeeGuard.t.sol`; v1 golden vectors `revert-fee-module-reverting`, `revert-fee-module-malformed-overflow` (not replayed in CI) | Mitigated (#155) |
| FM-10 | **Inconsistent fee split drains the pool** | Pool reduces the note by `totalFee` but pays `armadaTake` and `integratorFee` separately from its own balance, unchecked | None | None | **Open (#640)** |
| FM-11 | **Upgrade hygiene** | No `_disableInitializers`, no `__gap`, #635 layout change unsafe for in-place upgrade; no layout check | `upgradeTo` is `onlyProxy`; every deploy is fresh | `test_initialize_cannotReinitialize` | **Open (#644)** |
| FM-12 | **Dead `treasury` state** | `ArmadaFeeModule.treasury` is never read; the pool pays its own immutable treasury | — | — | Info (#170) |

## Threat Table: Admin and Owner Powers

None of these setters has a timelock. Each is safe only while the owner is trustworthy; who holds them after launch is #381 §3.

| ID | Power | Worst case | Mitigation | Test Coverage | Status |
|----|-------|------------|------------|---------------|--------|
| AD-01 | `setVerificationKey` | Key that accepts forged proofs, or a mint-from-nothing shape | Owner-only; `VerifyingKeySet` event | adversarial "non-owner cannot call setVerificationKey"; `SnarkVerifier.t.sol` `test_proofRejectedUnderAlteredKey` | Open (#381) |
| AD-02 | `setHookRouter` | Owner points it at an EOA, calls `handleReceive*` with a fabricated body, mints unbacked notes and drains the pool. No event | Owner-only | None for non-owner | **Open (#641)** |
| AD-03 | `setRemotePool` / `setRemoteHookRouter` | Redirect cross-chain exits submitted after the change (binding excludes mint recipient and destination caller) | Owner-only; events | adversarial "non-owner cannot call setRemotePool" | **Open (#641)** |
| AD-04 | `setShieldPauseContract` | Controller that freezes all exits, or one that lifts the wind-down shield pause | Owner-only | None for non-owner | Open (#381) |
| AD-05 | `setFeeModule` | Module that overcharges, reverts, or drains (FM-10) | Owner-only; flat fee capped at 10% and blocked while a module is wired | `PrivacyPoolShieldFeeGuard.t.sol` | Open (#640, #381) |
| AD-06 | `setAdapterRegistry` | Grant fee-exempt shields to an arbitrary caller | Set-once, non-zero (#370) | adversarial "setAdapterRegistry is set-once — a second owner call reverts" | Mitigated |
| AD-07 | `setDefaultFinalityThreshold` | Arbitrary outbound finality | Only 1000 or 2000 | adversarial invalid-threshold cases | Mitigated |
| AD-08 | Ownership transfer | Typo loses admin; hijack | Two-step `transferOwnership` / `acceptOwnership`; no renounce (D-23). Vault, adapter and fee module are still one-step | `PrivacyPoolOwnership.t.sol` | Mechanism mitigated (#349); custody Open (#381) |
| AD-09 | Deploy-time owners | Pool stays with the deployer EOA; on non-local networks fee module, vault and adapter go to the abandoned Launch 1 timelock | `TODO(#381 §3)` in `deploy_privacy_pool.ts` | — | Open (#381 §3) |

---

## Trust Assumptions

| ID | Dependency | Trusted for | If it fails or misbehaves | Containment | Status |
|----|-----------|-------------|---------------------------|-------------|--------|
| TA-01 | **Circle CCTP V2** (TokenMessenger, MessageTransmitter) | Burn/mint accounting, nonce replay protection, `feeExecuted ≤ maxFee`, intact hook data | Forged mint credits notes; a Circle pause strands in-flight burns; addresses are fixed at init, so a Circle migration means redeploying | Source-pool auth (XC-07); burn-only dispatch (XC-06); pinned destination caller (XC-05); proof-bound tuple (XC-01) | Accepted. Local tests use `MockCCTPV2`, which doesn't check the envelope sender, allows a single relayer, has no USDC blacklist and never expires messages |
| TA-02 | **Iris attestation + Fast Transfer** | Attesting only real burns; liveness; reorg cover for FAST | Downtime delays transfers; malicious attesters mean arbitrary mint | None beyond CCTP | Accepted |
| TA-03 | **Aave V4 spoke** | Supplied-asset accounting; withdraw liquidity | Bad debt is shared by vault holders; illiquidity freezes redeem and harvest (pool unaffected) | Spoke immutable per vault; high-water mark; `LOCKED_SHARES` | Accepted. Only `MockAaveSpoke` is tested; no fork test against real V4 |
| TA-04 | **Circuits + trusted setup** | Circuit soundness; toxic waste destroyed | Anyone with the toxic waste forges proofs and drains the pool | Artifacts SHA-pinned (`scripts/fetch-circuits.sh`) | **Open, mainnet blocker (#406)**: dev ptau |
| TA-05 | **Relayers** (POC `relayer/`, production ship-armada/armada-relayer v2) | Liveness, honest fee quotes, not logging | Can censor, delay, see the submitter's IP, choose timing, alter the unbound `uniqueNonce`. Can't change recipients, amounts or fee notes | Permissionless delivery and resubmission; v2 allowlists and fee verification | Accepted |
| TA-06 | **`@armada/sdk`** | Byte-exact note, npk and ciphertext derivation; bound-params hash; adaptParams encoders | Hash mismatch fails closed; a wrong npk or ciphertext makes notes unspendable (permanent loss) | Golden vectors shared with the contracts; SDK prove-and-verify tests | Accepted |
| TA-07 | **armada-interface** | Building correct requests; showing correct fees; not leaking keys | Mis-built notes are unspendable; misleading fee display | Contract-side validation (SH-02, D-25); proof binding | Accepted. Delivery status relies on a POC-only endpoint (armada-interface#122) |
| TA-08 | **Governance (new system TBD)** | Holding the AD-* powers; adapter registry; shield pause and wind-down | Every AD-* worst case | Set-once registry; immutable modules; two-step pool ownership | **Open (#381 §3)** |
| TA-09 | **USDC issuer** (blacklist / pause) | Not freezing the pool, client, treasury, vault or recipients | Pool blacklisted: all USDC flows revert. Treasury blacklisted: fee-paying shields and vault settles revert. Integrator or unshield recipient blacklisted: those cross-chain messages become undeliverable | Treasury case recoverable by detaching the fee module with a 0 flat fee; others not | Accepted; undeliverable cases in #607 |

---

## Coverage Matrix

| Component | Unit | Integration | Fuzz / Invariant | Formal | Golden vectors |
|-----------|------|-------------|------------------|--------|----------------|
| Router + Snark verification | ✓ | ✓ (real proofs, CI E2E) | ✓ | — | ✓ |
| ShieldModule | ✓ | ✓ | ✓ (solvency, fee accounting) | Halmos (mirrored flat-fee formula) | ✓ |
| TransactModule | ✓ | ✓ | ✓ (solvency, tamper actions) | — | ✓ |
| MerkleModule | ✓ (getter only for rollover) | ✓ | Re-implementation only | — | ✓ |
| VerifierModule | ✓ | ✓ | — | — | ✓ |
| PrivacyPoolClient + CCTPHookRouter | ✓ | ✓ | ✓ (cross-chain conservation) | — | — |
| Gasless wrappers | ✓ (against mocks) | ✓ (real pool) | ✓ | — | — |
| ArmadaYieldAdapter | ✓ | ✓ | ✓ (solvency yield leg) | — | — |
| ArmadaYieldVault | ✓ | ✓ | ✓ (fee accounting, no-free-profit) | — | — |
| ArmadaFeeModule | ✓ | ✓ | ✓ | — | — |

---

## Gaps and Recommendations

1. **Trusted setup (#406).** Mainnet blocker: the verifying keys come from the dev ptau.
2. **Owner key custody (#381 §3).** Every AD-* power sits with the deployer EOA (pool) or the abandoned Launch 1 timelock (fee module, vault, adapter on non-local deploys). Several are custody-level: `setHookRouter` can mint unbacked notes, `setFeeModule` can drain through an inconsistent split, `setShieldPauseContract` can freeze exits. Hardening is in #640 and #641; the handover design is #381 §3.
3. **Undeliverable cross-chain messages (#607).** Shields after wind-down, unshields to a blacklisted recipient, and owner reconfiguration in flight all strand funds with no refund path.
4. **Withdraw-only bypass (#620).** The fix must also cover `atomicCrossChainUnshield`.
5. **Fee module trust (#640, #643, #644).** The pool doesn't validate the module's split; the vault can't detach a broken module or clamp its rate; upgrade hygiene is missing.
6. **Integrator fee cap (#642).** Users can't bound the integrator fee they pay.
7. **Yield minimum-out (#600).** Low priority; bundle with the next coordinated SDK/adapter release.
8. **Mock fidelity.** `MockCCTPV2` (envelope sender, single relayer, no blacklist, no expiry) and `MockAaveSpoke` (mints shortfalls; can't model loss or illiquidity) limit what the tests show. A fork test against real CCTP V2 and Aave V4 would close most of TA-01 and TA-03.
9. **Test gaps (#645).** Two hollow adversarial tests, two invariants that can't fail, and several untested checks, including "Invalid Adapt Contract" (YD-04) and the real Merkle rollover.
10. **Spec and script drift (#646).** Including `scripts/verify_snark_mode.ts`, which gives false assurance after #633.
11. **ayUSDC handling.** ayUSDC is a transferable ERC-20 and can be unshielded to a public address and redeemed directly; that exit is public and linkable (YD-16). ayUSDC sent to the pool, the vault or any contract without a rescue function is unrecoverable. Shielding ayUSDC as a normal user pays the shield fee in ayUSDC, which isn't recorded as revenue.
12. **Private redeem during wind-down.** `redeemAndShield` reverts once shields are paused, so after wind-down only the public exit remains (YD-14). Relevant to the #607 / #620 designs.
13. **No vault seed deposit at deploy.** `deploy_yield.ts` doesn't seed the vault, so the first real lender funds the 1 USDC lock, and a first lend of ≤ 1 USDC reverts.
14. **Accepted by design:** old roots never expire (PC-08); rebasing tokens are accepted with per-token isolation (SH-04); tier volume can be bought (FM-06); donations count as yield (YD-10); `uniqueNonce` is unbound (XC-17).
