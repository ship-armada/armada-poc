# Contract Golden-Vector Capture Harness

Phase 1 of the clean-room contract rewrite plan (`specs/PRIVACY_POOL_CONTRACT.md`).
Captures golden behavioral vectors for the deployed privacy pool system so the
Phase 2 rewrite can prove behavioral equivalence by replaying identical calldata
old-vs-new and comparing events / state / reverts / gas.

Output corpus: `test-foundry/fixtures/contract-vectors/` (one JSON per vector +
`manifest.json`).

## Boot (fresh local fixturenet — hub chain only, mock CCTP)

**Time pinning matters for replay.** The corpus is time-dependent: the
gasless-wrapper vector carries an EIP-2612 permit whose deadline is capture
block.timestamp + 1h. Anvil boots with the wall clock and refuses to warp
backwards, so a fixturenet booted >1h after the corpus was generated will fail
`shield-gasless-wrapper` ("ERC20Permit: expired deadline") and cascade state
divergence into every later vector. Boot Anvil with its genesis clock pinned
to the corpus era (replay-check fails fast with this exact command if you
forget):

```bash
anvil --port 8545 --chain-id 31337 --block-time 1 --accounts 200 \
  --timestamp $(node -p "Math.floor(Date.parse(require('./test-foundry/fixtures/contract-vectors/manifest.json').generatedAt)/1000)")
```

(For capture itself, an unpinned clock is fine — `npm run chains` works.)

Terminal 2:

```bash
cd armada-poc
source config/local.env
npm run compile
npm run deploy:cctp:hub
npm run deploy:aave:hub        # required by deploy:yield
npm run deploy:governance      # provides pool treasury + ShieldPauseController
npm run deploy:privacy-pool:hub
npm run deploy:gasless-wrapper:hub
npm run deploy:yield:hub       # required by deploy:fee-module
npm run deploy:fee-module      # wires ArmadaFeeModule into the pool
```

Sepolia is never touched: all commands run against `localhost:8545`
(`DEPLOY_ENV=local`, `CCTP_MODE=mock`). Client chains are not deployed;
cross-chain shield-in messages are fabricated off-chain byte-for-byte per
`contracts/cctp/ICCTPV2.sol` (same bytes a client-chain `MessageSent` event
would carry) and injected through the hub's real `CCTPHookRouter` →
`MockMessageTransmitterV2` → `PrivacyPool` handler path.

## Capture

```bash
source config/local.env
npx hardhat run scripts/contract-vectors/capture.ts --network hub
```

Writes 71 vectors + `manifest.json`. The capture is deterministic given a fresh
fixturenet (all pseudo-random field elements derive from
`keccak256("armada-vector:" + seed)`; a fresh Anvil + the fixed deploy sequence
yields identical contract addresses), so re-running reproduces identical
calldata, events and state transitions.

## Replay-check (Phase 2c differential-harness skeleton)

Single-deployment assertion mode — re-sends each vector's calldata and compares
recorded vs actual status / events / post-state reads:

```bash
# Full replay against a FRESH fixturenet (boot as above, do NOT run capture).
# NOTE: Hardhat v2 rejects `--flag` passthrough (HH305) — use the env vars:
REPLAY_ALL=1 REPLAY_GENESIS=1 npx hardhat run scripts/contract-vectors/replay-check.ts --network hub

# Single vector (deployment must already be at that vector's pre-state):
REPLAY_IDS=transact-2x2 npx hardhat run scripts/contract-vectors/replay-check.ts --network hub
```

`--genesis` replicates the capture-time setup exactly (deploys the two capture
mocks, mints USDC, sets approvals) and asserts the mocks land at the manifest's
recorded addresses. Phase 2c extends this into old-vs-new replay with
address-book substitution (see TODOs in `replay-check.ts`).

## Proof policy (decision: testingMode bypass)

The capture enables the pool's `testingMode` proof bypass early
(`admin-set-testing-mode-true`, itself a vector). Per spec §5.6 step 1 the
router's `verify()` then returns `true` without reading the proof, so:

- the **full 19-shape transact matrix** is captured with zero-valued dummy
  proofs — no circuit artifacts or proving time required;
