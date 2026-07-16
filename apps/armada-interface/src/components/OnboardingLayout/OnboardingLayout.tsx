// ABOUTME: Full-viewport two-panel onboarding shell — decorative brand graphic + step content area.

import type { ReactNode } from 'react'
import styles from './OnboardingLayout.module.css'

export interface OnboardingLayoutProps {
  children: ReactNode
  /** Mobile-only: show the Armada logo row above content. */
  showMobileLogo?: boolean
}

export function OnboardingLayout({ children, showMobileLogo = true }: OnboardingLayoutProps) {
  return (
    <div className={styles.root}>
      <aside
        className={[
          styles.brandPanel,
          !showMobileLogo && styles.brandPanelMobileHidden,
        ]
          .filter(Boolean)
          .join(' ')}
        aria-hidden="true"
      >
        {showMobileLogo ? (
          <div className={styles.mobileBrandRow}>
            <img
              className={styles.mobileLogo}
              src="/assets/armada-logo-lockup-white.png"
              alt="ARMADA"
              decoding="async"
            />
          </div>
        ) : null}
        <div className={styles.brandCard}>
          <img
            className={styles.symbol}
            src="/assets/symbol-white.svg"
            alt=""
            decoding="async"
          />
          <img
            className={styles.wordmark}
            src="/assets/armada-wordmark.svg"
            alt="ARMADA"
            decoding="async"
          />
        </div>
      </aside>
      <div
        className={[
          styles.contentPanel,
          !showMobileLogo && styles.contentPanelNoLogo,
        ]
          .filter(Boolean)
          .join(' ')}
      >
        <div className={styles.contentInner}>{children}</div>
      </div>
    </div>
  )
}
