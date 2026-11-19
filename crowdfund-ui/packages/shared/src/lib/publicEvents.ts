// ABOUTME: Public (participant-facing) view of the crowdfund event stream. Under profiles that hide team
// ABOUTME: inviter wallets (the relaunch), drops those wallets and attributes their invites to the Armada root.

import { CROWDFUND_FEATURES } from './constants.js'
import type { CrowdfundEvent } from './events.js'

const lower = (value: unknown): string => String(value).toLowerCase()

/**
 * The event stream as participant-facing views should show it.
 *
 * On the relaunch the launch team brings outside contributors in through invite links signed by
 * team-owned wallets placed at hop 1 (a link places the redeemer one hop below the signer). Those
 * wallets are an implementation detail: publicly every hop-2 contributor is a launch-team invite.
 * When `hide` is on, this:
 *   - drops every hop-1 placement, commit and per-hop allocation (the team wallets' nodes);
 *   - rewrites a team wallet's hop-2 `Invited` as a `LaunchTeamInvited`, so the invitee hangs off
 *     the Armada root exactly like a direct placement;
 *   - drops events whose actor is a team wallet with no public position (link revocations, and
 *     claims or refunds of a mistaken team-wallet commit).
 * A team wallet that also holds a hop-0 or hop-2 slot keeps that public position.
 *
 * Build the public graph with `buildGraph(toPublicEvents(events))`. Logic that needs the real
 * structure (eligibility, invite slots, the indexer, reconciliation, the admin app) uses the raw
 * stream. With `hide` off the input is returned unchanged.
 */
export function toPublicEvents(
  events: CrowdfundEvent[],
  hide: boolean = CROWDFUND_FEATURES.hideTeamWallets,
): CrowdfundEvent[] {
  if (!hide) return events

  // Only the launch team can create hop-1 nodes in a team-wallet profile, so every hop-1 invitee
  // is a team wallet.
  const teamWallets = new Set<string>()
  const publicAddresses = new Set<string>()
  for (const e of events) {
    if (e.type === 'SeedAdded') publicAddresses.add(lower(e.args.seed))
    if (e.type === 'LaunchTeamInvited' || e.type === 'Invited') {
      if (Number(e.args.hop) === 1) teamWallets.add(lower(e.args.invitee))
      else publicAddresses.add(lower(e.args.invitee))
    }
  }
  if (teamWallets.size === 0) return events

  const out: CrowdfundEvent[] = []
  for (const e of events) {
    switch (e.type) {
      case 'LaunchTeamInvited':
      case 'Committed':
      case 'AllocatedHop':
        if (Number(e.args.hop) === 1) continue
        out.push(e)
        break
      case 'Invited':
        if (Number(e.args.hop) === 1) continue
        if (teamWallets.has(lower(e.args.inviter))) {
          out.push({ ...e, type: 'LaunchTeamInvited', args: { invitee: e.args.invitee, hop: e.args.hop } })
          continue
        }
        out.push(e)
        break
      case 'Allocated':
      case 'RefundClaimed': {
        const participant = lower(e.args.participant)
        if (teamWallets.has(participant) && !publicAddresses.has(participant)) continue
        out.push(e)
        break
      }
      case 'InviteNonceRevoked':
        if (teamWallets.has(lower(e.args.inviter))) continue
        out.push(e)
        break
      default:
        out.push(e)
    }
  }
  return out
}
