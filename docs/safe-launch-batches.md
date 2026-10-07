# Launch-team and security-council actions from a Safe

On mainnet the launch team and the security council are 2-of-3 Safes. The crowdfund admin app
signs with a browser wallet, so it cannot act for them. Instead, Hardhat tasks write files
for the Safe app's **Transaction Builder**:

- `cf-safe-batch`: seeds and launch-team invites, from a CSV
- `cf-safe-cancel`: the security council's emergency `cancel()`
- `gate-safe-approve`: the launch team's approval (or revocation) of a governance proposal that
  upgrades a contract or authorizes an ARM delegator — see §Launch Team upgrade approvals

Each file is **one Safe transaction**. A file with several calls is executed by the Safe as one
bundle (MultiSend): all calls succeed or none do, for one signing round and one gas payment.

## Before you run it

- **No keys needed.** The tasks only read the chain and write files; all signing happens in the
  Safe app. You do not need `DEPLOYER_PRIVATE_KEY`, a Ledger, or `source config/mainnet.env`.
- **A repo checkout** with dependencies installed (`npm install --legacy-peer-deps`). Run the
  commands from the repo root.
- **RPC:** `export HUB_RPC=<private mainnet RPC>` is recommended. Without it, `mainnetHub` uses a
  public fallback endpoint; the tasks only make a few reads, but public endpoints can be down or
  refuse connections. If you see a connection or SSL error, set `HUB_RPC`.
- **Crowdfund address:** read from `deployments/crowdfund-hub-mainnet.json`, which exists once
  the launch deploy has run. Before that (or for another deploy), pass `--crowdfund 0x…`.
- `npx hardhat help cf-safe-batch` lists every option.

## The CSV

```
address,hop,label
0xAbc…,0,Alice        ← seed (hop 0)
0xDef…,1,Bob          ← launch-team invite to hop 1
0x123…,2,Carol        ← launch-team invite to hop 2
```

- `hop` is the **target** hop. The task converts it to the contract's `fromHop` (hop − 1).
- `label` is for your records. It goes into the local `summary.md` only, never into the batch files.
- Blank lines are ignored. Labels may contain commas.

## Running it

```bash
npx hardhat cf-safe-batch --file launch.csv --network mainnetHub          # write batches
npx hardhat cf-safe-batch --file launch.csv --network mainnetHub --check  # validate only
npx hardhat cf-safe-cancel --network mainnetHub                           # cancel() file
```

The crowdfund address comes from `deployments/crowdfund-hub-mainnet.json` (or pass `--crowdfund`).
Other options: `--allow-stack`, `--max-seeds` (default 100 per batch), `--max-invites` (default
60 per batch), `--out` (default `safe-batches/`).

Before writing anything, the task checks every row against the live contract:

- the sale is active, ARM is loaded, and the launch-team window has not closed;
- seeds left (180 cap), launch-team budget left (100 hop-1, 120 hop-2);
- no seed repeated or already added; the launch-team address is not a row;
- invites stay within each address's invites-received cap (10 at hop 1, 20 at hop 2).

Any problem stops the run and no files are written. Before the sale opens it only **warns**,
so batches can be prepared and signed ahead of time.

**Stacking.** Inviting an address that is already invited at that hop (on chain, or earlier in
the same file) does not fail: it raises that person's commitment cap and invite budget. The
task refuses this unless you pass `--allow-stack`, and marks those rows `stacked` in the summary.

## Output

`safe-batches/<time>-launch/` (gitignored):

- `batch-1-of-N-seeds.json`, …: seed batches first, then invite batches, one kind per batch
- `summary.md`: budgets before and after, warnings, and every call in every batch, including the
  `fromHop` value the Safe app will display

## Executing in the Safe app

For each batch file, **in order**:

1. Owner 1: Safe app → **Apps → Transaction Builder** → drag in the file. Check every call
   against `summary.md` → **Create batch** → **Simulate** → **Send batch** and sign.
