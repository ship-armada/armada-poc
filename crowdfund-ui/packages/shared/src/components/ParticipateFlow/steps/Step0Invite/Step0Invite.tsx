// ABOUTME: Invite landing card — full-bleed fleet video + hop pill + Join CTA. Supports `default` (modal) and `landing` (full-page invite) variants.
// ABOUTME: Ported from the armada-crowdfund mockup; fleet assets are ESM-imported so they bundle with crowdfund-shared (no public-folder dependency in the consuming app).

import { useEffect, useState } from 'react'
import HopPill, { type HopVariant } from '../../../HopPill/HopPill'
import hopPillStyles from '../../../HopPill/HopPill.module.css'
import JoinButton from '../../../JoinButton/JoinButton'
import { formatTimeLeft } from '../../../../lib/format.js'
import fleetMp4 from '../../../../assets/fleet.mp4'
import fleetPng from '../../../../assets/fleet.png'
import styles from './Step0Invite.module.css'

const HOVER_EXPAND_QUERY = '(hover: hover) and (pointer: fine)'

export interface Step0InviteProps {
  hopVariant?: HopVariant
  /** Seconds remaining in the commit window. Rendered via the shared
   *  {@link formatTimeLeft} helper so the splash agrees with the stats banner
   *  and progress tag: whole days until under one day, then hours/minutes. */
  secondsLeft?: number
  /** Seconds until *this invite link* expires (Path 1 landing only). Rendered
   *  as a secondary line under the headline, distinct from the campaign
   *  `secondsLeft` countdown in the meta row. Omit in the modal variants. */
  inviteExpiresInSeconds?: number
  onJoin: () => void
  /** Path 2/3 modal: wallet already connected — hide pre-connect eyebrow. */
  hideConnectEyebrow?: boolean
  /** Path 1 invite landing page layout and sizing. */
  variant?: 'default' | 'landing'
  className?: string
}

export default function Step0Invite({
  hopVariant = 'hop-1',
  secondsLeft = 3 * 86400,
  inviteExpiresInSeconds,
  onJoin,
  hideConnectEyebrow = false,
  variant = 'default',
  className,
}: Step0InviteProps) {
  const [joinExpanded, setJoinExpanded] = useState(false)
  const [canHoverExpand, setCanHoverExpand] = useState(false)
  const isLanding = variant === 'landing'

  useEffect(() => {
    const media = window.matchMedia(HOVER_EXPAND_QUERY)
    const sync = () => setCanHoverExpand(media.matches)
    sync()
    media.addEventListener('change', sync)
    return () => media.removeEventListener('change', sync)
  }, [])

  // Uppercase to match the designer's tag styling; "ENDS TODAY" once the
  // window has closed (formatTimeLeft returns '' at <= 0).
  const timeLeftLabel =
    secondsLeft <= 0 ? 'ENDS TODAY' : `${formatTimeLeft(secondsLeft).toUpperCase()} LEFT`

  // The invite link's own expiry — a secondary line under the headline, separate
  // from the campaign "TIME LEFT" meta label. Only the Path 1 landing passes it.
  const inviteExpiryLabel =
    inviteExpiresInSeconds === undefined
      ? null
      : inviteExpiresInSeconds <= 0
        ? 'This invite has expired'
        : `This invite expires in ${formatTimeLeft(inviteExpiresInSeconds)}`

  return (
    <div
      data-flow-shell
      className={[
        styles.card,
        isLanding && styles.cardLanding,
        className,
      ]
        .filter(Boolean)
        .join(' ')}
      onMouseEnter={() => {
        if (canHoverExpand) setJoinExpanded(true)
      }}
      onMouseLeave={() => {
        if (canHoverExpand) setJoinExpanded(false)
      }}
    >
      <video
        className={styles.media}
        src={fleetMp4}
        poster={fleetPng}
        autoPlay
        loop
        muted
        playsInline
        aria-hidden
      />
      <div className={styles.overlay} />
      <div className={[styles.content, isLanding && styles.contentLanding].filter(Boolean).join(' ')}>
        <div className={styles.meta}>
          <span className={styles.metaLabel}>ARMADA CROWDFUND</span>
          <span className={styles.metaLabel}>{timeLeftLabel}</span>
        </div>
        <div className={styles.bottom}>
          <div className={styles.copy}>
            {!hideConnectEyebrow && (
              <p className={styles.eyebrow}>CONNECT YOUR WALLET</p>
            )}
            <h1 className={styles.headline}>You are invited to join the fleet</h1>
            {inviteExpiryLabel && <p className={styles.inviteExpiry}>{inviteExpiryLabel}</p>}
          </div>
          <div className={[styles.footer, isLanding && styles.footerLanding].filter(Boolean).join(' ')}>
            <HopPill
              variant={hopVariant}
              className={isLanding ? hopPillStyles.landing : undefined}
            />
            <JoinButton onClick={onJoin} expanded={joinExpanded} size={isLanding ? 'lg' : 'md'} />
          </div>
        </div>
      </div>
    </div>
  )
}
