# Armada Crowdfund PoC — Contract Specification

## Overview

Validates the CROWDFUND.md spec by implementing the core crowdfund mechanics: word-of-mouth whitelist invitations, USDC commitment escrow, deterministic hop-based allocation with pro-rata scaling and rollover, elastic expansion, and refund mechanism. After the crowdfund, participants receive ARM tokens they can lock in the existing VotingLocker for governance participation.

## Architecture: 1 Contract + Interface

```
contracts/crowdfund/
  IArmadaCrowdfund.sol      — Shared enums, structs, events
  ArmadaCrowdfund.sol       — Full crowdfund lifecycle

test/
  crowdfund_integration.ts  — Full test suite (~40 tests)

scripts/
  deploy_crowdfund.ts       — Deployment script
  crowdfund_demo.ts         — Narrated end-to-end demo

tasks/
  crowdfund.ts              — Hardhat CLI tasks
```

Single contract design. The crowdfund is a self-contained linear lifecycle (setup → invite → commit → finalize → claim). No need for multiple contracts at PoC scale. No existing contracts modified except a one-line `hardhat.config.ts` import.

## Design Decisions

### 1. On-chain invitations (not EIP-712 signatures)

The spec says "invitations are signed on-chain." An inviter calls `invite(invitee)` which registers the invitee at hop+1. Stores the invite graph directly in contract state.

Tradeoff: Gas-heavy vs. EIP-712 offline signatures, but simpler and PoC-appropriate. The invite graph is inherently public on-chain (readable via `eth_getStorageAt`), but view functions restrict access to post-finalization to match the spec's visibility timeline at the application layer.

### 2. Phase management via timestamps

```
Phase.Setup → Phase.Invitation → Phase.Commitment → Phase.Finalized
                                                   → Phase.Canceled
```

- `startInvitations()` (admin): sets invitation window (2 weeks) and commitment window (1 week)
- `invite()` / `commit()`: enforce time windows internally via `block.timestamp`
- `finalize()` (admin, after commitment ends): runs allocation algorithm or cancels if below minimum

Sequential, non-overlapping windows. The invitation window closes before the commitment window opens.

### 3. Allocation: single-pass with sequential rollover

The spec's pseudocode does a first pass (all 3 hops), then a separate rollover pass that re-allocates affected hops. Since hops are processed 0→1→2 and rollover only flows forward, a single pass with rollover applied before processing the next hop produces identical results. This is simpler in Solidity and avoids the two-pass overhead.

### 4. Token handling

- **ARM** (18 decimals): Admin deposits to contract before calling `finalize()`. Allocated to participants via `claim()`, remainder returned to treasury via `withdrawUnallocatedArm()`.
- **USDC** (6 decimals): Participants commit to escrow via `commit()`. Refunds returned via `claim()` (or `refund()` if canceled). Proceeds sent to treasury via `withdrawProceeds()`.
- **Price**: $1.00 per ARM. Conversion: `armAllocation = (usdcAmount * 1e18) / 1e6`.
- Uses existing `ArmadaToken` (100M supply) unmodified. Contract is fully parameterized.

## Data Structures

### IArmadaCrowdfund.sol — Shared Types

```solidity
enum Phase { Setup, Invitation, Commitment, Finalized, Canceled }

struct HopConfig {
    uint16 reserveBps;     // Reserve as basis points of sale size (7000, 2500, 500)
    uint256 capUsdc;       // Max individual commitment in USDC (6 decimals)
    uint8 maxInvites;      // How many addresses this hop can invite (3, 2, 0)
}

struct Participant {
    uint8 hop;             // 0, 1, or 2
    bool isWhitelisted;    // true after being added as seed or invited
    uint256 committed;     // USDC committed (6 decimals)
    uint256 allocation;    // ARM allocated (18 decimals), set at finalization
    uint256 refund;        // USDC refund (6 decimals), set at finalization
    bool claimed;          // true after claim() or refund() called
    address invitedBy;     // who invited this participant (address(0) for seeds)
    uint8 invitesSent;     // number of invites this address has sent
}

struct HopStats {
    uint256 totalCommitted;   // aggregate USDC committed for this hop
    uint32 uniqueCommitters;  // count of unique addresses that committed > 0
    uint32 whitelistCount;    // count of whitelisted addresses at this hop
}
```

