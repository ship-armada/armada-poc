// ABOUTME: Deterministic mock crowdfund dataset shaped like the real Armada invite tree.
// ABOUTME: Ported from the armada-crowdfund mockup's iskay/realistic-crowdfund-mock branch (commit 11e4995); `Crowdfund` renamed to `CrowdfundSnapshot` to avoid overloading the on-chain contract term.

export type Hop = 0 | 1 | 2

/**
 * Discrete scenario sizes accepted by `NodeSphere.scenarioParticipants` — drives
 * the sphere's internal generated-node count. Retained for the existing
 * preview/picker UI (`NodeSpherePreview`); removed when Phase 4b.1 ports the
 * realistic-mock branch's NodeSphere upgrade (which renders pinnedNodes
 * directly and no longer needs this knob).
 */
export type ScenarioParticipants = 0 | 3 | 4 | 5 | 30 | 800

const HOP_LABELS: Record<Hop, string> = { 0: 'Hop 0', 1: 'Hop 1', 2: 'Hop 2' }
const HOP_CAP_USD: Record<Hop, number> = { 0: 15_000, 1: 4_000, 2: 1_000 }
const INVITES_TOTAL: Record<Hop, number> = { 0: 5, 1: 3, 2: 1 }

const TARGET_SEEDS = 100
const TARGET_HOP1 = 300
const TARGET_HOP2 = 600

const SELF_INVITE_FRACTION = 0.05
const DIRECT_ARMADA_HOP1_RATE = 0.05
const DIRECT_ARMADA_HOP2_RATE = 0.02

const COMMIT_TARGET_LO = 1_000_000
const COMMIT_TARGET_HI = 1_400_000

// Per-hop lognormal parameters used to draw commitment sizes. Means are
// targeted so the natural sample for a full dataset (100/300/600 entries plus
// ~100 self-invite duplicates) lands roughly in the middle of the desired
// $1.0M–$1.4M totalCommitted band without the rescale step constantly firing.
const COMMIT_PARAMS: Record<Hop, { median: number; sigma: number; min: number }> = {
  0: { median: 3_500, sigma: 0.9, min: 250 },
  1: { median: 700, sigma: 1.0, min: 100 },
  2: { median: 175, sigma: 1.0, min: 25 },
}

export type Participant = {
  /** Wallet address. The same address may appear in multiple entries (multi-hop wallets). */
  address: string
  hop: Hop
  /** 'Armada' for direct launch-team invites, the wallet's own address for self-invites,
   *  or another participant's address otherwise. */
  inviter: string
  selfInvited: boolean
  /** True when this wallet has entries at more than one hop. Set on all of the wallet's entries. */
  multiHop: boolean
  invitesTotal: number
  invitesUsed: number
  amountUsd: number
}

/**
 * Aggregate + entries bundle. Consumed by `CrowdfundExperience`'s internal mock
 * setup and by the committer's live-data adapter (Phase 4b.2).
 *
 * Named "Snapshot" rather than "Crowdfund" because the latter overloads with
 * the on-chain Crowdfund contract / domain term — this is purely the view
 * layer's read-only data bundle.
 */
export type CrowdfundSnapshot = {
  /** Theoretical maximum total commitment from hop economics (sum of seats × per-seat cap). */
  cap: number
  totalCommitted: number
  /** Raw entries. A multi-hop wallet contributes more than one entry. */
  participants: Participant[]
}

// View shapes preserved for existing consumers.
export type DashboardParticipant = {
  address: string
  hop: 'Hop 0' | 'Hop 1' | 'Hop 2'
  amountUsd: number
  multiHop?: boolean
  /** Every distinct inviter of this wallet, across all of its hop entries.
   *  Includes the `'armada'` / `'Armada'` root sentinel for seeds. NodeSphere
   *  renders one edge per inviter so a multi-hop wallet shows every incoming
   *  invite relationship — not just the primary one. */
  inviters: string[]
}

