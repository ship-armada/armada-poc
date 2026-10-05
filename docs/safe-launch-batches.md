# Launch-team and security-council actions from a Safe

On mainnet the launch team and the security council are 2-of-3 Safes. The crowdfund admin app
signs with a browser wallet, so it cannot act for them. Instead, two Hardhat tasks write files
for the Safe app's **Transaction Builder**:

- `cf-safe-batch`: seeds and launch-team invites, from a CSV
- `cf-safe-cancel`: the security council's emergency `cancel()`

Each file is **one Safe transaction**. A file with several calls is executed by the Safe as one
bundle (MultiSend): all calls succeed or none do, for one signing round and one gas payment.

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

## Sepolia rehearsal

Rehearse with a Sepolia crowdfund whose launch team and security council are 2-of-3 Safes
(the default Sepolia roles are single keys, which the tasks refuse):

- [ ] `cf-safe-batch --check` before the open time warns but passes.
- [ ] Import a seed batch and an invite batch into the Transaction Builder: no checksum warning,
      and the decoded calls match `summary.md` (including `fromHop`).
- [ ] Owner 2 confirms and executes; the seeds and invites appear on chain.
- [ ] Re-running the same CSV refuses (already added) and writes nothing.
- [ ] `cf-safe-cancel` imports and simulates cleanly (execute only on a throwaway deploy).
