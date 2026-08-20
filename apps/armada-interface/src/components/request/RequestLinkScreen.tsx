// ABOUTME: RequestLinkScreen — shows the generated pay-via-link with Copy + a (disabled) Revoke, plus a wired-ready "Link revoked" variant.
// ABOUTME: Revoke needs shared backend state to actually work, so its trigger is disabled ("coming soon") until that lands.

import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Button, modalStepBodyEnter, modalActionRowEnter } from '@/design'
import { formatUsdcAmount, parseUsdcInput } from '@/lib/format'
import { formatPaymentLinkExpiry } from '@/lib/payViaLink'
import styles from './RequestLinkScreen.module.css'

const COPY_FEEDBACK_MS = 2000

function formatExpireInLabel(expiresAt: number): string {
  const relative = formatPaymentLinkExpiry(expiresAt)
  if (relative === 'Expired') return 'Expired'
  return relative.replace(/^Expires /, 'Expire ')
}

/** Middle-truncates a long URL (head…tail) to fit its container, remeasuring on resize. */
function LinkDisplay({ url }: { url: string }) {
  const containerRef = useRef<HTMLParagraphElement>(null)
  const rulerRef = useRef<HTMLSpanElement>(null)
  const [parts, setParts] = useState<{ head: string; tail: string; truncated: boolean }>({
    head: url,
    tail: '',
    truncated: false,
  })

  useLayoutEffect(() => {
    const container = containerRef.current
    const ruler = rulerRef.current
    if (!container || !ruler) return

    const ellipsis = '…'
    const measure = (value: string) => {
      ruler.textContent = value
      return ruler.getBoundingClientRect().width
    }

    const fit = () => {
      const available = container.clientWidth
      if (!available || measure(url) <= available) {
        setParts({ head: url, tail: '', truncated: false })
        return
      }
      let headLen = 1
      let tailLen = 1
      while (headLen + tailLen < url.length) {
        const width = measure(url.slice(0, headLen)) + measure(ellipsis) + measure(url.slice(url.length - tailLen))
        if (width > available) break
        headLen += 1
        tailLen += 1
      }
      headLen = Math.max(1, headLen - 1)
      tailLen = Math.max(1, tailLen - 1)
      setParts({ head: url.slice(0, headLen), tail: url.slice(url.length - tailLen), truncated: true })
    }

    fit()
    const observer = new ResizeObserver(fit)
    observer.observe(container)
    return () => observer.disconnect()
  }, [url])

  return (
    <p ref={containerRef} className={styles.linkValue} title={url}>
      <span ref={rulerRef} className={styles.linkRuler} aria-hidden />
      {parts.truncated ? (
        <>
          <span className={styles.linkStart}>{parts.head}</span>
          <span className={styles.linkEllipsis} aria-hidden>
            …
          </span>
          <span className={styles.linkEnd}>{parts.tail}</span>
        </>
      ) : (
        url
      )}
    </p>
  )
}

export interface RequestLinkScreenProps {
  paymentLink: string
  amount?: string
  expiresAt: number
  /** Rendered as the "Link revoked" terminal screen. Never true today (revoke is disabled). */
  revoked: boolean
  onDone: () => void
}

export function RequestLinkScreen({
  paymentLink,
  amount,
  expiresAt,
  revoked,
  onDone,
}: RequestLinkScreenProps) {
  const [linkCopied, setLinkCopied] = useState(false)
  const linkCopyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const amountLabel = amount ? formatUsdcAmount(parseUsdcInput(amount).value) : null
  const expiryLabel = formatExpireInLabel(expiresAt)

  async function handleCopyLink() {
    try {
      await navigator.clipboard.writeText(paymentLink)
      setLinkCopied(true)
      if (linkCopyTimerRef.current) clearTimeout(linkCopyTimerRef.current)
      linkCopyTimerRef.current = setTimeout(() => setLinkCopied(false), COPY_FEEDBACK_MS)
    } catch {
      // clipboard unavailable
    }
  }

  useEffect(
    () => () => {
      if (linkCopyTimerRef.current) clearTimeout(linkCopyTimerRef.current)
    },
    [],
  )

  // Wired-ready terminal screen — reachable once real (backend-backed) revocation lands.
  if (revoked) {
    return (
      <div className={styles.column}>
        <div className={`${styles.header} ${modalStepBodyEnter}`}>
          <h1 className={styles.title}>Link revoked</h1>
          <p className={styles.lede}>This payment link no longer works. Create a new one anytime.</p>
        </div>
        <div className={`${styles.buttonRow} ${modalActionRowEnter}`}>
          <Button
            variant="secondary"
            size="lg"
            label="Done"
            showIcon={false}
            className={styles.doneButton}
            onClick={onDone}
          />
        </div>
      </div>
    )
  }

  return (
    <div className={styles.column}>
      <header className={styles.header}>
        <h1 className={`${styles.title} ${styles.enter} ${styles.enterTitle}`}>
          USDC payment request
        </h1>
        {amountLabel ? (
          <span className={`${styles.amountValue} ${styles.enter} ${styles.enterAmount}`}>
            {amountLabel}
          </span>
        ) : null}
      </header>

      <div className={styles.linkSection}>
        <div className={`${styles.linkHeading} ${styles.enter} ${styles.enterShareRow}`}>
          <p className={styles.linkHeadingLabel}>Share this link</p>
          <p className={styles.expiryPill}>{expiryLabel}</p>
        </div>
        <div className={`${styles.linkBox} ${styles.enter} ${styles.enterLinkBox}`}>
          <LinkDisplay url={paymentLink} />
        </div>
        <Button
          variant="primary"
          size="md"
          label={linkCopied ? 'Copied' : 'Copy'}
          showIcon={false}
          className={`${styles.copyButton} ${styles.enter} ${styles.enterCopy}`}
          onClick={() => void handleCopyLink()}
        />
        <span className={styles.copyStatus} role="status" aria-live="polite">
          {linkCopied ? 'Link copied to clipboard' : ''}
        </span>
      </div>

      {/* Revoke is disabled until backend-backed revocation exists — a session-local flag can't stop
          a payer who already has the link, so we don't ship a fake that implies it can. */}
      <div className={`${styles.revokeRow} ${styles.enter} ${styles.enterRevoke}`}>
        <button type="button" className={styles.revokeLink} disabled aria-disabled="true">
          Revoke link
        </button>
        <span className={styles.revokeSoon}>Coming soon</span>
      </div>
    </div>
  )
}
