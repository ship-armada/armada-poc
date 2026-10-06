# Interrupted crowdfund deployment recovery

`npm run setup:mainnet` (`scripts/deploy_mainnet.ts`) is not re-runnable. On mainnet it
refuses to start while `deployments/governance-hub-mainnet.json` or
`deployments/crowdfund-hub-mainnet.json` exists. If recovery concludes that a clean
redeployment is needed, record the abandoned stack (addresses, receipts, any roles the
deployer still holds on it) and move both manifests into an archive folder before
starting the fresh run.

Mainnet manifests are tracked in git and kept by `npm run clean`, but until they are
committed the deploy machine holds the only copy. Back them up as soon as the run stops.

Each stage writes its manifest as it goes. `deploy_governance.ts` writes
`governance-hub-mainnet.json` before its first transaction and again after each
deployment. `deploy_crowdfund.ts` writes `crowdfund-hub-mainnet.json` right after
the crowdfund deploys, and adds `redemption` and `windDown` to the governance
manifest as each is mined, before ARM funding. Until a stage finishes, its
manifest carries `"inProgress": true` and lists only the contracts deployed so
far. A transaction sent just before the stop may be missing from it; resolve that
from the deployer nonce. `deploy_crowdfund.ts` refuses a governance manifest that is
still in progress.

The crowdfund stage consumes one-shot ARM permissions and wind-down setters. A
crash after any transaction must be treated as an interrupted launch, not an
invitation to rerun `deploy_crowdfund.ts`. Keep a copy of both manifests,
transaction hashes, and the deployer nonce.

1. Stop all deployment senders. Compare manifest chain ID, deployer, contract
   addresses, constructor transactions, current nonce, and each transaction
   receipt with the intended launch record. If a send failed ambiguously, first
   resolve its receipt and nonce on chain. Do not guess or skip a nonce. On live
   networks the deploy prints `[send] nonce N → 0x<hash>` as each transaction is
   accepted; the last such line identifies a transaction that stalled or was
   dropped before its receipt.
2. Read the token's one-shot initialization flags and whitelists, governor quorum
   exclusions, the distributor's integration result, and all wind-down bindings.
   The constructor provenance check and current beneficiary schedule must pass
   before any remaining ARM transfer. A wrong one-shot binding may require a
   clean redeployment; do not fund it.
3. Reconcile the exact ARM balances of deployer, treasury, lock and crowdfund.
   Execute only missing transfers. Never send the lock more than its immutable
   `totalAllocation`; `activate()` accepts excess and offers no sweep. Check
   `crowdfund.armLoaded()` and lock activation before repeating either call.
4. Complete remaining treasury outflow limits and the production timelock delay
   while the bootstrap roles still exist. Read back their actual values. Then
   renounce deployer proposer, executor, canceller and `TIMELOCK_ADMIN_ROLE`
   as applicable. The current script is not idempotent; these are individually
   reviewed recovery transactions, not an automated resume command.
5. Run `verify_deployment.ts` with the intended environment and the recorded
   manifests, in the Launch 1 scope as the orchestrator does
   (`VERIFY_SCOPE=launch1 npx hardhat run scripts/verify_deployment.ts --network mainnetHub`).
   Its reserve, wiring, timelock and launch-values groups must pass. Scan timelock role events from the first governance deployment block
   for other holders.
   Record receipts and findings before opening the crowdfund window.

No recovery instruction can undo an irreversible one-shot initialization or
recover ARM already stranded above a RevenueLock beneficiary schedule.
