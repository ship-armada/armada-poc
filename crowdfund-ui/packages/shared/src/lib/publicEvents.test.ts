// ABOUTME: Unit tests for toPublicEvents: the public (participant-facing) view of the event stream that
// ABOUTME: hides relaunch team inviter wallets and attributes their invites to the Armada root.

import { describe, expect, it } from 'vitest'
import { toPublicEvents } from './publicEvents.js'
import { buildGraph } from './graph.js'
import type { CrowdfundEvent } from './events.js'

const TEAM = '0x00000000000000000000000000000000000000aa'
const SEED = '0x00000000000000000000000000000000000000bb'
const OUTSIDER = '0x00000000000000000000000000000000000000cc'
const PLACED = '0x00000000000000000000000000000000000000dd'
const LAUNCH_TEAM = '0x00000000000000000000000000000000000000ee'

let log = 0
function ev(type: CrowdfundEvent['type'], args: Record<string, unknown>, tx = `0xtx${log}`): CrowdfundEvent {
  log += 1
  return { type, blockNumber: log, transactionHash: tx, logIndex: log, args }
}

/** A relaunch-shaped stream: one seed, one team wallet placed by the launch team (with its
 *  contract-emitted Invited shadow), a link invite from the team wallet, and a direct placement. */
function stream(): CrowdfundEvent[] {
  return [
    ev('SeedAdded', { seed: SEED }),
    ev('LaunchTeamInvited', { invitee: TEAM, hop: 1 }, '0xteam'),
    ev('Invited', { inviter: LAUNCH_TEAM, invitee: TEAM, hop: 1, nonce: 0n }, '0xteam'),
    ev('Invited', { inviter: TEAM, invitee: OUTSIDER, hop: 2, nonce: 7n }, '0xlink'),
    // Amounts stay under every profile's hop-2 cap (tests run on the mainnet profile: $1k).
    ev('Committed', { participant: OUTSIDER, hop: 2, amount: 500_000_000n }, '0xlink'),
    ev('LaunchTeamInvited', { invitee: PLACED, hop: 2 }, '0xplace'),
    ev('Invited', { inviter: LAUNCH_TEAM, invitee: PLACED, hop: 2, nonce: 0n }, '0xplace'),
    ev('InviteNonceRevoked', { inviter: TEAM, nonce: 9n }),
    ev('Committed', { participant: SEED, hop: 0, amount: 1_000_000n }),
  ]
}

describe('toPublicEvents', () => {
  // WHY: team inviter wallets exist only because invite links place the redeemer one hop below the
  // signer. Publicly the relaunch has two tiers, so the wallets must not appear as participants.
  it('removes every team wallet node and attributes its invitees to the Armada root', () => {
    const graph = buildGraph(toPublicEvents(stream(), true))
    const keys = [...graph.nodes.keys()]
    expect(keys).not.toContain(`${TEAM}-1`)
    expect([...graph.summaries.keys()]).not.toContain(TEAM)
    expect(graph.nodes.get(`${OUTSIDER}-2`)?.invitedBy).toEqual(['armada'])
    expect(graph.edges).toContainEqual({ fromAddress: 'armada', fromHop: -1, toAddress: OUTSIDER, toHop: 2 })
    expect(graph.edges.some((e) => e.fromAddress === TEAM || e.toAddress === TEAM)).toBe(false)
  })

  // WHY: a link-invited contributor must look exactly like a direct launch-team placement.
  it('makes a team-wallet invitee indistinguishable from a direct placement', () => {
    const graph = buildGraph(toPublicEvents(stream(), true))
    expect(graph.summaries.get(OUTSIDER)?.displayInviter).toBe('armada')
    expect(graph.summaries.get(PLACED)?.displayInviter).toBe('armada')
    expect(graph.nodes.get(`${OUTSIDER}-2`)?.committed).toBe(500_000_000n)
  })

  // WHY: the public event log is built from the same stream; a revocation by a team wallet would name it.
  it('drops events that name a team wallet as the actor', () => {
    const out = toPublicEvents(stream(), true)
    const mentionsTeam = out.some((e) => Object.values(e.args).some((v) => String(v).toLowerCase() === TEAM))
    expect(mentionsTeam).toBe(false)
  })

  // WHY: a team wallet that also holds a hop-2 slot (a self-invite) is a real Invited contributor
  // and stays visible at hop 2; only its hop-1 node is hidden.
  it('keeps a team wallet’s own hop-2 position', () => {
    const events = [
      ...stream(),
      ev('Invited', { inviter: TEAM, invitee: TEAM, hop: 2, nonce: 8n }, '0xself'),
      ev('Committed', { participant: TEAM, hop: 2, amount: 300_000_000n }, '0xself'),
    ]
    const graph = buildGraph(toPublicEvents(events, true))
    expect(graph.nodes.get(`${TEAM}-2`)?.committed).toBe(300_000_000n)
    expect(graph.nodes.get(`${TEAM}-2`)?.invitedBy).toEqual(['armada'])
    expect(graph.nodes.has(`${TEAM}-1`)).toBe(false)
  })

  // WHY: profiles that keep the real hop structure (Launch 1, medi) must see the stream unchanged.
  it('returns the stream unchanged when hiding is off', () => {
    const events = stream()
    expect(toPublicEvents(events, false)).toBe(events)
  })
})
