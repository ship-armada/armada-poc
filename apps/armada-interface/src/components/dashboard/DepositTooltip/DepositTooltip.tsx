// ABOUTME: Callout card guiding users into the shielded pool; doubles as an earn/APY banner via optional props.
// ABOUTME: Ported from the armada-app design mockup.
import type { ComponentType, SVGProps } from 'react'
import { InformationCircleIcon, PlusIcon } from '@heroicons/react/24/outline'
import { IconButton } from '@/design'
import { Tooltip } from '@/design'
import { TokenBadge } from '@/components/dashboard/TokenBadge'
import styles from './DepositTooltip.module.css'

const TOOLTIP_ICON_PX = 34

const DEFAULT_HEADLINE = 'Shield your USDC'
const DEFAULT_BODY =
  "Depositing into Armada's shielded pool is the first step to move funds privately."

export interface DepositTooltipProps {
  variant?: 'default' | 'v2'
  onDeposit?: () => void
  /** Info tooltip in the top-right (earn APY banner). */
  infoTooltip?: string
  headline?: string
  hideHeadline?: boolean
  body?: string
  ariaLabel?: string
  BadgeIcon?: ComponentType<SVGProps<SVGSVGElement>>
  /** `white` = solid white badge (earn APY card). Default is the brand gradient. */
  badgeBackground?: 'brand' | 'white'
  /** Icon tile fill. Earn uses purple; deposit uses amber. */
  iconTileTone?: 'amber' | 'purple'
  stretch?: boolean
  className?: string
}

export function DepositTooltip({
  onDeposit,
  infoTooltip,
  headline = DEFAULT_HEADLINE,
  hideHeadline = false,
  body = DEFAULT_BODY,
  ariaLabel,
  BadgeIcon = PlusIcon,
  badgeBackground = 'brand',
  iconTileTone = 'amber',
  stretch = false,
  className,
}: DepositTooltipProps) {
  const hasInfoTooltip = Boolean(infoTooltip)
  const wrapAsButton = Boolean(onDeposit) && !hasInfoTooltip
  const accessibleName = ariaLabel ?? headline

  const rootClassName = [
    styles.root,
    stretch && styles.stretch,
    wrapAsButton && styles.rootInteractive,
    hasInfoTooltip && styles.rootDismissable,
    className,
  ]
    .filter(Boolean)
    .join(' ')

  const content = (
    <>
      <div className={[
        styles.iconTile,
        iconTileTone === 'purple' && styles.iconTilePurple,
        (wrapAsButton || hasInfoTooltip) && styles.iconTileStatic,
      ].filter(Boolean).join(' ')}>
        <div className={styles.iconCluster} aria-hidden>
          <div className={styles.tokenBadgeSlot}>
            <TokenBadge size={TOOLTIP_ICON_PX} />
          </div>
          <div className={styles.depositButtonSlot}>
            <span
              className={[styles.depositIcon, badgeBackground === 'white' && styles.depositIconWhite]
                .filter(Boolean)
                .join(' ')}
              aria-hidden
            >
              <BadgeIcon className={styles.depositIconGlyph} strokeWidth={1.5} />
            </span>
          </div>
        </div>
      </div>

      <div className={styles.textBlock}>
        {hideHeadline ? null : <p className={styles.headline}>{headline}</p>}
        <p className={`armada-text-ui-body-sm ${styles.body}`}>{body}</p>
      </div>
    </>
  )

  const infoControl = infoTooltip ? (
    <div className={styles.dismiss}>
      <Tooltip variant="centered" content={infoTooltip}>
        <IconButton
          variant="frosted"
          size="sm"
          iconClassName={styles.dismissIcon}
          icon={<InformationCircleIcon strokeWidth={1.5} aria-hidden />}
          aria-label="About the APY estimate"
        />
      </Tooltip>
    </div>
  ) : null

  if (wrapAsButton) {
    return (
      <button
        type="button"
        className={rootClassName}
        onClick={onDeposit}
        aria-label={accessibleName}
        data-testing-click="deposit_first_button"
      >
        {content}
      </button>
    )
  }

  if (hasInfoTooltip && onDeposit) {
    return (
      <aside className={rootClassName}>
        {infoControl}
        <button
          type="button"
          className={styles.activate}
          onClick={onDeposit}
          aria-label={accessibleName}
        >
          {content}
        </button>
      </aside>
    )
  }

  return (
    <aside className={rootClassName} aria-label={accessibleName}>
      {infoControl}
      {content}
    </aside>
  )
}
