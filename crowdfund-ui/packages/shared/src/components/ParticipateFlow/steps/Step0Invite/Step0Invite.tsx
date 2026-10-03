// ABOUTME: Invite landing card — full-bleed fleet image + hop pill + Join CTA. Supports `default` (modal) and `landing` (full-page invite) variants.
// ABOUTME: Ported from the armada-crowdfund demo (brand eyebrow, left-aligned time-left tag); fleet asset is ESM-imported so it bundles with crowdfund-shared.

import { Tag } from '@armada/ui'
import HopPill, { type HopVariant } from '../../../HopPill/HopPill'
import hopPillStyles from '../../../HopPill/HopPill.module.css'
import JoinButton from '../../../JoinButton/JoinButton'
import { formatTimeLeft } from '../../../../lib/format.js'
import fleetPng from '../../../../assets/fleet.png'
import { FlowChrome } from '../../FlowChrome'
import styles from './Step0Invite.module.css'

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
  /** Close the participate flow (top-right X on the fleet intro). */
  onClose?: () => void
  /**
   * @deprecated Wallet connect is RainbowKit before this screen — eyebrow removed.
   * Kept so existing callers keep compiling.
   */
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
  onClose,
  variant = 'default',
  className,
}: Step0InviteProps) {
  const isLanding = variant === 'landing'

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
    >
      <img
        className={styles.media}
        src={fleetPng}
        alt=""
        aria-hidden
      />
      <div className={styles.overlay} />
      {onClose ? (
        <FlowChrome
          variant="overlay"
          showBack={false}
          onClose={onClose}
          closeAriaLabel="Close participate flow"
        />
      ) : null}
      <div className={[styles.content, isLanding && styles.contentLanding].filter(Boolean).join(' ')}>
        <div className={styles.top}>
          <p className={styles.brandEyebrow}>Armada Crowdfund</p>
          <h1 className={styles.headline}>
            You are{' '}
            <br className={styles.headlineBreak} />
            invited to{' '}
            <br className={styles.headlineBreak} />
            join the fleet
          </h1>
          {inviteExpiryLabel && <p className={styles.inviteExpiry}>{inviteExpiryLabel}</p>}
          <div className={styles.metaTag}>
            <Tag label={timeLeftLabel} />
          </div>
        </div>
        <div className={[styles.footer, isLanding && styles.footerLanding].filter(Boolean).join(' ')}>
          <HopPill
            variant={hopVariant}
            className={isLanding ? hopPillStyles.landing : undefined}
          />
          <JoinButton onClick={onJoin} size={isLanding ? 'lg' : 'md'} />
        </div>
      </div>
    </div>
  )
}
