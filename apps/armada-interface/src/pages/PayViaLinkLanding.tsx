// ABOUTME: PayViaLinkLanding — the payer's view of a shared payment-request link (/pay-via-link).
// ABOUTME: Validates the link, shows amount/note/recipient + a QR, and hands off to the real Send flow.

import { useMemo, type ReactNode } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { ArmadaLogo, Button } from '@/design'
import { PaymentLinkQrCode } from '@/components/payViaLink/PaymentLinkQrCode'
import { formatUsdcAmount, parseUsdcInput, truncateArmadaAddress } from '@/lib/format'
import {
  formatPaymentLinkExpiry,
  parsePayViaLinkSearch,
  writePendingPayViaLink,
} from '@/lib/payViaLink'
import styles from './PayViaLinkLanding.module.css'

function LandingFrame({ children }: { children: ReactNode }) {
  return (
    <main className={styles.page}>
      <div className={styles.stack}>
        <div className={`${styles.logoWrap} ${styles.enter} ${styles.enterLogo}`}>
          <ArmadaLogo variant="full" markTone="deep" className={styles.logo} />
        </div>
        <div className={styles.card}>{children}</div>
      </div>
    </main>
  )
}

export function PayViaLinkLanding() {
  const navigate = useNavigate()
  const { search } = useLocation()
  const parsed = useMemo(() => parsePayViaLinkSearch(search), [search])

  function goToApp() {
    navigate('/')
  }

  function handleContinue() {
    if (parsed.status !== 'ok') return
    // Carry the request across the client navigation; the dashboard opens the Send flow prefilled.
    writePendingPayViaLink(parsed.params)
    navigate('/')
  }

  function GoToAppButton() {
    return (
      <div className={`${styles.actions} ${styles.enter} ${styles.enterCta}`}>
        <Button
          variant="secondary"
          size="lg"
          label="Go to Armada"
          showIcon={false}
          className={styles.cta}
          onClick={goToApp}
        />
      </div>
    )
  }

  if (parsed.status === 'invalid') {
    return (
      <LandingFrame>
        <header className={`${styles.header} ${styles.enter} ${styles.enterTitle}`}>
          <h1 className={styles.title}>This payment link is invalid</h1>
          <p className={styles.body}>Check that the link is complete, then try again.</p>
        </header>
        <GoToAppButton />
      </LandingFrame>
    )
  }

  if (parsed.status === 'expired') {
    return (
      <LandingFrame>
        <header className={`${styles.header} ${styles.enter} ${styles.enterTitle}`}>
          <h1 className={styles.title}>This payment link expired</h1>
          <p className={styles.body}>Ask the sender for a new link to complete the payment.</p>
        </header>
        <GoToAppButton />
      </LandingFrame>
    )
  }

  if (parsed.status === 'revoked') {
    return (
      <LandingFrame>
        <header className={`${styles.header} ${styles.enter} ${styles.enterTitle}`}>
          <h1 className={styles.title}>This payment link was revoked</h1>
          <p className={styles.body}>
            The sender cancelled this request. Ask them to send a new link.
          </p>
        </header>
        <GoToAppButton />
      </LandingFrame>
    )
  }

  const { params } = parsed
  const amountLabel = params.amount
    ? formatUsdcAmount(parseUsdcInput(params.amount).value)
    : null
  const expiryLabel = formatPaymentLinkExpiry(params.expiresAt).replace(/^Expires /, 'Expire ')
  const paymentUrl = window.location.href

  return (
    <LandingFrame>
      <header className={styles.header}>
        <h1 className={`${styles.title} ${styles.enter} ${styles.enterTitle}`}>
          USDC payment request
        </h1>
        {amountLabel ? (
          <p className={`${styles.amountValue} ${styles.enter} ${styles.enterAmount}`}>
            {amountLabel}
          </p>
        ) : null}
        <p className={`${styles.body} ${styles.enter} ${styles.enterBody}`}>
          You&apos;ve been asked to send USDC privately through Armada.
        </p>
      </header>

      <div className={`${styles.enter} ${styles.enterQr}`}>
        <PaymentLinkQrCode
          value={paymentUrl}
          label="Scan to open payment request"
          className={styles.qrBox}
        />
      </div>

      <dl className={`${styles.summary} ${styles.enter} ${styles.enterSummary}`}>
        {params.note ? (
          <div className={styles.summaryRow}>
            <dt className={styles.summaryLabel}>Note</dt>
            <dd className={`${styles.summaryValue} ${styles.summaryNote}`}>{params.note}</dd>
          </div>
        ) : null}
        <div className={styles.summaryRow}>
          <dt className={styles.summaryLabel}>To</dt>
          <dd className={styles.summaryValue}>
            <span className={styles.valueWithIcon}>
              <ArmadaLogo variant="mark" markTone="deep" className={styles.armadaIcon} />
              <span>{truncateArmadaAddress(params.recipient)}</span>
            </span>
          </dd>
        </div>
        <div className={styles.summaryRow}>
          <dt className={styles.summaryLabel}>Expires</dt>
          <dd className={styles.expiryPill}>{expiryLabel}</dd>
        </div>
      </dl>

      <div className={`${styles.actions} ${styles.enter} ${styles.enterCta}`}>
        <Button
          variant="primary"
          size="lg"
          label="Continue to pay"
          showIcon={false}
          className={styles.cta}
          onClick={handleContinue}
        />
      </div>
    </LandingFrame>
  )
}