2. Owner 2: **Transactions → Queue** → open the transaction, check the calls against
   `summary.md` → **Confirm** → **Execute** (pays the gas).

Rules:

- **Execute every batch before running the task again.** Its checks read the contract, which
  cannot see batches still waiting in the Safe queue.
- The Safe queue executes strictly in order (by Safe nonce). Propose batches in file order.
- A proposed Safe transaction is stored on Safe's public transaction service, so its
  addresses are visible before execution.

## Emergency cancel

`cf-safe-cancel` writes `cancel.json` for the security-council Safe. Prepare and check it
before the sale opens, then execute it only on a recorded emergency decision
(`specs/OPERATIONS.md` §7, Cancel Procedure). `cancel()` is immediate and irreversible.

## Launch Team upgrade approvals

A governance proposal that upgrades a contract (`upgradeTo` / `upgradeToAndCall` on any target)
or authorizes an ARM delegator (`addAuthorizedDelegator`) cannot execute until the Launch Team
Safe approves that exact proposal on the `UpgradeGate` (specs/GOVERNANCE.md §Launch Team upgrade
gate). The approval covers one proposal id and its exact actions; it never carries over to another
proposal, even one with identical calls.

```bash
npx hardhat gate-safe-approve --proposal <id> --network mainnetHub            # approve.json + summary.md
npx hardhat gate-safe-approve --proposal <id> --revoke --network mainnetHub   # revoke.json + summary.md
```

The task reads the proposal from the governor (address from the governance manifest, or
`--governor`), refuses proposals with no gated action, terminal proposals (Defeated, Executed,
Canceled), repeat approvals and revokes of unapproved proposals, and prints `WARNING:` lines for
automated findings — a new governor implementation that trusts a different gate, an implementation
or delegator address with no code. Output goes to `safe-batches/<time>-gate-approve/` (gitignored).

Review before approving — every gated action, plus the ungated actions in the same proposal:

- [ ] **Upgrades:** implementation source verified on the block explorer and matching the reviewed
      commit; storage layout extends the current one without reordering.
- [ ] **Governor upgrades:** the new implementation's `upgradeGate()` is this gate (the task checks
      this); the wind-down contract can still call `setWindDownActive`.
- [ ] **RevenueCounter upgrades:** `freeze()` and `recognizedRevenueUsd()` behave as before, so the
      wind-down exit keeps working.
- [ ] **`upgradeToAndCall`:** the attached call matches the proposal description.
- [ ] **`addAuthorizedDelegator`:** the address runs canonical RevenueLock code (runtime bytecode
      matches a build of the audited source, ignoring constructor immutables).
- [ ] No unresolved `WARNING:` findings.

Review during the voting period and execution delay; approve before the execution time. The team
can revoke an approval at any time until the proposal executes. Rotating the Launch Team address on
the gate is two-step: the current team calls `transferLaunchTeam(new)`, then the new Safe calls
`acceptLaunchTeam()`.

`npx hardhat execute-proposal --proposal <id>` (local tooling) explains when a proposal is still
waiting for Launch Team approval instead of sending a transaction that would revert.

## Sepolia rehearsal

Rehearse with a Sepolia crowdfund whose launch team and security council are 2-of-3 Safes
(the default Sepolia roles are single keys, which the tasks refuse):

- [ ] `cf-safe-batch --check` before the open time warns but passes.
- [ ] Import a seed batch and an invite batch into the Transaction Builder: no checksum warning,
      and the decoded calls match `summary.md` (including `fromHop`).
- [ ] Owner 2 confirms and executes; the seeds and invites appear on chain.
- [ ] Re-running the same CSV refuses (already added) and writes nothing.
- [ ] `cf-safe-cancel` imports and simulates cleanly (execute only on a throwaway deploy).
- [ ] `gate-safe-approve` for a governor-upgrade proposal (needs `HARDEN_TIMELOCK=true`, so the
      deployer cannot bypass the gate): the file imports without a checksum warning, the decoded
      `approve` call matches `summary.md`, and the proposal executes only after the Safe executes it.