export type HeroParticipantRow = {
  address: string
  /** Reverse-resolved ENS name for `address`. Consumers render this in place
   *  of the truncated address when present; search/selection still keys off
   *  the raw `address`. */
  displayName?: string
  hop: 'SEED' | 'HOP-1' | 'HOP-2'
  amountUsd: number
  multiHop?: boolean
}

export type ParticipantsTableRow = {
  address: string
  /** Reverse-resolved ENS name for `address`. See `HeroParticipantRow.displayName`. */
  displayName?: string
  hops: string
  committedUsd: number
  invitedBy: string
  invitesUsed: number
  invitesTotal: number
  multiHop?: boolean
}

function mulberry32(seed: number) {
  return () => {
    let t = (seed += 0x6d2b79f5)
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function makeAddress(rand: () => number) {
  const hex = '0123456789abcdef'
  const pick = () => hex[Math.floor(rand() * hex.length)]
  let out = '0x'
  for (let i = 0; i < 40; i += 1) out += pick()
  return `${out.slice(0, 6)}...${out.slice(-4)}`
}

// Box-Muller transform yielding a standard normal sample from two uniform draws.
function sampleStandardNormal(rand: () => number) {
  const u1 = Math.max(1e-9, rand())
  const u2 = rand()
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2)
}

function sampleCommitment(rand: () => number, hop: Hop) {
  const { median, sigma, min } = COMMIT_PARAMS[hop]
  const value = median * Math.exp(sigma * sampleStandardNormal(rand))
  return Math.max(min, Math.min(HOP_CAP_USD[hop], Math.round(value)))
}

function shuffleInPlace<T>(arr: T[], rand: () => number) {
  for (let i = arr.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rand() * (i + 1))
    ;[arr[i], arr[j]] = [arr[j], arr[i]]
  }
}

