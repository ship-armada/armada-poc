// ABOUTME: /invite landing page — designer's standalone chrome (logo + Step0Invite landing card + footer) running URL pre-validation and mounting the inline Path 1 flow controller on Join.
// ABOUTME: Replaces the legacy InviteLinkRedemption page entirely; preserves its URL parsing, nonce / slots / deadline pre-checks, and approve + commitWithInvite tx pipeline through the new step machine.

import { useEffect, useMemo, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { Contract } from 'ethers'
import { ArmadaLogo, Button } from '@armada/ui'
import {
  Step0Invite,
  CROWDFUND_ABI_FRAGMENTS,
  createProvider,
  type Step0InviteProps,
} from '@armada/crowdfund-shared'
import { InviteLinkFlowController } from '@/components/InviteLinkFlowController'
import { DiscordIcon, XIcon } from '@/components/SocialIcons'
import { decodeInviteUrl, type InviteLinkData } from '@/lib/inviteLinks'
import { hasNoInviteSlots } from '@/lib/inviteSlots'
import { getHubRpcUrls } from '@/config/network'
import { loadDeployment } from '@/config/deployments'
import { DISCORD_URL, X_URL } from '@/config/socials'
import styles from './InviteLanding.module.css'

type HopVariant = Step0InviteProps['hopVariant']

type PreCheckError =
  | 'expired'
  | 'nonce_consumed'
  | 'nonce_revoked'
  | 'no_slots'
  | 'deadline_passed'

const PRE_CHECK_MESSAGES: Record<PreCheckError, string> = {
  expired: 'This invite link has expired. Ask the inviter for a new link.',
  nonce_consumed: 'This invite link has already been used by someone else.',
  nonce_revoked: 'This invite link has been revoked by the inviter.',
  no_slots: 'The inviter has no remaining invite slots.',
  deadline_passed: 'The commitment deadline has passed.',
}

const DEFAULT_DAYS_LEFT = 3
const PROJECT_URL = 'https://armada.wtf'

function parseHopVariant(fromHop: number): HopVariant {
  // The invite carries the inviter's hop; the invitee joins at the next hop.
  // Step0's landing card visualizes that target hop.
  if (fromHop === 0) return 'hop-1'
  if (fromHop === 1) return 'hop-2'
  return 'hop-1'
}

export function InviteLandingPage() {
  const [searchParams] = useSearchParams()
  const navigate = useNavigate()
  const [joined, setJoined] = useState(false)
  const [preCheckError, setPreCheckError] = useState<PreCheckError | null>(null)
  const [preCheckLoading, setPreCheckLoading] = useState(true)
  // Crowdfund `windowEnd` and the chain block timestamp at pre-check time (both
  // epoch seconds), populated by the pre-check effect below. Together they drive
  // the "TIME LEFT" label on the landing card from the same chain clock the main
  // crowdfund page uses — not the browser's local clock — so the two agree.
  const [windowEndSec, setWindowEndSec] = useState<number | null>(null)
  const [blockTimestampSec, setBlockTimestampSec] = useState<number | null>(null)

  const inviteData = useMemo<InviteLinkData | null>(
    () => decodeInviteUrl(searchParams),
    [searchParams],
  )

  const hopVariant = useMemo(
    () => (inviteData ? parseHopVariant(inviteData.fromHop) : 'hop-1'),
    [inviteData],
  )

  const secondsLeft = useMemo(() => {
    // 1) Explicit `?days=N` URL override always wins (used for screenshots /
    //    showcase) — N whole days expressed in seconds. 2) Live on-chain
    //    `windowEnd` minus the chain block timestamp once the pre-check resolved
    //    (same clock as the main crowdfund page). 3) Fall back to a small
    //    constant while loading so the card doesn't render half-blank on first
    //    paint. Step0Invite floors/ceils nothing — the shared formatTimeLeft
    //    helper handles the day-vs-hour formatting uniformly.
    const raw = searchParams.get('days')
    const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN
    if (Number.isFinite(parsed) && parsed > 0) return parsed * 86400
    if (windowEndSec !== null && blockTimestampSec !== null) {
      return Math.max(0, windowEndSec - blockTimestampSec)
    }
    return DEFAULT_DAYS_LEFT * 86400
  }, [searchParams, windowEndSec, blockTimestampSec])

  // Pre-redemption nonce + slot + deadline validation. Mirrors the legacy
  // InviteLinkRedemption useEffect — surfaces the same four failure modes so
  // an invalid invite is communicated before the user clicks Join.
  useEffect(() => {
    if (!inviteData) {
      setPreCheckLoading(false)
      return
    }
    let cancelled = false
    const check = async () => {
      setPreCheckLoading(true)
      try {
        const deployment = await loadDeployment()
        const provider = createProvider(getHubRpcUrls())
        const contract = new Contract(
          deployment.contracts.crowdfund,
          CROWDFUND_ABI_FRAGMENTS,
          provider,
        )

        // Read `windowEnd` up front (and stash it for the days-left label) so
        // a downstream failure on `queryFilter` below can't strand us with the
        // hardcoded 3-day fallback. Block timestamp also needed for the
        // deadline_passed check further down.
        const windowEnd = (await contract.windowEnd()) as bigint
        if (!cancelled) setWindowEndSec(Number(windowEnd))
        const block = await provider.getBlock('latest')
        // Stash the chain block time so the days-left label is anchored on the
        // same clock as the main crowdfund page (not the browser's local clock).
        if (!cancelled && block) setBlockTimestampSec(Number(block.timestamp))

        const nonceUsed = (await contract.usedNonces(
          inviteData.inviter,
          inviteData.nonce,
        )) as boolean
        if (nonceUsed) {
          // Distinguish revoked (inviter actively cancelled) from consumed
          // (someone redeemed it). `queryFilter` defaults to fromBlock=0,
          // which throws on some RPCs and times out on busy chains; scope it
          // to the deployment block and ignore failures — `nonce_consumed` is
          // a safe fallback since both states mean "the link cannot be used
          // again," and that's what the user needs to know.
          let isRevoked = false
          try {
            const revokedFilter = contract.filters.InviteNonceRevoked(
              inviteData.inviter,
              inviteData.nonce,
            )
            const revokedLogs = await contract.queryFilter(
              revokedFilter,
              deployment.deployBlock ?? 0,
              'latest',
            )
            isRevoked = revokedLogs.length > 0
          } catch {
            // Provider couldn't scan logs — treat as `nonce_consumed`. Loses
            // the revoked-vs-consumed distinction in copy, doesn't lose the
            // "this link is dead" gate that's the actual safety property.
          }
          if (!cancelled) {
            setPreCheckError(isRevoked ? 'nonce_revoked' : 'nonce_consumed')
          }
          return
        }

        const remaining = (await contract.getInvitesRemaining(
          inviteData.inviter,
          inviteData.fromHop,
        )) as bigint
        if (hasNoInviteSlots(remaining)) {
          if (!cancelled) setPreCheckError('no_slots')
          return
        }

        if (block && BigInt(block.timestamp) > windowEnd) {
          if (!cancelled) setPreCheckError('deadline_passed')
          return
        }

        // Use the chain's block time (already fetched above) for the deadline
        // check too — a skewed local clock shouldn't falsely expire an invite.
        const nowSec = block ? Number(block.timestamp) : Math.floor(Date.now() / 1000)
        if (inviteData.deadline < nowSec) {
          if (!cancelled) setPreCheckError('expired')
          return
        }

        if (!cancelled) setPreCheckError(null)
      } catch {
        // Non-fatal — the tx itself will surface anything pre-check missed.
        if (!cancelled) setPreCheckError(null)
      } finally {
        if (!cancelled) setPreCheckLoading(false)
      }
    }
    check()
    return () => { cancelled = true }
  }, [inviteData])

  // "Not ready to participate yet?" nav + socials, shown on the landing/error
  // states (hidden once the user joins the flow).
  const footer = (
    <footer className={styles.footer}>
      <p className={styles.footerPrompt}>Not ready to participate yet?</p>
      <div className={styles.footerNav}>
        <Button
          variant="secondary"
          size="lg"
          label="The project"
          showIcon={false}
          className={styles.footerBtn}
          onClick={() => window.open(PROJECT_URL, '_blank', 'noopener,noreferrer')}
        />
        <Button
          variant="secondary"
          size="lg"
          label="Crowdfund"
          showIcon={false}
          className={styles.footerBtn}
          onClick={() => navigate('/')}
        />
      </div>
      <div className={styles.socials}>
        <a
          className={styles.socialLink}
          href={DISCORD_URL}
          target="_blank"
          rel="noopener noreferrer"
          aria-label="Armada on Discord"
        >
          <DiscordIcon className={styles.socialIcon} />
        </a>
        <a
          className={styles.socialLink}
          href={X_URL}
          target="_blank"
          rel="noopener noreferrer"
          aria-label="Armada on X"
        >
          <XIcon className={styles.socialIcon} />
        </a>
      </div>
    </footer>
  )

  // Malformed URL — missing required params. Show the same wording as the
  // legacy page so external links land cleanly.
  if (!inviteData) {
    return (
      <div className={styles.page}>
        <div className={styles.logo}>
          <ArmadaLogo />
        </div>
        <div className={styles.stack}>
          <div className={styles.errorCard}>
            <h1 className={styles.errorTitle}>Invalid invite link</h1>
            <p className={styles.errorBody}>
              This link is missing required parameters. Ask the inviter for a fresh link.
            </p>
          </div>
          {footer}
        </div>
      </div>
    )
  }

  // Pre-check failure — render the matching message and let the user bounce
  // back to the crowdfund or project page.
  if (preCheckError) {
    return (
      <div className={styles.page}>
        <div className={styles.logo}>
          <ArmadaLogo />
        </div>
        <div className={styles.stack}>
          <div className={styles.errorCard}>
            <h1 className={styles.errorTitle}>Invite unavailable</h1>
            <p className={styles.errorBody}>{PRE_CHECK_MESSAGES[preCheckError]}</p>
          </div>
          {footer}
        </div>
      </div>
    )
  }

  // Pre-check still in flight — render a placeholder card matching the
  // landing/error card dimensions instead of falling through to the welcome
  // card, which would briefly flash before a consumed/expired/no-slots link
  // resolves to the corresponding error state above. Only relevant before the
  // user joins; once they've clicked Join we let the controller handle its
  // own loading/idle state.
  if (preCheckLoading && !joined) {
    return (
      <div className={styles.page}>
        <div className={styles.logo}>
          <ArmadaLogo />
        </div>
        <div className={styles.stack}>
          <div
            className={styles.loadingCard}
            role="status"
            aria-live="polite"
            aria-label="Checking invite link"
          >
            <div className={styles.loadingSpinner} aria-hidden="true" />
            <p className={styles.loadingLabel}>Checking invite…</p>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className={styles.page}>
      <div className={styles.logo}>
        <ArmadaLogo />
      </div>

      <div className={styles.stack}>
        {joined ? (
          <InviteLinkFlowController inviteData={inviteData} />
        ) : (
          <Step0Invite
            variant="landing"
            hopVariant={hopVariant}
            secondsLeft={secondsLeft}
            onJoin={() => setJoined(true)}
          />
        )}

        {!joined && !preCheckLoading && footer}
      </div>
    </div>
  )
}
