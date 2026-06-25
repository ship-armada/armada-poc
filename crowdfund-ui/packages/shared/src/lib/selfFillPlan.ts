// ABOUTME: Pure logic for the "max out" self-fill flow — computes the optimal self-invite + per-hop commit bundle that maximizes a participant's reachable commit ceiling.
// ABOUTME: Also provides a live on-chain state reader and a multicall calldata encoder so the bundle can be submitted as a single atomic tx.

import { Contract, type Interface, type JsonRpcProvider } from 'ethers'
import { CROWDFUND_ABI_FRAGMENTS, CROWDFUND_CONSTANTS, HOP_CONFIGS, type HopConfig } from './constants.js'
import { aggregate3, type AggregateCall } from './multicall3.js'

/** Live per-hop state for one of a participant's (address, hop) nodes. */
export interface SelfFillHopState {
  /** Times this node has been invited — scales its cap and outgoing budget. */
  invitesReceived: number
  /** Remaining outgoing invites this node can still issue (already net of sent). */
  invitesRemaining: number
  /** USDC already committed at this hop (6 decimals). */
  committed: bigint
}

/** Snapshot of a participant's three hop nodes, indexed by hop (0, 1, 2). */
export type SelfFillState = readonly [SelfFillHopState, SelfFillHopState, SelfFillHopState]

/** A batch of self-invites to issue from one hop (each creates/stacks a node at fromHop+1). */
export interface SelfFillInvite {
  /** The hop the invites are issued FROM (0 → creates hop-1 slots, 1 → hop-2). */
  fromHop: 0 | 1
  /** How many self-invites to issue at this hop. */
  count: number
}

/** A single per-hop commit in the bundle (the delta needed to reach the projected cap). */
export interface SelfFillCommit {
  hop: 0 | 1 | 2
  /** New USDC to commit at this hop (6 decimals) — the top-up to the projected cap. */
  amount: bigint
  /** USDC already committed here before the bundle. */
  existingCommitted: bigint
  /** Effective cap at this hop AFTER the self-invites land (invitesReceived' × per-slot cap). */
  targetCap: bigint
}

/** The full self-fill plan: invites to issue, commits to make, and the totals that drive the UI. */
export interface SelfFillPlan {
  /** True when the participant has at least one hop node (i.e. the feature applies). */
  eligible: boolean
  /** Self-invites to issue, ordered fromHop 0 then 1 (hop-0 invites must land first). */
  invites: SelfFillInvite[]
  /** Per-hop commits, ordered hop 0 → 1 → 2. Excludes any hop whose top-up is below MIN_COMMIT. */
  commits: SelfFillCommit[]
  /** Total number of self-invite txs in the bundle (sum of invite.count). */
  totalInvites: number
  /** New USDC the wallet must transfer now (sum of commit amounts). */
  newCommitUsdc: bigint
  /** Theoretical ceiling unlocked by the plan (sum of projected per-hop caps). */
  projectedCeilingUsdc: bigint
  /** Total committed after the bundle settles (existing + new commits). */
  totalCommittedAfterUsdc: bigint
  /** invitesReceived at each hop after the self-invites land. */
  projectedReceivedByHop: [number, number, number]
  /** Effective cap at each hop after the self-invites land. */
  projectedCapByHop: [bigint, bigint, bigint]
  /** True when the wallet balance can't cover `newCommitUsdc` (spike default: block). */
  balanceLimited: boolean
  /** Extra USDC the wallet needs to afford the full plan (0 when affordable). */
  shortfallUsdc: bigint
}

export interface ComputeSelfFillOptions {
  /** Wallet USDC balance (6 decimals) — used only to flag `balanceLimited`. */
  balance: bigint
  /** Per-commit minimum (6 decimals). Defaults to the active profile's MIN_COMMIT. */
  minCommit?: bigint
  /** Per-hop config. Defaults to the active profile's HOP_CONFIGS. */
  hopConfigs?: readonly [HopConfig, HopConfig, HopConfig]
}

/**
 * Compute the self-invite + commit bundle that maximizes a participant's reachable
 * commit ceiling across all their hops.
 *
 * Mechanics: a participant raises their effective cap at hop h+1 by inviting their
 * own address at hop h (each self-invite stacks `invitesReceived` at h+1, scaling
 * both that hop's cap and its own outgoing invite budget). We greedily spend the
 * full remaining outgoing budget at hop 0, which unlocks more budget at hop 1, then
 * spend that — bounded at each level by the per-hop `maxInvitesReceived` stacking cap.
 * Finally we top up each hop's committed amount to its projected cap.
 *
 * Pure function: no chain reads, no side effects. `fetchSelfFillState` supplies the
 * live `state`.
 */
