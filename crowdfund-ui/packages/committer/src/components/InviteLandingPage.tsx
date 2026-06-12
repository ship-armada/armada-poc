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
import { decodeInviteUrl, type InviteLinkData } from '@/lib/inviteLinks'
import { hasNoInviteSlots } from '@/lib/inviteSlots'
import { getHubRpcUrls } from '@/config/network'
import { loadDeployment } from '@/config/deployments'
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
// TODO: replace with the real Armada Discord invite link once it exists.
const DISCORD_URL = 'https://discord.gg'
const X_URL = 'https://x.com/ship_armada'

// Brand glyphs (Lucide dropped brand icons; inline the official Simple Icons paths).
function DiscordIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="currentColor" aria-hidden="true">
      <path d="M20.317 4.3698a19.7913 19.7913 0 0 0-4.8851-1.5152.0741.0741 0 0 0-.0785.0371c-.211.3753-.4447.8648-.6083 1.2495-1.8447-.2762-3.68-.2762-5.4868 0-.1636-.3933-.4058-.8742-.6177-1.2495a.077.077 0 0 0-.0785-.037 19.7363 19.7363 0 0 0-4.8852 1.515.0699.0699 0 0 0-.0321.0277C.5334 9.0458-.319 13.5799.0992 18.0578a.0824.0824 0 0 0 .0312.0561c2.0528 1.5076 4.0413 2.4228 5.9929 3.0294a.0777.0777 0 0 0 .0842-.0276c.4616-.6304.8731-1.2952 1.226-1.9942a.076.076 0 0 0-.0416-.1057c-.6528-.2476-1.2743-.5495-1.8722-.8923a.077.077 0 0 1-.0076-.1277c.1258-.0943.2517-.1923.3718-.2914a.0743.0743 0 0 1 .0776-.0105c3.9278 1.7933 8.18 1.7933 12.0614 0a.0739.0739 0 0 1 .0785.0095c.1202.099.246.1981.3728.2924a.077.077 0 0 1-.0066.1276 12.2986 12.2986 0 0 1-1.873.8914.0766.0766 0 0 0-.0407.1067c.3604.698.7719 1.3628 1.225 1.9932a.076.076 0 0 0 .0842.0286c1.961-.6067 3.9495-1.5219 6.0023-3.0294a.077.077 0 0 0 .0313-.0552c.5004-5.177-.8382-9.6739-3.5485-13.6604a.061.061 0 0 0-.0312-.0286zM8.02 15.3312c-1.1825 0-2.1569-1.0857-2.1569-2.419 0-1.3332.9555-2.4189 2.157-2.4189 1.2108 0 2.1757 1.0952 2.1568 2.419 0 1.3332-.9555 2.4189-2.1569 2.4189zm7.9748 0c-1.1825 0-2.1569-1.0857-2.1569-2.419 0-1.3332.9554-2.4189 2.1569-2.4189 1.2108 0 2.1757 1.0952 2.1568 2.419 0 1.3332-.946 2.4189-2.1568 2.4189Z" />
    </svg>
  )
}

function XIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="currentColor" aria-hidden="true">
      <path d="M18.901 1.153h3.68l-8.04 9.19L24 22.846h-7.406l-5.8-7.584-6.638 7.584H.474l8.6-9.83L0 1.154h7.594l5.243 6.932ZM17.61 20.644h2.039L6.486 3.24H4.298Z" />
    </svg>
  )
}

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
  // Crowdfund `windowEnd` (epoch seconds) populated by the pre-check effect
  // below — drives the live "X DAYS LEFT" label on the landing card so it
  // reflects on-chain truth instead of a placeholder.
  const [windowEndSec, setWindowEndSec] = useState<number | null>(null)

  const inviteData = useMemo<InviteLinkData | null>(
    () => decodeInviteUrl(searchParams),
    [searchParams],
  )

  const hopVariant = useMemo(
    () => (inviteData ? parseHopVariant(inviteData.fromHop) : 'hop-1'),
    [inviteData],
  )

  const daysLeft = useMemo(() => {
    // 1) Explicit `?days=N` URL override always wins (used for screenshots /
    //    showcase). 2) Live on-chain `windowEnd` once the pre-check resolved.
    // 3) Fall back to a small constant while loading so the card doesn't
    //    flash "—" or render half-blank on first paint.
    const raw = searchParams.get('days')
    const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN
    if (Number.isFinite(parsed) && parsed > 0) return parsed
    if (windowEndSec !== null) {
      const nowSec = Math.floor(Date.now() / 1000)
      const remainingSec = windowEndSec - nowSec
      if (remainingSec <= 0) return 0
      return Math.max(1, Math.ceil(remainingSec / 86400))
    }
    return DEFAULT_DAYS_LEFT
  }, [searchParams, windowEndSec])

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
            daysLeft={daysLeft}
            onJoin={() => setJoined(true)}
          />
        )}

        {!joined && !preCheckLoading && footer}
      </div>
    </div>
  )
}
