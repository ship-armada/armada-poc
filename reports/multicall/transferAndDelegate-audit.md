# `ArmadaToken.transferAndDelegate` — Reentrancy & External-Call Audit

**Verdict: SAFE.** No path from `transferAndDelegate` reaches any user-controllable external address. Bundling `ArmadaCrowdfund.claim` inside an OZ `Multicall` introduces no new reentrancy surface.

---

## Call graph

Every function transitively reached from `transferAndDelegate`. All OZ references are to v4.9.3 (per `CLAUDE.md`).

```
ArmadaToken.transferAndDelegate(to, amount, delegatee)
  contracts/governance/ArmadaToken.sol:196
  |
  +-- authorizedDelegator[msg.sender]              (SLOAD, mapping read; line 197)
  |
  +-- ERC20._transfer(msg.sender, to, amount)     (line 198)
  |     OZ ERC20.sol::_transfer
  |     |
  |     +-- ArmadaToken._beforeTokenTransfer(from, to, amount)   (override; ArmadaToken.sol:217)
  |     |     +-- ERC20Votes._beforeTokenTransfer (super)   [no-op in 4.9.3 for non-supply-cap path]
  |     |     |     +-- ERC20._beforeTokenTransfer (super)  [empty default body]
  |     |     +-- SLOAD `transferable`, SLOAD `transferWhitelist[from]`  (no calls; line 223-228)
  |     |
  |     +-- _balances[from] -= amount; _balances[to] += amount;        (SSTOREs only)
  |     +-- emit Transfer(from, to, amount)                            (LOG, no call)
  |     |
  |     +-- ArmadaToken._afterTokenTransfer NOT overridden, falls to:
  |           ERC20Votes._afterTokenTransfer(from, to, amount)
  |           |
  |           +-- ERC20._afterTokenTransfer (super; empty)
  |           +-- _moveVotingPower(delegates(from), delegates(to), amount)
  |                 |
  |                 +-- _writeCheckpoint(_checkpoints[src], _subtract, amount)
  |                 |     +-- SLOADs/SSTOREs on the checkpoints array
  |                 |     +-- emit DelegateVotesChanged(src, oldWeight, newWeight)   (LOG, no call)
  |                 +-- _writeCheckpoint(_checkpoints[dst], _add, amount)
  |                       +-- SLOADs/SSTOREs
  |                       +-- emit DelegateVotesChanged(dst, oldWeight, newWeight)   (LOG, no call)
  |
  +-- ArmadaToken._delegate(to, delegatee)        (override; line 236, called at line 199)
        |
        +-- SLOAD noDelegation[delegator]                                  (line 237)
        +-- ERC20Votes._delegate(delegator, delegatee)  (super)
              |
              +-- delegates(delegator)            (SLOAD via _delegates mapping)
              +-- _delegates[delegator] = delegatee   (SSTORE)
              +-- emit DelegateChanged(delegator, currentDelegate, delegatee)   (LOG, no call)
              +-- _moveVotingPower(currentDelegate, delegatee, balanceOf(delegator))
                    +-- _writeCheckpoint(...) twice  (same as above; pure storage + LOG)
```

Total external (CALL/STATICCALL/DELEGATECALL) opcodes reachable from `transferAndDelegate`: **zero**.

---

## External call inventory

| # | Caller site | Opcode | Destination | Attacker-controllable? |
|---|---|---|---|---|
| — | (none) | — | — | — |

There are no `CALL`, `STATICCALL`, `DELEGATECALL`, `CALLCODE`, or `CREATE`/`CREATE2` operations on any path from `transferAndDelegate`. Every reachable line either:

- reads/writes storage on `ArmadaToken` itself (balances, checkpoints, mappings),
- performs arithmetic, or
- emits a LOG (`Transfer`, `DelegateChanged`, `DelegateVotesChanged`).

LOGs cannot trigger code execution on any address.

---

## Findings

1. **(info)** `transferAndDelegate` is gated by `authorizedDelegator[msg.sender]` (`ArmadaToken.sol:197`). The whitelist is set once by deployer (`initAuthorizedDelegators`, line 120) and may be add-only extended by timelock (`addAuthorizedDelegator`, line 146). An attacker EOA cannot call it directly; only authorized contracts (RevenueLock, ArmadaCrowdfund) can. This is a defense-in-depth observation, not a fix requirement.