### ArmadaCrowdfund.sol — State Variables

```solidity
// Immutable
IERC20 public immutable usdc;
IERC20 public immutable armToken;
address public admin;

// Sale parameters (constants)
BASE_SALE       = 1_200_000e6     // $1.2M USDC
MAX_SALE        = 1_800_000e6     // $1.8M USDC
MIN_SALE        = 1_000_000e6     // $1.0M USDC
ARM_PRICE       = 1e6             // $1.00 per ARM in USDC units
ELASTIC_TRIGGER = 1_800_000e6     // 1.5 × BASE_SALE

// Hop configs (set in constructor)
HopConfig[3] hopConfigs:
  Hop 0: reserveBps=7000 (70%), capUsdc=15_000e6 ($15K), maxInvites=3
  Hop 1: reserveBps=2500 (25%), capUsdc=4_000e6  ($4K),  maxInvites=2
  Hop 2: reserveBps=500  (5%),  capUsdc=1_000e6  ($1K),  maxInvites=0

// Rollover thresholds
HOP1_ROLLOVER_MIN_COMMITTERS = 30
HOP2_ROLLOVER_MIN_COMMITTERS = 50

// Phase & timing
Phase phase
uint256 invitationStart, invitationEnd
uint256 commitmentStart, commitmentEnd

// Participant data
mapping(address => Participant) participants
address[] participantList   // for iteration during finalization
HopStats[3] hopStats
uint256 totalCommitted

// Finalization results
uint256 saleSize            // BASE_SALE or MAX_SALE
uint256 totalAllocated      // total ARM allocated (18 dec)
uint256 totalAllocatedUsdc  // total USDC worth of allocations (6 dec)
```

## Contract Functions

### Setup Phase

**`constructor(usdc, armToken, admin)`**
- Stores token addresses and admin
- Initializes hop configs with spec values
- Sets `phase = Phase.Setup`

**`addSeeds(address[] calldata seeds)` — admin only, Setup phase**
- Registers each address as hop-0 participant (`isWhitelisted = true`, `invitedBy = address(0)`)
- Pushes to `participantList`, increments `hopStats[0].whitelistCount`
- Rejects: zero address, already-whitelisted

**`startInvitations()` — admin only, Setup phase**
- Requires at least 1 seed exists
- Sets timing: `invitationStart = now`, `invitationEnd = now + 2 weeks`, `commitmentStart = invitationEnd`, `commitmentEnd = commitmentStart + 1 week`
- Transitions to `Phase.Invitation`

### Invitation Phase

**`invite(address invitee)` — whitelisted caller, during invitation window**
- Checks: `block.timestamp` within invitation window
- Checks: caller is whitelisted, caller's hop < 2
- Checks: caller has remaining invites (`invitesSent < hopConfigs[hop].maxInvites`)
- Checks: invitee is not zero address, not already whitelisted
- Registers invitee at `hop = caller.hop + 1`
- Increments caller's `invitesSent` and `hopStats[inviteeHop].whitelistCount`

Sybil resistance is economic: a seed (hop 0, $15K cap, 70% reserve) who self-invites gets a hop-1 slot ($4K cap, 25% reserve) — a strict downgrade. The contract enforces single-hop participation and forward-only invitation chains.

### Commitment Phase

**`commit(uint256 amount)` — whitelisted caller, during commitment window**
- Checks: `block.timestamp` within commitment window
- Checks: caller is whitelisted, amount > 0
- Checks: `committed + amount ≤ hopConfigs[hop].capUsdc`
- Transfers USDC from caller to contract via `safeTransferFrom`
- Updates: `participant.committed += amount`, `hopStats[hop].totalCommitted += amount`, `totalCommitted += amount`
- Tracks first commit: if `committed` was 0 before, increments `hopStats[hop].uniqueCommitters`
- Multiple `commit()` calls allowed up to the hop cap

### Finalization

**`finalize()` — admin only, after commitment window ends**

1. **Minimum check**: If `totalCommitted < MIN_SALE` → set `Phase.Canceled`, emit event, return. All USDC refundable via `refund()`.

2. **Elastic expansion**: Since `commit()` already enforces per-hop caps, `totalCommitted` equals total capped demand.
   ```
   if totalCommitted >= ELASTIC_TRIGGER:
       saleSize = MAX_SALE
   else:
       saleSize = BASE_SALE
   ```