export function computeSelfFillPlan(
  state: SelfFillState,
  opts: ComputeSelfFillOptions,
): SelfFillPlan {
  const hopConfigs = opts.hopConfigs ?? HOP_CONFIGS
  const minCommit = opts.minCommit ?? CROWDFUND_CONSTANTS.MIN_COMMIT

  const received = [
    state[0].invitesReceived,
    state[1].invitesReceived,
    state[2].invitesReceived,
  ]
  const eligible = received.some((r) => r > 0)

  const invites: SelfFillInvite[] = []

  // Stage 1 — hop-0 → hop-1. Spend the full remaining hop-0 outgoing budget on
  // self, bounded by how many more invites hop-1 can still receive.
  const room1 = hopConfigs[1].maxInvitesReceived - received[1]
  const add1 = Math.max(0, Math.min(state[0].invitesRemaining, room1))
  if (add1 > 0) invites.push({ fromHop: 0, count: add1 })
  const projReceived1 = received[1] + add1

  // Stage 2 — hop-1 → hop-2. The hop-1 outgoing budget grows by `add1 × maxInvites[1]`
  // once those new invitesReceived land, so fold that into the remaining budget.
  const rem1 = state[1].invitesRemaining + add1 * hopConfigs[1].maxInvites
  const room2 = hopConfigs[2].maxInvitesReceived - received[2]
  const add2 = Math.max(0, Math.min(rem1, room2))
  if (add2 > 0) invites.push({ fromHop: 1, count: add2 })
  const projReceived2 = received[2] + add2

  const projectedReceivedByHop: [number, number, number] = [
    received[0],
    projReceived1,
    projReceived2,
  ]
  // Per-slot caps (and the maxInvites / maxInvitesReceived budgets above) come
  // from the local `HOP_CONFIGS` profile, not from chain — the contract has no
  // public per-slot-cap getter, and the projected cap depends on post-invite
  // `invitesReceived` that doesn't exist on chain yet. This assumes the active
  // `VITE_CROWDFUND_PROFILE` matches the deployed constants (the rest of the UI
  // makes the same assumption). If it drifts: a too-high cap → over-commit, which
  // the contract refunds at settlement; a too-low cap → simply under-maxes; wrong
  // invite budgets → an atomic revert (safe retry) or under-issue. No fund risk
  // either way, but the plan would no longer be truly "max".
  const projectedCapByHop: [bigint, bigint, bigint] = [
    BigInt(projectedReceivedByHop[0]) * hopConfigs[0].capUsdc,
    BigInt(projectedReceivedByHop[1]) * hopConfigs[1].capUsdc,
    BigInt(projectedReceivedByHop[2]) * hopConfigs[2].capUsdc,
  ]

  const commits: SelfFillCommit[] = []
  let newCommitUsdc = 0n
  let totalExisting = 0n
  for (let hop = 0 as 0 | 1 | 2; hop < 3; hop = (hop + 1) as 0 | 1 | 2) {
    const existing = state[hop].committed
    totalExisting += existing
    const targetCap = projectedCapByHop[hop]
    const delta = targetCap > existing ? targetCap - existing : 0n
    // The contract reverts a commit below MIN_COMMIT, so skip dust top-ups.
    if (delta >= minCommit) {
      commits.push({ hop, amount: delta, existingCommitted: existing, targetCap })
      newCommitUsdc += delta
    }
  }

  const projectedCeilingUsdc =
    projectedCapByHop[0] + projectedCapByHop[1] + projectedCapByHop[2]
  const totalCommittedAfterUsdc = totalExisting + newCommitUsdc
  const balanceLimited = newCommitUsdc > opts.balance
  const shortfallUsdc = balanceLimited ? newCommitUsdc - opts.balance : 0n

  return {
    eligible,
    invites,
    commits,
    totalInvites: invites.reduce((sum, i) => sum + i.count, 0),
    newCommitUsdc,
    projectedCeilingUsdc,
    totalCommittedAfterUsdc,
    projectedReceivedByHop,
    projectedCapByHop,
    balanceLimited,
    shortfallUsdc,
  }
}

/**
 * Read a participant's live per-hop state (invitesReceived, remaining outgoing
 * invites, committed) for all three hops in a single Multicall3 eth_call.
 *
 * We read fresh from the contract rather than the event-derived graph so the plan
 * can't be built against a stale snapshot — an over-issued invite would revert the
 * whole atomic bundle right before the commit.
 */
export async function fetchSelfFillState(
  provider: JsonRpcProvider,
  crowdfundAddress: string,
  address: string,
): Promise<SelfFillState> {
  const cf = new Contract(crowdfundAddress, CROWDFUND_ABI_FRAGMENTS, provider)
  const calls: AggregateCall[] = []
  for (let hop = 0; hop < 3; hop++) {
    calls.push({ contract: cf, functionName: 'getInvitesReceived', args: [address, hop] })
    calls.push({ contract: cf, functionName: 'getInvitesRemaining', args: [address, hop] })
    calls.push({ contract: cf, functionName: 'getCommitment', args: [address, hop] })
  }
  const res = await aggregate3(provider, calls)
  const hopState = (hop: number): SelfFillHopState => {
    const base = hop * 3
    return {
      invitesReceived: res[base].success ? Number(res[base].result![0]) : 0,
      invitesRemaining: res[base + 1].success ? Number(res[base + 1].result![0]) : 0,
      committed: res[base + 2].success ? (res[base + 2].result![0] as bigint) : 0n,
    }
  }
  return [hopState(0), hopState(1), hopState(2)]
}

/**
 * Encode the self-fill plan into the ordered `bytes[]` calldata array for
 * `ArmadaCrowdfund.multicall`. All self-invites come first (hop-0 invites before
 * hop-1, so the hop-1 budget they unlock is live), then the per-hop commits.
 */
export function encodeSelfFillCalls(
  iface: Interface,
  selfAddress: string,
  plan: SelfFillPlan,
): string[] {
  const calls: string[] = []
  for (const inv of plan.invites) {
    for (let i = 0; i < inv.count; i++) {
      calls.push(iface.encodeFunctionData('invite', [selfAddress, inv.fromHop]))
    }
  }
  for (const c of plan.commits) {
    calls.push(iface.encodeFunctionData('commit', [c.hop, c.amount]))
  }
  return calls
}