export function generateCrowdfund(seed: number): CrowdfundSnapshot {
  const rand = mulberry32(seed)
  const entries: Participant[] = []
  const walletsByHop: string[][] = [[], [], []]
  const inviteCapacityRemaining = new Map<string, number>()

  const pushEntry = (e: Participant) => {
    entries.push(e)
    walletsByHop[e.hop].push(e.address)
  }

  // Seeds: 100 Hop-0 wallets, all directly invited by Armada.
  for (let i = 0; i < TARGET_SEEDS; i += 1) {
    const address = makeAddress(rand)
    pushEntry({
      address,
      hop: 0,
      inviter: 'Armada',
      selfInvited: false,
      multiHop: false,
      invitesTotal: INVITES_TOTAL[0],
      invitesUsed: 0,
      amountUsd: sampleCommitment(rand, 0),
    })
    inviteCapacityRemaining.set(address, INVITES_TOTAL[0])
  }

  // Tree growth: each child draws an inviter (weighted toward parents with remaining
  // invite capacity), with a small chance of being directly invited by Armada.
  const growHop = (parentHop: Hop, childHop: Hop, count: number, directArmadaRate: number) => {
    for (let i = 0; i < count; i += 1) {
      const address = makeAddress(rand)
      let inviter: string
      const directArmada = rand() < directArmadaRate
      if (directArmada) {
        inviter = 'Armada'
      } else {
        const parents = walletsByHop[parentHop].filter(
          (a) => (inviteCapacityRemaining.get(a) ?? 0) > 0,
        )
        if (parents.length === 0) {
          // All parents saturated — fall back to Armada so the tree still grows.
          inviter = 'Armada'
        } else {
          inviter = parents[Math.floor(rand() * parents.length)]
          inviteCapacityRemaining.set(inviter, (inviteCapacityRemaining.get(inviter) ?? 0) - 1)
        }
      }
      pushEntry({
        address,
        hop: childHop,
        inviter,
        selfInvited: false,
        multiHop: false,
        invitesTotal: INVITES_TOTAL[childHop],
        invitesUsed: 0,
        amountUsd: sampleCommitment(rand, childHop),
      })
      if (INVITES_TOTAL[childHop] > 0) {
        inviteCapacityRemaining.set(address, INVITES_TOTAL[childHop])
      }
    }
  }

  growHop(0, 1, TARGET_HOP1, DIRECT_ARMADA_HOP1_RATE)
  growHop(1, 2, TARGET_HOP2, DIRECT_ARMADA_HOP2_RATE)

  // Self-invites: ~10% of unique wallets at Hop 0 or Hop 1 use one of their own
  // invite slots to add a duplicate entry one hop lower. This is the mechanism
  // that produces multi-hop wallets.
  const targetSelfInvites = Math.round(
    (TARGET_SEEDS + TARGET_HOP1 + TARGET_HOP2) * SELF_INVITE_FRACTION,
  )
  const candidates = [...walletsByHop[0], ...walletsByHop[1]]
  shuffleInPlace(candidates, rand)

  let selfInvitesDone = 0
  for (const address of candidates) {
    if (selfInvitesDone >= targetSelfInvites) break
    if ((inviteCapacityRemaining.get(address) ?? 0) <= 0) continue

    // The wallet's current highest-priority (lowest-numbered) hop entry.
    const existing = entries.filter((e) => e.address === address)
    const highest = existing.reduce((min, e) => (e.hop < min ? e.hop : min), 2 as Hop)
    if (highest >= 2) continue

    const childHop = (highest + 1) as Hop
    inviteCapacityRemaining.set(address, (inviteCapacityRemaining.get(address) ?? 0) - 1)
    pushEntry({
      address,
      hop: childHop,
      inviter: address,
      selfInvited: true,
      multiHop: true,
      invitesTotal: INVITES_TOTAL[childHop],
      invitesUsed: 0,
      amountUsd: sampleCommitment(rand, childHop),
    })
    selfInvitesDone += 1
  }

  // Mark every entry of a multi-hop wallet so consumers can render the ring
  // on whichever entry they choose to display.
  const multiHopAddresses = new Set(
    entries.filter((e) => e.selfInvited).map((e) => e.address),
  )
  for (const e of entries) {
    if (multiHopAddresses.has(e.address)) e.multiHop = true
  }

  // Tally invitesUsed: count entries whose inviter is this wallet (self-invites
  // count too — they consume one of the wallet's own slots).
  const usedByAddr = new Map<string, number>()
  for (const e of entries) {
    if (e.inviter === 'Armada') continue
    usedByAddr.set(e.inviter, (usedByAddr.get(e.inviter) ?? 0) + 1)
  }
  for (const e of entries) {
    e.invitesUsed = usedByAddr.get(e.address) ?? 0
  }

  // Rescale commitments to land in the target window. The lognormal draw can be
  // noisy across seeds; a single linear scale keeps shapes intact while pinning
  // the headline number to the realistic band.
  const rawTotal = entries.reduce((s, e) => s + e.amountUsd, 0)
  let scale = 1
  if (rawTotal > COMMIT_TARGET_HI) scale = COMMIT_TARGET_HI / rawTotal
  else if (rawTotal < COMMIT_TARGET_LO) scale = COMMIT_TARGET_LO / rawTotal
  if (scale !== 1) {
    for (const e of entries) {
      const scaled = Math.max(1, Math.round(e.amountUsd * scale))
      e.amountUsd = Math.min(HOP_CAP_USD[e.hop], scaled)
    }
  }
  const totalCommitted = entries.reduce((s, e) => s + e.amountUsd, 0)

  const cap =
    TARGET_SEEDS * HOP_CAP_USD[0] + TARGET_HOP1 * HOP_CAP_USD[1] + TARGET_HOP2 * HOP_CAP_USD[2]

  return { cap, totalCommitted, participants: entries }
}