3. **ARM balance check**: Requires `armToken.balanceOf(this) >= (saleSize * 1e18) / ARM_PRICE`.

4. **Per-hop allocation (single pass, 0→1→2)**:
   ```
   For each hop h in [0, 1, 2]:
       reserve[h] = (saleSize * hopConfigs[h].reserveBps) / 10000
       // reserve[h] may have been augmented by rollover from hop h-1

       demand = hopStats[h].totalCommitted

       if demand ≤ reserve[h]:
           // Full allocation for this hop
           hopLeftover = reserve[h] - demand
       else:
           // Pro-rata: each participant gets (committed * reserve) / demand
           hopLeftover = 0

       // Apply rollover
       if h == 0:
           if hopStats[1].uniqueCommitters >= 30: reserve[1] += hopLeftover
           else: treasuryLeftover += hopLeftover
       elif h == 1:
           if hopStats[2].uniqueCommitters >= 50: reserve[2] += hopLeftover
           else: treasuryLeftover += hopLeftover
       else:
           treasuryLeftover += hopLeftover
   ```

5. **Individual allocations (second loop over participantList)**:
   ```
   For each participant p:
       if p.committed == 0: skip

       demand = hopStats[p.hop].totalCommitted
       reserve = finalReserves[p.hop]  // includes any rollover received

       if demand ≤ reserve:
           allocUsdc = p.committed
       else:
           allocUsdc = (p.committed * reserve) / demand

       p.allocation = (allocUsdc * 1e18) / ARM_PRICE
       p.refund = p.committed - allocUsdc
   ```

6. **Set totals**: `totalAllocated`, `totalAllocatedUsdc`. Set `Phase.Finalized`.

### Claims & Withdrawals

**`claim()` — participant, Finalized phase**
- Requires: `committed > 0`, `!claimed`
- Sets `claimed = true`
- Transfers `allocation` ARM tokens to caller
- Transfers `refund` USDC to caller

**`refund()` — participant, Canceled phase**
- Requires: `committed > 0`, `!claimed`
- Sets `claimed = true`
- Transfers full `committed` USDC back to caller