- every transact/unshield vector is marked `proofsBypassed: true` in its JSON
  and in the manifest;
- shield / admin / shield-in / pause / edge vectors need no proofs at all.

Real-proof captures for circuit differential testing already exist separately
under `scripts/capture/` and are unaffected. `admin-set-testing-mode-false`
(final vector) restores production-like verification in the end state.

## Vector file format

Each `<id>.json` records:

| field | content |
|---|---|
| `tx.calldata` | full calldata hex (+ `decodedCall` with named args) |
| `setup` / `setupTxs` | human-readable prerequisites + executable setup txs (mock flag flips) |
| `requiresImpersonation` | address-book label when the sender has no key (HOOK_ROUTER handler calls) |
| `preState` / `postState` | spec §12 invariant reads: `treeNumber`, `nextLeafIndex`, `merkleRoot`, `lastEventBlock`, `rootHistory[...]`, `nullifiers[...]`, USDC balances of pool/users/treasury/relayer/wrapper, admin config slots |
| `result.events` | ordered logs: address, topics, data, logIndex + decoded name/args |
| `result.returnData` / `result.revert` | return data hex, or exact revert reason string / Panic code + raw data |
| `result.gasUsed` | gas of the mined (possibly reverted) tx |

`manifest.json` indexes all vectors in a valid execution order with per-vector
`dependsOn`, the `addressBook` (label → address), boot commands and proof
policy. Replay across deployments must substitute addresses by label via
`decodedCall.args` (raw-calldata replay only works within one deployment, or
across deterministic fresh fixturenets).

## Capture-only helper contracts (NOT part of the system under test)

Compiled at capture time with the repo's bundled solc from inline sources
(`lib/mock-contracts.ts`) — no files added to `contracts/`:

- `MockShieldPauseController` — permissionless flags for
  `shieldsPaused/withdrawOnlyMode/emergencyPaused`. The real
  `ShieldPauseController` is security-council gated and the council is
  unset on a bare fixturenet.
- `MockConfigurableFeeModule` — mode 0 zero-fee, mode 1 `totalFee = amount+1`
  (checked-subtraction panic path), mode 2 reverting `calculateShieldFee`
  (verbatim revert-bubbling path).

## Uncovered

- **Merkle rollover (treeNumber > 0, I-3 / OQ-1):** needs >65,536 leaf
  insertions. Cheapest possible route is ~66+ max-size batch `insertLeaves`
  transactions (~1B+ cumulative gas) of pure filler — judged not cheap for the
  golden corpus. The rollover code path itself is covered indirectly by
  Foundry invariant/fuzz tests (`test-foundry/MerkleFuzz.t.sol`,
  `PrivacyPoolInvariant.t.sol`). Recommendation for Phase 2: a dedicated
  bulk-fill differential script that asserts roots/event labeling at the
  rollover boundary, separate from the golden corpus.
- **Real SNARK verification:** bypassed by policy (see above). The VK-set
  revert path for unregistered shapes with testingMode OFF is also uncovered
  for the same reason; `scripts/verify_snark_mode.ts` + `scripts/capture/`
  e2e runs cover real verification today.

## Notes / observed behavior (all consistent with the spec)

- `setTestingMode` emits `TestingModeSet` **twice** per call (OQ-8) — see
  `admin-set-testing-mode-true.json`.
- The hub deploy scripts do NOT call `setHookRouter` or configure the mock
  transmitter's relayer; the capture records both as vectors
  (`admin-set-hook-router`, `cctp-set-mock-relayer`).
- Cross-chain shield-in pays shield fees out of the pool's own USDC balance
  (spec §7.2 note) — visible in `shieldin-*.json` (pool delta < minted amount).
- `atomicCrossChainUnshield` returns `nonce = 0` (returnData captured) and the
  mock emits two `Approval`/`Transfer` pairs (approve + pull-and-burn).
- Malformed fee module (`totalFee > amount`) surfaces as `Panic(0x11)`
  bubbled verbatim; a reverting fee module bubbles its reason string verbatim
  (spec §5.7).
