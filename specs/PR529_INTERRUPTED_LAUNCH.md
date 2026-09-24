# Interrupted crowdfund deployment recovery

The crowdfund stage consumes one-shot ARM permissions and wind-down setters. A
crash after any transaction must be treated as an interrupted launch, not an
invitation to rerun `deploy_crowdfund.ts`. The governance manifest now saves
`redemption` and `windDown` immediately after each mined deployment, before ARM
funding. Keep a copy of both manifests, transaction hashes, and the deployer nonce.

1. Stop all deployment senders. Compare manifest chain ID, deployer, contract
   addresses, constructor transactions, current nonce, and each transaction
   receipt with the intended launch record. If a send failed ambiguously, first
   resolve its receipt and nonce on chain. Do not guess or skip a nonce.
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
   manifests. Its reserve, wiring and timelock groups must pass. Scan timelock
   role events from the first governance deployment block for other holders.
   Record receipts and findings before opening the crowdfund window.

No recovery instruction can undo an irreversible one-shot initialization or
recover ARM already stranded above a RevenueLock beneficiary schedule.