**`withdrawProceeds(address treasury)` — admin, Finalized phase**
- Sends `totalAllocatedUsdc` USDC to treasury (the project's sale proceeds)

**`withdrawUnallocatedArm(address treasury)` — admin, Finalized phase**
- Sends `armBalance - totalAllocated` ARM to treasury (unsold ARM)

### View Functions

| Function | Visibility | Notes |
|----------|-----------|-------|
| `getHopStats(hop)` | Always | Aggregates: committed, committers, whitelist count |
| `getSaleStats()` | Always | Total committed, phase, timing |
| `getCommitment(addr)` | Always | Individual committed amount + hop |
| `isWhitelisted(addr)` | Always | Whitelist check |
| `getInvitesRemaining(addr)` | Always | Remaining invite slots |
| `getInviteEdge(addr)` | Post-finalization only | Invite graph (inviter, hop) — restricted during sale |
| `getAllocation(addr)` | Post-finalization only | ARM allocation, USDC refund, claimed status |
| `getParticipantCount()` | Always | Length of participantList |

## Governance Integration

After the crowdfund, participants can lock their claimed ARM in the existing VotingLocker for governance participation:

1. Participant calls `crowdfund.claim()` → receives ARM tokens
2. Participant calls `armToken.approve(votingLockerAddress, amount)`
3. Participant calls `votingLocker.lock(amount)` → gains voting power
4. Participant can now vote on governance proposals via `governor.castVote()`

No modifications needed to any governance contracts. ArmadaToken is a plain ERC20; any holder can lock tokens in VotingLocker.

## Demo & Interactive Testing Strategy

Same two-layer approach as governance:

### Layer 1: Hardhat Tasks (`tasks/crowdfund.ts`)

```bash
npx hardhat cf-add-seeds --addresses 0x1,0x2,0x3 --network hub
npx hardhat cf-start --network hub
npx hardhat cf-invite --invitee 0x... --network hub
npx hardhat cf-commit --amount 5000 --network hub
npx hardhat cf-finalize --network hub
npx hardhat cf-claim --network hub
npx hardhat cf-stats --network hub
npx hardhat cf-allocation --address 0x... --network hub
```

### Layer 2: Narrated Demo Script (`scripts/crowdfund_demo.ts`)

```
npx hardhat run scripts/crowdfund_demo.ts --network hub
```

Deploys everything, runs through complete flow:
1. Setup: Deploy ARM + USDC + Crowdfund, fund ARM, add seeds
2. Invitations: Seeds invite hop-1, hop-1 invites hop-2
3. Commitments: Various amounts, show oversubscription in one hop
4. Finalize: Show allocation, pro-rata scaling, rollover
5. Claims: Participants claim ARM + refunds
6. Governance bridge: Participant locks ARM in VotingLocker

Uses `evm_increaseTime` / `evm_mine` to fast-forward through windows.

## Test Plan

~40 tests across 9 describe blocks covering:
- Setup phase: seed management, access control
- Invitation mechanics: hop chains, limits, double-whitelist prevention
- Commitment mechanics: USDC escrow, cap enforcement, aggregation
- Allocation algorithm: base vs elastic, pro-rata, rollover with thresholds
- Finalization & cancellation: timing, minimum raise
- Claims & refunds: ARM + USDC distribution, double-claim prevention
- View functions & graph privacy: visibility timeline
- End-to-end flows: complete lifecycle, elastic expansion, cancellation
- Governance integration: claimed ARM lockable in VotingLocker

## Open Questions / Unspecified Elements

### 1. Commitment withdrawal — PoC: No withdrawals (RESOLVED)

The spec doesn't mention whether participants can withdraw committed USDC during the commitment window. PoC decision: no withdrawals. Once committed, USDC is locked until finalization. This simplifies the contract and prevents strategic gaming (commit early to influence others, then withdraw).

Production consideration: a `decreaseCommitment()` function could be added if desired.

### 2. Precision loss in pro-rata — PoC: Acceptable (RESOLVED)

The division `(committed * reserve) / demand` can lose wei-level precision due to integer division. At USDC's 6 decimal precision, the maximum loss per participant is < 1 wei USDC ($0.000001). PoC: acceptable without mitigation.

Production consideration: track accumulated rounding errors and distribute to avoid leaving dust in the contract.

### 3. Gas limits on finalization — PoC: Fine at scale (RESOLVED)

`finalize()` iterates all participants twice (once for hop-level allocation, once for individual allocations). At PoC scale (tens to low hundreds of participants), gas is well within block limits.

Production consideration: batched finalization with Merkle proof-based claiming, or off-chain computation with on-chain verification.

### 4. Invite graph on-chain privacy — PoC: Application-layer restriction (RESOLVED)

View functions restrict `getInviteEdge()` access to post-finalization, matching the spec's visibility timeline. However, on-chain storage is inherently readable via `eth_getStorageAt` or event logs.

Production consideration: commit-reveal scheme (commit hash of invitation, reveal after sale) or ZK proofs for invitation verification without revealing the inviter.

### 5. Emergency cancel — PoC: Not included (OPEN)

The spec doesn't describe an admin emergency cancel during the commitment window. The PoC does not include this to keep scope tight. If something goes wrong during the commitment window, there is no way to abort — the sale must run to completion and either finalize or cancel due to minimum raise.

Should we add an `emergencyCancel()` function that transitions to `Phase.Canceled` at any time (admin-only)? This would enable full USDC refunds if a critical issue is discovered.

### 6. Timing overlap — PoC: Sequential windows (RESOLVED)

The spec lists "Invitation window: 2 weeks" and "Commitment window: 1 week" as separate phases. The PoC implements these as sequential, non-overlapping windows. The invitation window closes before the commitment window opens.

Alternative: allow invitations to continue during the commitment window (a late invitee could still commit). Not implemented in PoC; can be adjusted by changing the time window checks.

### 7. Admin key management — PoC: Single address (RESOLVED)

The PoC uses a single `admin` address for seed management, starting invitations, and finalization. In production, this would be a multisig or the governance timelock. The contract's `admin` field accepts any address at construction, so no code changes are needed — just deploy with the appropriate admin address.

### 8. ARM token funding timing — PoC: Manual deposit (RESOLVED)

The admin must transfer ARM tokens to the crowdfund contract before calling `finalize()`. The function checks `armToken.balanceOf(this) >= requiredArm`. In the PoC, this is done in the deploy script. In production, this could be a governance proposal that transfers ARM from the treasury to the crowdfund contract.
