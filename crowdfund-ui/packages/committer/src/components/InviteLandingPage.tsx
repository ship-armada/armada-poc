// ABOUTME: /invite landing page — designer's standalone chrome (logo + Step0Invite landing card + footer) running URL pre-validation and mounting the inline Path 1 flow controller on Join.
// ABOUTME: Replaces the legacy InviteLinkRedemption page entirely; preserves its URL parsing, nonce / slots / deadline pre-checks, and approve + commitWithInvite tx pipeline through the new step machine.

import { useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { JsonRpcProvider, Contract } from 'ethers'
// `Button` is dormant alongside the commented-out landing footer below;
// restore it here when re-enabling the project / crowdfund nav.
import { ArmadaLogo } from '@armada/ui'
import {
  Step0Invite,
  CROWDFUND_ABI_FRAGMENTS,
  type Step0InviteProps,
} from '@armada/crowdfund-shared'
import { InviteLinkFlowController } from '@/components/InviteLinkFlowController'
import { decodeInviteUrl, type InviteLinkData } from '@/lib/inviteLinks'
import { getHubRpcUrl } from '@/config/network'
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
// `PROJECT_URL` + `CROWDFUND_URL` are dormant alongside the commented-out
// landing footer below; restore both constants when re-enabling that nav.
// const PROJECT_URL = 'https://armada.wtf'
// const CROWDFUND_URL = import.meta.env.BASE_URL

function parseHopVariant(fromHop: number): HopVariant {
  // The invite carries the inviter's hop; the invitee joins at the next hop.
  // Step0's landing card visualizes that target hop.
  if (fromHop === 0) return 'hop-1'
  if (fromHop === 1) return 'hop-2'
  return 'hop-1'
}

export function InviteLandingPage() {
  const [searchParams] = useSearchParams()
  const [joined, setJoined] = useState(false)
  const [preCheckError, setPreCheckError] = useState<PreCheckError | null>(null)
  const [preCheckLoading, setPreCheckLoading] = useState(true)

  const inviteData = useMemo<InviteLinkData | null>(
    () => decodeInviteUrl(searchParams),
    [searchParams],
  )

  const hopVariant = useMemo(
    () => (inviteData ? parseHopVariant(inviteData.fromHop) : 'hop-1'),
    [inviteData],
  )

  const daysLeft = useMemo(() => {
    const raw = searchParams.get('days')
    const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN
    return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_DAYS_LEFT
  }, [searchParams])

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
        const provider = new JsonRpcProvider(getHubRpcUrl())
        const contract = new Contract(
          deployment.contracts.crowdfund,
          CROWDFUND_ABI_FRAGMENTS,
          provider,
        )

        const nonceUsed = (await contract.usedNonces(
          inviteData.inviter,
          inviteData.nonce,
        )) as boolean
        if (nonceUsed) {
          const revokedFilter = contract.filters.InviteNonceRevoked(
            inviteData.inviter,
            inviteData.nonce,
          )
          const revokedLogs = await contract.queryFilter(revokedFilter)
          if (!cancelled) {
            setPreCheckError(revokedLogs.length > 0 ? 'nonce_revoked' : 'nonce_consumed')
          }
          return
        }

        const remaining = (await contract.getInvitesRemaining(
          inviteData.inviter,
          inviteData.fromHop,
        )) as number
        if (remaining === 0) {
          if (!cancelled) setPreCheckError('no_slots')
          return
        }

        const windowEnd = (await contract.windowEnd()) as bigint
        const block = await provider.getBlock('latest')
        if (block && BigInt(block.timestamp) > windowEnd) {
          if (!cancelled) setPreCheckError('deadline_passed')
          return
        }

        const now = Math.floor(Date.now() / 1000)
        if (inviteData.deadline < now) {
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

  // Page-level footer is currently hidden across all apps. The JSX is preserved
  // below as a block comment — flip `footer` back to it (and restore the
  // referenced `PROJECT_URL` / `CROWDFUND_URL` usage) to bring back the
  // "Not ready to participate yet?" project + crowdfund nav.
  const footer: React.ReactNode = null
  /*
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
          onClick={() => window.location.assign(CROWDFUND_URL)}
        />
      </div>
    </footer>
  )
  */

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
