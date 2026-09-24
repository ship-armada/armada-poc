# Canonical decision log

The sole durable decision log is [`ship-armada/team/STRATEGY_LOG.json`](https://github.com/ship-armada/team/blob/main/STRATEGY_LOG.json).
This file is a pointer, not a separate decision record.

The PR #529 entry previously kept here must be recorded in that canonical log before
claiming decision-log convergence. Migration is pending access to the team repository;
no canonical entry or approval is claimed by this pointer.

The implementation and its disclosed tradeoffs are specified in
[REVENUE_RESERVE_DISTRIBUTOR.md](REVENUE_RESERVE_DISTRIBUTOR.md). The reserve amount,
category allocations, and airdrop recipient architecture must reconcile with the
approved cap table and launch parameter manifest; test examples do not set those values.

Migration source: [the original PR #529 decision record at commit 48eb6f92](https://github.com/ship-armada/armada-poc/blob/48eb6f92f6d2bfb3f0f56667edd69f2e21346402/specs/STRATEGY_LOG.md). Preserve its rationale when migrating, and reconcile later revisions with the current specification.
