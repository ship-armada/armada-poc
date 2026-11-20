# Launch-team and security-council actions from a Safe

On mainnet the launch team is a 1-of-3 Safe and the security council a 2-of-3 Safe. The crowdfund admin app
signs with a browser wallet, so it cannot act for them. Instead, three Hardhat tasks write files
for the Safe app's **Transaction Builder**:

- `cf-safe-batch`: seeds and launch-team invites, from a CSV
- `cf-safe-extend`: the launch team's window extension, `extendWindow(newEnd)`
- `cf-safe-cancel`: the security council's emergency `cancel()`

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
npx hardhat cf-safe-extend --end 2026-12-01T16:00:00Z --network mainnetHub  # extendWindow() file
npx hardhat cf-safe-cancel --network mainnetHub                           # cancel() file
```

The crowdfund address comes from `deployments/crowdfund-hub-mainnet.json` (or pass `--crowdfund`).
Other options: `--allow-stack`, `--max-seeds` (default 100 per batch), `--max-invites` (default
60 per batch), `--out` (default `safe-batches/`).

Before writing anything, the task checks every row against the live contract:

- the sale is active, ARM is loaded, and the launch-team window has not closed;
- seeds left (500 cap), launch-team budget left (1 hop-1 team wallet, 500 hop-2);
- no seed repeated or already added; the launch-team address is not a row;
- invites stay within each address's invites-received cap (1 at hop 1, 20 at hop 2).

Any problem stops the run and no files are written. Before the sale opens it only **warns**,
so batches can be prepared and signed ahead of time.

**Stacking.** The invites-received cap is 1 at hop 1 and 20 at hop 2. Inviting an address that is
already invited at that hop (on chain, or earlier in the same file) adds a slot at hop 2: each repeat
raises that person's commitment cap by $10,000 (up to $200,000) and uses one more unit of the hop-2
budget. The task accepts such a row only with `--allow-stack` and marks it `stacked` in the summary.
A row that would take an address past the cap (a second hop-1 placement, or a 21st hop-2 invite)
would revert on chain, so the task refuses it with an error, with or without `--allow-stack`.

## Output

`safe-batches/<time>-launch/` (gitignored):

- `batch-1-of-N-seeds.json`, …: seed batches first, then invite batches, one kind per batch
- `summary.md`: budgets before and after, warnings, and every call in every batch, including the
  `fromHop` value the Safe app will display

## Executing in the Safe app

For each batch file, **in order**:

1. Owner 1: Safe app → **Apps → Transaction Builder** → drag in the file. Check every call
   against `summary.md` → **Create batch** → **Simulate** → **Send batch** and sign.
   - **Launch team (1-of-3):** one signature meets the threshold, so owner 1 executes (pays
     the gas). No second owner reviews the batch: this check against `summary.md` is the only one.
2. **Security council (2-of-3):** owner 2: **Transactions → Queue** → open the transaction,
   check the calls against `summary.md` → **Confirm** → **Execute** (pays the gas).

Rules:

- **Execute every batch before running the task again.** Its checks read the contract, which
  cannot see batches still waiting in the Safe queue.
- The Safe queue executes strictly in order (by Safe nonce). Propose batches in file order.
- A proposed Safe transaction is stored on Safe's public transaction service, so its
  addresses are visible before execution.

## Extending the window

`cf-safe-extend --end <ISO 8601 UTC>` writes `extend.json` (one call, `extendWindow(newEnd)`) and a
`summary.md` with the current, new and maximum end. `--end` must be canonical UTC with an explicit
`Z`, like `2026-12-01T16:00:00Z`. Before writing, the task checks that the sale is active, the window
has not ended, the new end is later than the current one, and it is no later than
`windowStart + MAX_WINDOW_DURATION` (15 days). With less than 24 hours left it warns. Operationally,
each extension adds 5 days and there are at most two (the contract enforces only the 15-day cap; why:
`specs/CROWDFUND.md`, "Extension steps"). If the new end is not exactly 5 days after the current end,
the task warns in the console and in `summary.md`, but still writes the file.

The Safe must **execute before the current deadline**. After it, `extendWindow()` reverts and anyone
can finalize, so start signing well ahead. An extension cannot be undone or shortened. Procedure and
decision-log rules: `specs/OPERATIONS.md` §4, Extending the commitment window.

## Emergency cancel

`cf-safe-cancel` writes `cancel.json` for the security-council Safe. Prepare and check it
before the sale opens, then execute it only on a recorded emergency decision
(`specs/OPERATIONS.md` §7, Cancel Procedure). `cancel()` is immediate and irreversible.

## Sepolia rehearsal

Rehearse with a Sepolia crowdfund whose launch team is a 1-of-3 Safe and security council a
2-of-3 Safe, as on mainnet (the default Sepolia roles are single keys, which the tasks refuse):

- [ ] `cf-safe-batch --check` before the open time warns but passes.
- [ ] Import a seed batch and an invite batch into the Transaction Builder: no checksum warning,
      and the decoded calls match `summary.md` (including `fromHop`).
- [ ] Owner 1 executes with one signature; the seeds and invites appear on chain.
- [ ] Re-running the same CSV refuses (already added) and writes nothing.
- [ ] `cf-safe-extend` writes a file that imports without a checksum warning, shows `newEnd` as the
      unix value in `summary.md`, and moves `windowEnd()` once executed.
- [ ] `cf-safe-cancel` imports and simulates cleanly (execute only on a throwaway deploy).
