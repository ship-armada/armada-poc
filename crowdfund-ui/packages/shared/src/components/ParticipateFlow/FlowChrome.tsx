// ABOUTME: Top chrome for participate commit steps — back, title, close.
// ABOUTME: Replaces the Steps progress header after the Before you start intro.
// ABOUTME: `variant="overlay"` pins close without a header row; `titleAlign="start"` left-aligns the title.

import type { ReactNode } from 'react'
import { ArrowLeftIcon, XMarkIcon } from '@heroicons/react/24/outline'
import styles from './FlowChrome.module.css'

const ICON_PX = 16

export interface FlowChromeProps {
  /** Screen title between the controls. Omit for close-only chrome. */
  title?: ReactNode
  /** Optional id for the title heading (aria / form labels). */
  titleId?: string
  /** Title alignment in the bar. Default centers; `start` left-aligns (e.g. refund claim). */
  titleAlign?: 'center' | 'start'
  onBack?: () => void
  onClose?: () => void
  /** When false, keeps layout balance with an empty left slot (unless titleAlign is start). */
  showBack?: boolean
  backAriaLabel?: string
  closeAriaLabel?: string
  /**
   * `bar` — in-flow header row (default).
   * `overlay` — absolute corner controls; use when the title lives in the body.
   */
  variant?: 'bar' | 'overlay'
}

export function FlowChrome({
  title,
  titleId,
  titleAlign = 'center',
  onBack,
  onClose,
  showBack = true,
  backAriaLabel = 'Back',
  closeAriaLabel = 'Close participate flow',
  variant = 'bar',
}: FlowChromeProps) {
  const showBackBtn = showBack && !!onBack
  const hasTitle = title != null && title !== ''
  const titleStart = titleAlign === 'start'

  if (variant === 'overlay') {
    return (
      <div className={styles.overlay}>
        {showBackBtn ? (
          <button
            type="button"
            className={[styles.iconBtn, styles.overlayBack].join(' ')}
            onClick={onBack}
            aria-label={backAriaLabel}
          >
            <ArrowLeftIcon width={ICON_PX} height={ICON_PX} aria-hidden />
          </button>
        ) : null}
        {onClose ? (
          <button
            type="button"
            className={[styles.iconBtn, styles.overlayClose].join(' ')}
            onClick={onClose}
            aria-label={closeAriaLabel}
          >
            <XMarkIcon width={ICON_PX} height={ICON_PX} aria-hidden />
          </button>
        ) : null}
      </div>
    )
  }

  return (
    <div
      className={[
        styles.bar,
        hasTitle ? styles.barWithTitle : undefined,
        titleStart && !showBackBtn ? styles.barTitleStart : undefined,
      ]
        .filter(Boolean)
        .join(' ')}
    >
      {showBackBtn ? (
        <button
          type="button"
          className={styles.iconBtn}
          onClick={onBack}
          aria-label={backAriaLabel}
        >
          <ArrowLeftIcon width={ICON_PX} height={ICON_PX} aria-hidden />
        </button>
      ) : titleStart ? null : (
        <span className={styles.spacer} aria-hidden />
      )}
      {hasTitle ? (
        <h2
          id={titleId}
          className={[styles.title, titleStart ? styles.titleStart : undefined]
            .filter(Boolean)
            .join(' ')}
        >
          {title}
        </h2>
      ) : (
        <span className={styles.titleSpacer} aria-hidden />
      )}
      {onClose ? (
        <button
          type="button"
          className={styles.iconBtn}
          onClick={onClose}
          aria-label={closeAriaLabel}
        >
          <XMarkIcon width={ICON_PX} height={ICON_PX} aria-hidden />
        </button>
      ) : (
        <span className={styles.spacer} aria-hidden />
      )}
    </div>
  )
}
