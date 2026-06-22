// ABOUTME: Pill-shaped button primitive with primary/secondary/ghost/gradient variants and three sizes.
// ABOUTME: Ported byte-identical from the armada-crowdfund mockup; restyle via tokens, not edits here.

import { ArrowRightIcon as ArrowRightMicroIcon } from '@heroicons/react/16/solid'
import { ArrowRightIcon } from '@heroicons/react/24/outline'
import styles from './Button.module.css'

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'gradient'
export type ButtonSize = 'sm' | 'md' | 'lg'
export type ButtonIcon = 'arrow-right' | 'arrow-right-micro'

export interface ButtonProps {
  variant?: ButtonVariant
  size?: ButtonSize
  label?: string
  showIcon?: boolean
  /** Default `arrow-right`, or `arrow-right-micro` for Participate CTAs (Heroicons 16/solid). */
  icon?: ButtonIcon
  disabled?: boolean
  onClick?: () => void
  style?: React.CSSProperties
  className?: string
  type?: 'button' | 'submit' | 'reset'
}

const ICON_PX: Record<ButtonSize, number> = { sm: 14, md: 16, lg: 18 }
const MICRO_ICON_PX = 16

function resolveIcon(label: string, icon: ButtonIcon | undefined, showIcon: boolean): ButtonIcon {
  if (!showIcon) return 'arrow-right'
  if (icon) return icon
  if (label.trim().toLowerCase() === 'participate') return 'arrow-right-micro'
  return 'arrow-right'
}

export function Button({
  variant = 'primary',
  size = 'md',
  label = 'Button',
  showIcon = true,
  icon,
  disabled = false,
  onClick,
  className,
  type = 'button',
  style,
}: ButtonProps) {
  const resolvedIcon = resolveIcon(label, icon, showIcon)
  const iconPx = resolvedIcon === 'arrow-right-micro' ? MICRO_ICON_PX : ICON_PX[size]

  const cls = [styles.btn, styles[variant], styles[size], !showIcon && styles.noIcon, className ?? '']
    .filter(Boolean)
    .join(' ')

  return (
    <button type={type} className={cls} disabled={disabled} onClick={onClick} style={style}>
      <span>{label}</span>
      {showIcon && (
        <span className={styles.iconWrap} aria-hidden>
          {resolvedIcon === 'arrow-right-micro' ? (
            <ArrowRightMicroIcon className={styles.iconSvg} width={iconPx} height={iconPx} />
          ) : (
            <ArrowRightIcon className={styles.iconSvg} width={iconPx} height={iconPx} />
          )}
        </span>
      )}
    </button>
  )
}
