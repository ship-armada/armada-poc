// ABOUTME: Unit tests for the crowdfund deployment profiles: the relaunch values, profile parsing, and
// ABOUTME: per-profile feature flags. Relaunch values must match contracts/crowdfund/ArmadaCrowdfund.sol.

import { describe, it, expect } from 'vitest'
import {
  CONSTANTS_BY_PROFILE,
  CROWDFUND_PROFILES,
  FEATURES_BY_PROFILE,
  HOP_CONFIGS_BY_PROFILE,
  TIER_LABELS_BY_PROFILE,
  isCrowdfundProfile,
  parseCrowdfundProfile,
} from './constants.js'

const USDC = 10n ** 6n
const DAY = 24 * 60 * 60

describe('relaunch profile', () => {
  // WHY: the UI's allocation projection, caps and budgets read these values instead of the chain.
  // They must equal the relaunch contract's constants (pinned on-chain-side by
  // test-foundry/CrowdfundRelaunchConfig.t.sol); a drift shows wrong caps or refund projections.
  it('matches the relaunch contract sale and budget constants', () => {
    const c = CONSTANTS_BY_PROFILE.relaunch
    expect(c.BASE_SALE).toBe(1_800_000n * USDC)
    expect(c.MAX_SALE).toBe(1_800_000n * USDC)
    expect(c.ELASTIC_TRIGGER).toBe(1_800_000n * USDC)
    expect(c.MIN_SALE).toBe(250_000n * USDC)
    expect(c.ARM_PRICE).toBe(1_000_000n)
    expect(c.MAX_SEEDS).toBe(500)
    expect(c.LAUNCH_TEAM_HOP1_BUDGET).toBe(1)
    expect(c.LAUNCH_TEAM_HOP2_BUDGET).toBe(500)
    expect(c.MIN_COMMIT).toBe(100n * USDC)
    expect(c.WINDOW_DURATION).toBe(5 * DAY)
    expect(c.LAUNCH_TEAM_INVITE_PERIOD).toBe(5 * DAY)
    expect(c.CLAIM_DEADLINE_DURATION).toBe(1095 * DAY)
    expect(c.GOVERNANCE_QUIET_PERIOD).toBe(10 * DAY)
    expect(c.ALLOCATION_MODEL).toBe('hop2Reserve')
    expect(c.HOP2_RESERVE_USDC).toBe(300_000n * USDC)
    expect(c.TEAM_PAYMENT_USDC).toBe(250_000n * USDC)
    expect(c.HOP2_BASE_FLOOR_BPS).toBe(0)
    expect(c.HOP2_EXTRA_FLOOR_BPS).toBe(0)
  })

  // WHY: hop configs drive caps, invite-slot counts and stacking limits. Known: $100k, no invites;
  // Team wallet: $0 cap, 100 invites; Invited: $10k per invite, stacking to 20 invites. ceilingBps
  // is unused by the reserve model, and 0 as in the contract.
  it('matches the relaunch contract hop configs', () => {
    expect(HOP_CONFIGS_BY_PROFILE.relaunch).toEqual([
      { ceilingBps: 0, capUsdc: 100_000n * USDC, maxInvites: 0, maxInvitesReceived: 1 },
      { ceilingBps: 0, capUsdc: 0n, maxInvites: 100, maxInvitesReceived: 1 },
      { ceilingBps: 0, capUsdc: 10_000n * USDC, maxInvites: 0, maxInvitesReceived: 20 },
    ])
  })

  // WHY: the relaunch admits outside contributors only through team-wallet invite links, so the
  // address-invite and self-fill flows must be off, and the team wallets are hidden from public
  // views; the other profiles keep the real hop structure.
  it('sets link-only, no self-fill and hidden team wallets only for the relaunch', () => {
    expect(FEATURES_BY_PROFILE.relaunch).toEqual({ directInvites: false, selfFill: false, hideTeamWallets: true })
    expect(FEATURES_BY_PROFILE.mainnet).toEqual({ directInvites: true, selfFill: true, hideTeamWallets: false })
    expect(FEATURES_BY_PROFILE.medi).toEqual({ directInvites: true, selfFill: true, hideTeamWallets: false })
  })
})

describe('tier labels', () => {
  // WHY: the relaunch presents its hops as named tiers; the Launch 1 and testnet profiles keep the
  // hop numbering their users and operators already know.
  it('names the relaunch tiers and keeps hop numbers elsewhere', () => {
    expect(TIER_LABELS_BY_PROFILE.relaunch).toEqual(['Known', 'Team', 'Invited'])
    expect(TIER_LABELS_BY_PROFILE.mainnet).toEqual(['Hop-0', 'Hop-1', 'Hop-2'])
    expect(TIER_LABELS_BY_PROFILE.medi).toEqual(['Hop-0', 'Hop-1', 'Hop-2'])
  })
})

describe('mainnet profile', () => {
  // WHY: the mainnet profile still describes the deployed Launch 1 crowdfund (its refund UI); the
  // relaunch must not change it.
  it('keeps the Launch 1 sale constants', () => {
    const c = CONSTANTS_BY_PROFILE.mainnet
    expect(c.BASE_SALE).toBe(1_200_000n * USDC)
    expect(c.MAX_SALE).toBe(1_800_000n * USDC)
    expect(c.MIN_SALE).toBe(1_000_000n * USDC)
    expect(c.MAX_SEEDS).toBe(180)
  })

  // WHY: Launch 1 and the medi testnet deployments run the floor/ceiling waterfall and pay no
  // launch team at settlement; only the relaunch uses the reserve model and team payment.
  it('keeps the waterfall model and no team payment outside the relaunch', () => {
    for (const p of ['mainnet', 'medi'] as const) {
      expect(CONSTANTS_BY_PROFILE[p].ALLOCATION_MODEL).toBe('waterfall')
      expect(CONSTANTS_BY_PROFILE[p].HOP2_RESERVE_USDC).toBe(0n)
      expect(CONSTANTS_BY_PROFILE[p].TEAM_PAYMENT_USDC).toBe(0n)
    }
  })
})

describe('parseCrowdfundProfile', () => {
  // WHY: before the relaunch profile existed, any value but "medi" silently became mainnet, so a
  // relaunch build would have rendered Launch 1 numbers. Each known profile must resolve to itself.
  it('resolves every known profile name, ignoring surrounding whitespace', () => {
    expect(parseCrowdfundProfile('relaunch')).toBe('relaunch')
    expect(parseCrowdfundProfile('medi')).toBe('medi')
    expect(parseCrowdfundProfile(' mainnet ')).toBe('mainnet')
  })

  // WHY: unset keeps the existing default so mainnet-targeted builds need no env change. Unknown
  // values also fall back here; the apps' validateEnv rejects them on production builds.
  it('defaults unset and unknown values to mainnet', () => {
    expect(parseCrowdfundProfile(undefined)).toBe('mainnet')
    expect(parseCrowdfundProfile('')).toBe('mainnet')
    expect(parseCrowdfundProfile('relaunh')).toBe('mainnet')
  })
})

describe('isCrowdfundProfile', () => {
  // WHY: validateEnv uses this to refuse a typo'd profile instead of letting it fall back silently.
  it('accepts exactly the known profiles', () => {
    expect(CROWDFUND_PROFILES).toEqual(['mainnet', 'medi', 'relaunch'])
    for (const p of CROWDFUND_PROFILES) expect(isCrowdfundProfile(p)).toBe(true)
    expect(isCrowdfundProfile('relaunh')).toBe(false)
    expect(isCrowdfundProfile('')).toBe(false)
  })
})
