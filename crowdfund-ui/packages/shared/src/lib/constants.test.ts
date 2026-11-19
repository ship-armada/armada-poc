// ABOUTME: Unit tests for the crowdfund deployment profiles: the relaunch values, profile parsing, and
// ABOUTME: per-profile feature flags. Relaunch values must match contracts/crowdfund/ArmadaCrowdfund.sol.

import { describe, it, expect } from 'vitest'
import {
  CONSTANTS_BY_PROFILE,
  CROWDFUND_PROFILES,
  FEATURES_BY_PROFILE,
  HOP_CONFIGS_BY_PROFILE,
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
    expect(c.BASE_SALE).toBe(1_500_000n * USDC)
    expect(c.MAX_SALE).toBe(1_500_000n * USDC)
    expect(c.ELASTIC_TRIGGER).toBe(1_500_000n * USDC)
    expect(c.MIN_SALE).toBe(250_000n * USDC)
    expect(c.ARM_PRICE).toBe(1_000_000n)
    expect(c.MAX_SEEDS).toBe(500)
    expect(c.LAUNCH_TEAM_HOP1_BUDGET).toBe(5)
    expect(c.LAUNCH_TEAM_HOP2_BUDGET).toBe(500)
    expect(c.MIN_COMMIT).toBe(50n * USDC)
    expect(c.WINDOW_DURATION).toBe(7 * DAY)
    expect(c.LAUNCH_TEAM_INVITE_PERIOD).toBe(7 * DAY)
    expect(c.CLAIM_DEADLINE_DURATION).toBe(1095 * DAY)
    expect(c.GOVERNANCE_QUIET_PERIOD).toBe(10 * DAY)
    expect(c.HOP2_BASE_FLOOR_BPS).toBe(0)
    expect(c.HOP2_EXTRA_FLOOR_BPS).toBe(0)
  })

  // WHY: hop configs drive caps, invite-slot counts and the waterfall ceilings. Known: $150k, no
  // invites; Team wallets: $0 cap, 100 invites; Invited: $10k, no invites; no stacking anywhere.
  it('matches the relaunch contract hop configs', () => {
    expect(HOP_CONFIGS_BY_PROFILE.relaunch).toEqual([
      { ceilingBps: 10000, capUsdc: 150_000n * USDC, maxInvites: 0, maxInvitesReceived: 1 },
      { ceilingBps: 10000, capUsdc: 0n, maxInvites: 100, maxInvitesReceived: 1 },
      { ceilingBps: 0, capUsdc: 10_000n * USDC, maxInvites: 0, maxInvitesReceived: 1 },
    ])
  })

  // WHY: the relaunch admits outside contributors only through team-wallet invite links, so the
  // address-invite and self-fill flows must be off; the other profiles keep them.
  it('turns off direct invites and self-fill only for the relaunch', () => {
    expect(FEATURES_BY_PROFILE.relaunch).toEqual({ directInvites: false, selfFill: false })
    expect(FEATURES_BY_PROFILE.mainnet).toEqual({ directInvites: true, selfFill: true })
    expect(FEATURES_BY_PROFILE.medi).toEqual({ directInvites: true, selfFill: true })
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