// Group entries by wallet address; preserved order of first occurrence.
function groupByWallet(entries: Participant[]): Map<string, Participant[]> {
  const byAddr = new Map<string, Participant[]>()
  for (const e of entries) {
    const list = byAddr.get(e.address) ?? []
    list.push(e)
    byAddr.set(e.address, list)
  }
  return byAddr
}

function primaryEntry(entries: Participant[]): Participant {
  // Highest priority is the lowest-numbered hop (Hop 0 > Hop 1 > Hop 2).
  return entries.reduce((best, e) => (e.hop < best.hop ? e : best))
}

export function toDashboardParticipants(cf: CrowdfundSnapshot): DashboardParticipant[] {
  const grouped = groupByWallet(cf.participants)
  const out: DashboardParticipant[] = []
  for (const [address, list] of grouped) {
    const primary = primaryEntry(list)
    const amountUsd = list.reduce((s, e) => s + e.amountUsd, 0)
    // Dedupe inviters across hop entries so a multi-hop wallet exposes every
    // incoming invite relationship to NodeSphere's edge builder.
    const inviterSet = new Set<string>()
    for (const e of list) inviterSet.add(e.inviter)
    out.push({
      address,
      hop: HOP_LABELS[primary.hop] as DashboardParticipant['hop'],
      amountUsd,
      multiHop: list.length > 1,
      inviters: [...inviterSet],
    })
  }
  return out
}

export function toHeroParticipants(rows: DashboardParticipant[]): HeroParticipantRow[] {
  return rows.map((r) => ({
    address: r.address,
    hop: r.hop === 'Hop 0' ? 'SEED' : r.hop === 'Hop 1' ? 'HOP-1' : 'HOP-2',
    amountUsd: r.amountUsd,
    multiHop: r.multiHop,
  }))
}

/**
 * Project the live `AddressSummary[]` from `useGraphState()` into the same
 * dashboard-row shape the mock pipeline produces. Pure function — no React
 * dependency — so the committer can call it inside `useMemo`.
 *
 * USDC bigints (6 decimals) are projected to plain `number` via integer-cents
 * division; values exceeding `Number.MAX_SAFE_INTEGER / 1e6` (~9 quadrillion
 * USDC) would lose precision, but the crowdfund cap is many orders of
 * magnitude below that so the dollar amounts stay exact.
 */
export function toDashboardParticipantsFromGraph(
  summaries: import('./graph.js').AddressSummary[],
): DashboardParticipant[] {
  const out: DashboardParticipant[] = []
  for (const s of summaries) {
    if (!s.hops.length) continue
    const primaryHop = Math.min(...s.hops) as Hop
    if (primaryHop !== 0 && primaryHop !== 1 && primaryHop !== 2) continue
    out.push({
      address: s.address,
      hop: HOP_LABELS[primaryHop] as DashboardParticipant['hop'],
      amountUsd: Number(s.totalCommitted / 1_000_000n),
      multiHop: s.hops.length > 1,
      inviters: s.allInviters,
    })
  }
  return out
}

export function toParticipantsTableRows(cf: CrowdfundSnapshot): ParticipantsTableRow[] {
  const grouped = groupByWallet(cf.participants)
  const out: ParticipantsTableRow[] = []
  for (const [address, list] of grouped) {
    const primary = primaryEntry(list)
    const total = list.reduce((s, e) => s + e.amountUsd, 0)
    const sortedHops = [...list].sort((a, b) => a.hop - b.hop)
    const hops =
      list.length > 1
        ? sortedHops.map((e) => HOP_LABELS[e.hop]).join(', ')
        : HOP_LABELS[primary.hop]
    out.push({
      address,
      hops,
      committedUsd: total,
      invitedBy: primary.inviter === address ? 'Self' : primary.inviter,
      invitesUsed: primary.invitesUsed,
      invitesTotal: primary.invitesTotal,
      multiHop: list.length > 1,
    })
  }
  return out
}