2. **(info)** ERC20 `_transfer` writes `_balances` then emits `Transfer` — no recipient hook. OpenZeppelin 4.9.3 `ERC20.sol` does **not** implement ERC-777 `tokensReceived` or ERC-1363 `onTransferReceived` callbacks. Confirmed by inspecting the inheritance chain in `ArmadaToken.sol:6` (only `ERC20Votes` is imported, which extends `ERC20Permit` → `ERC20` with no callback extensions).

3. **(info)** `_beforeTokenTransfer` override (`ArmadaToken.sol:217-230`) only performs SLOADs on `transferable` and `transferWhitelist[from]`. No external calls. No revert path that depends on attacker-controlled state beyond the `from`/`to` addresses (which are `msg.sender` and `to`, both passed by the authorized caller — Crowdfund passes its own address as `msg.sender` and the claimant as `to`).

4. **(info)** `_delegate` override (`ArmadaToken.sol:236-239`) only performs an SLOAD on `noDelegation[delegator]` and forwards to `ERC20Votes._delegate`. `ERC20Votes._delegate` updates the `_delegates` mapping, emits `DelegateChanged`, and calls `_moveVotingPower`. `_moveVotingPower` invokes `_writeCheckpoint` which is pure storage + `DelegateVotesChanged` event emission. None of these touch external addresses.

5. **(info)** No assembly blocks, no `address.call`, `staticcall`, `delegatecall`, `send`, or `transfer` (ETH) appear in `ArmadaToken.sol`. Grep confirms zero matches for these patterns inside the file.

6. **(info)** The `delegatee` parameter is never used as a call target — only as a key in `_delegates[delegator] = delegatee` and as a topic in `DelegateChanged`. Even if `delegatee` is an arbitrary attacker contract, it receives no execution opportunity during the delegation step.

7. **(info)** The `to` parameter is the recipient of the ARM balance update but, again, is never dispatched to via CALL. The `from`/`to` addresses appear only inside `_balances`, `_checkpoints`, `_delegates`, and event topics.

8. **(low — design defense in depth)** `ArmadaCrowdfund.claim` is itself `nonReentrant` (line 529). Because OZ `Multicall` performs `Address.functionDelegateCall(address(this), data[i])`, the `ReentrancyGuard._status` SSTORE persists for the duration of each delegatecalled function. However, between sibling calls in a multicall bundle, `_status` is reset (the modifier exits normally each iteration). This is the *intended* multicall composition pattern and does **not** create a reentry path because the only external call from `claim` (`transferAndDelegate`) makes no further external calls (see graph above). Recorded here purely for reviewer context: the safety argument does not rely on the guard, it relies on the absence of attacker-reachable callsites.

---

## Conclusion

`ArmadaToken.transferAndDelegate` executes a closed-world subgraph: ERC20 balance updates, ERC20Votes checkpoint updates, and event emissions. Every reachable line operates on `ArmadaToken`'s own storage or emits LOGs. There are zero `CALL`/`STATICCALL`/`DELEGATECALL` opcodes, zero ERC-777/1363/custom recipient hooks, zero assembly blocks, and zero fallback/proxy dispatches on the call graph rooted at `transferAndDelegate`. The `to` and `delegatee` parameters are consumed as storage keys and event topics only — never as call targets. Consequently, when `ArmadaCrowdfund.claim` is bundled inside an OZ `Multicall` invocation, there is no execution slot during the `transferAndDelegate` step where attacker code could run and re-enter `ArmadaCrowdfund` (or any sibling contract). Adding `Multicall` to `ArmadaCrowdfund` introduces **no reentrancy risk through the `claim → transferAndDelegate` edge**. The pre-existing `nonReentrant` modifier on `claim` and all other state-mutating Crowdfund functions remains a sound defense-in-depth measure but is not load-bearing for this specific edge.

Open question for the reviewer (out of scope for this memo, but worth flagging): the `Multicall` evaluation should additionally confirm that *other* Crowdfund externals bundleable in the same call — e.g. `commit`, `claimRefund`, `withdrawUnallocatedArm` — do not reach attacker-controllable external addresses either. USDC is vanilla ERC20 per the task brief, so `safeTransfer(usdc, …)` is benign; the remaining audit surface is the launch-team / treasury / `IArmadaTokenCrowdfund` calls in those other functions.
