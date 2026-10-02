// ABOUTME: Step 2 of the Participate flow — USDC amount entry. Single-hop path keeps the designer's big centered input; multi-hop path stacks one input row per eligible hop with shared balance / allocation footer.
// ABOUTME: Ported from the armada-crowdfund mockup; FlowChrome replaces the Steps header and carries the screen title. MaxOutBanner + the multi-hop variant are POC extensions (designer-silent).

import { useEffect, useMemo, useState } from 'react'
import { InformationCircleIcon } from '@heroicons/react/24/solid'
import { Button, Tooltip } from '@armada/ui'
import styles from './Step2Commit.module.css'
import { FlowChrome } from '../FlowChrome'
import {
  hasActiveAmount,
  parseActiveAmount,
  sanitizeAmountInput,
  isInvalidCommaInput,
} from '../../../lib/amountInput'
import { CROWDFUND_CONSTANTS } from '../../../lib/constants'
import type { ParticipateStepBarProps } from '../participateFlowSteps'
import maxOutStyles from './MaxOutBanner.module.css'

/** Per-commit minimum (USD), from the active profile's MIN_COMMIT. The contract
 *  reverts a commit below this, so each hop's commit must individually clear it. */
const MIN_COMMIT_USD = Number(CROWDFUND_CONSTANTS.MIN_COMMIT) / 1e6

/** "Max out" affordance shown above the amount entry. When provided, renders a
 *  banner inviting the user to self-invite across all their hops and commit the
 *  maximum in a single bundled transaction. The flow controller computes the
 *  plan; this component only surfaces the headline + CTA. */
export interface Step2MaxOutOption {
  /** Theoretical ceiling reachable via self-fill (USD) — the headline number. */
  ceilingUsd: number
  /** New USDC the bundle would commit now (USD). */
  newCommitUsd: number
  /** Number of self-invites the bundle would issue. */
  inviteCount: number
  /** Invoked when the user clicks "Max out". */
  onMaxOut: () => void
  /** True while the fresh on-chain plan is being fetched. */
  loading?: boolean
  /** True when the wallet balance can't cover the full bundle (CTA disabled). */
  balanceLimited?: boolean
  /** Error from a failed activation (e.g. the on-chain plan read failed), shown
   *  inline under the subtitle so the click isn't a silent no-op. */
  error?: string
}

/** Banner CTA for the self-fill ("max out") path. Can render inside the commit
 *  card (via the `maxOut` prop) or be hoisted above the card by a flow
 *  controller (desktop `aboveShell`; mobile uses `inShell` inside Step2Commit). */
export function MaxOutBanner({
  maxOut,
  className,
  placement,
}: {
  maxOut: Step2MaxOutOption
  className?: string
  /** Desktop hoist (`aboveShell`) vs mobile in-shell (`inShell`) visibility. */
  placement?: 'aboveShell' | 'inShell'
}) {
  const { ceilingUsd, newCommitUsd, inviteCount, onMaxOut, loading, balanceLimited, error } = maxOut
  // When the plan needs no self-invites (no slots available, or already spent),
  // "max out" is just a one-click commit-to-cap — drop the self-invite framing.
  const commitUsd = `$${newCommitUsd.toLocaleString()}`
  const invitePhrase = `${inviteCount} self-invite${inviteCount === 1 ? '' : 's'}`
  const subtitle = balanceLimited
    ? inviteCount > 0
      ? `Top up your wallet to bundle ${invitePhrase} and commit ${commitUsd} across all your hops.`
      : `Top up your wallet to commit ${commitUsd} across all your hops.`
    : inviteCount > 0
      ? `Bundle ${invitePhrase} + per-hop commits (${commitUsd}) into one transaction.`
      : `Commit ${commitUsd} across all your hops in one transaction.`

  const placementClass =
    placement === 'aboveShell'
      ? maxOutStyles.aboveShell
      : placement === 'inShell'
        ? maxOutStyles.inShell
        : undefined

  const button = (
    <Button
      className={maxOutStyles.cta}
      variant="gradient"
      size="md"
      label={loading ? 'Preparing…' : 'Max out'}
      showIcon={false}
      disabled={loading || balanceLimited}
      onClick={onMaxOut}
    />
  )

  return (
    <div
      className={[maxOutStyles.banner, placementClass, className].filter(Boolean).join(' ')}
      role="region"
      aria-label="Commit the maximum"
    >
      <div className={maxOutStyles.copy}>
        <p className={maxOutStyles.title}>
          Commit the maximum — up to ${ceilingUsd.toLocaleString()}
        </p>
        <p className={maxOutStyles.subtitle}>{subtitle}</p>
        {error ? (
          <p className={maxOutStyles.error} role="alert">
            {error}
          </p>
        ) : null}
      </div>
      {balanceLimited && !loading ? (
        <Tooltip variant="centered" content="Insufficient balance">
          {button}
        </Tooltip>
      ) : (
        button
      )}
    </div>
  )
}

/** Layout wrapper for desktop max-out banner + step shell (mobile fills the panel). */
export function MaxOutFlowStack({ children }: { children: React.ReactNode }) {
  return <div className={maxOutStyles.stack}>{children}</div>
}

/** One per-hop input row for the multi-hop variant. The single-hop path is
 *  triggered when `hopRows` is omitted or length === 1 — passing a single
 *  row through is supported, but the legacy big-number input is preferred
 *  for that case (cleaner visual). */
export interface Step2CommitHopRow {
  hop: 0 | 1 | 2
  /** Display label — e.g. 'HOP-0', 'HOP-1', 'HOP-2'. */
  hopLabel: string
  /** Dot color from the canonical hop palette (`graphHopColors.ts`). */
  hopColor: string
  /** Per-hop cap in USDC (matches `effectiveCap` from useEligibility). */
  maxAmount: number
  /** Already committed at this hop, used to compute remaining cap. */
  existingCommittedUsdc: number
}

interface Step2CommitProps extends ParticipateStepBarProps {
  /** Single-hop callback. Called with the amount the user entered. Ignored
   *  when `hopRows` triggers the multi-hop path. */
  onNext: (amount: number) => void
  /** Multi-hop callback. Called instead of `onNext` when `hopRows.length > 1`.
   *  Map keyed by hop (0/1/2) with the per-hop amount the user entered. */
  onNextMulti?: (amounts: Record<0 | 1 | 2, number>) => void
  onBack: () => void
  /** Close control in the top chrome (preferred over the modal-level X). */
  onClose?: () => void
  maxAmount?: number
  availableBalance?: number
  maxArm?: number
  /** Already committed USDC — bar shows this before new input. */
  existingCommittedUsdc?: number
  /** Single-hop only: prefill when returning from Review (parent-held amount). */
  initialAmount?: number
  /** Single-hop only: label of the hop being committed to (e.g. 'HOP-0',
   *  'HOP-1', 'HOP-2'). When provided, renders a hop badge above the input.
   *  Ignored in the multi-hop variant (each row already shows its own hop). */
  hopLabel?: string
  /** Single-hop only: dot color for the hop badge, from the canonical hop
   *  palette (`graphHopColors.ts`). Omit to render the label without a dot. */
  hopColor?: string
  /** Single-hop only: pro-rata ARM estimate for a given new USD amount. When
   *  provided, the live "EST. ARM" counter uses it instead of the 1:1 default,
   *  so it agrees with the Review/confirmation screens. */
  estimateArm?: (newAmountUsd: number) => number
  showBack?: boolean
  /** Per-hop rows for the multi-hop variant. When length > 1, replaces the
   *  single amount input with stacked entries. Omit (or pass length ≤ 1) to
   *  keep the legacy designer-faithful single-hop UX. */
  hopRows?: ReadonlyArray<Step2CommitHopRow>
  /** Optional "max out" self-fill banner shown above the amount entry. */
  maxOut?: Step2MaxOutOption
  /** Secondary CTA on the fully-committed card (replaces plain Back). */
  onViewPosition?: () => void
}

function formatBalance(n: number) {
  return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

export default function Step2Commit({
  onNext,
  onNextMulti,
  onBack,
  onClose,
  maxAmount = 4000,
  availableBalance = 215154.14,
  maxArm = 4000,
  existingCommittedUsdc = 0,
  initialAmount = 0,
  hopLabel,
  hopColor,
  estimateArm,
  showBack = true,
  hopRows,
  maxOut,
  onViewPosition,
}: Step2CommitProps) {
  const isMulti = !!hopRows && hopRows.length > 1
  return isMulti ? (
    <MultiHopVariant
      hopRows={hopRows!}
      onNextMulti={onNextMulti}
      onBack={onBack}
      onClose={onClose}
      availableBalance={availableBalance}
      showBack={showBack}
      maxOut={maxOut}
      onViewPosition={onViewPosition}
    />
  ) : (
    <SingleHopVariant
      onNext={onNext}
      onBack={onBack}
      onClose={onClose}
      maxAmount={maxAmount}
      availableBalance={availableBalance}
      maxArm={maxArm}
      existingCommittedUsdc={existingCommittedUsdc}
      initialAmount={initialAmount}
      hopLabel={hopLabel}
      hopColor={hopColor}
      estimateArm={estimateArm}
      showBack={showBack}
      maxOut={maxOut}
      onViewPosition={onViewPosition}
    />
  )
}

// ── Single-hop variant (designer-faithful) ──

function SingleHopVariant({
  onNext,
  onBack,
  onClose,
  maxAmount,
  availableBalance,
  maxArm: _maxArm,
  existingCommittedUsdc,
  initialAmount,
  hopLabel,
  hopColor,
  estimateArm,
  showBack,
  maxOut,
  onViewPosition,
}: {
  onNext: (amount: number) => void
  onBack: () => void
  onClose?: () => void
  maxAmount: number
  availableBalance: number
  maxArm: number
  existingCommittedUsdc: number
  initialAmount: number
  hopLabel?: string
  hopColor?: string
  estimateArm?: (newAmountUsd: number) => number
  showBack: boolean
  maxOut?: Step2MaxOutOption
  onViewPosition?: () => void
}) {
  const remainingCap = Math.max(0, maxAmount - existingCommittedUsdc)
  // Free-form string state so the input can hold mid-decimal entries ("0.",
  // "1.") without flickering the bar / ARM allocation numbers. Parsed via
  // `parseActiveAmount` to a capped numeric for downstream math.
  const [amountInput, setAmountInput] = useState(() => {
    if (initialAmount <= 0) return ''
    const capped = Math.min(initialAmount, remainingCap)
    return hasActiveAmount(String(capped)) ? String(capped) : ''
  })
  const [commaError, setCommaError] = useState(false)

  const showActiveAmount = hasActiveAmount(amountInput)
  const amount = parseActiveAmount(amountInput, remainingCap)
  const existingRatio = Math.min(existingCommittedUsdc / maxAmount, 1)
  const newRatio = Math.min(amount / maxAmount, 1)
  const totalCommitted = existingCommittedUsdc + amount
  // Pro-rata estimate when supplied (e.g. the /invite flow), else the 1:1
  // default. estimateArm(amount) already includes any existing commitment.
  const totalArm = estimateArm ? Math.round(estimateArm(amount)) : Math.round(totalCommitted)
  const hasNewAmount = amount > 0
  const belowMin = hasNewAmount && amount < MIN_COMMIT_USD
  const hasExisting = existingCommittedUsdc > 0
  // Already committed the full hop cap — there's nothing left to enter, so show
  // a message instead of a dead 0-capped input.
  const fullyCommitted = hasExisting && remainingCap <= 0
  // Wallet-balance gate. `remainingCap` caps the typed input at the user's
  // *hop cap*, not their *wallet balance*; without this check a user with
  // $100 of USDC could enter $4,000 and click Review. Mirrors the
  // `overBalance` gate in `MultiHopVariant`.
  const overBalance = amount > availableBalance
  const canFillMax = remainingCap > 0 && amount < remainingCap

  const inShellBanner =
    maxOut != null ? (
      <div className={styles.maxOutSlot}>
        <MaxOutBanner maxOut={maxOut} placement="inShell" />
      </div>
    ) : null

  function handleInput(raw: string) {
    setCommaError(isInvalidCommaInput(raw))
    const next = sanitizeAmountInput(raw)
    if (!hasActiveAmount(next)) {
      setAmountInput('')
      return
    }
    // Trailing-dot entry: preserve the literal string while still capping the
    // integer part so the bar can't jump past `remainingCap`.
    if (next.endsWith('.')) {
      const val = parseFloat(next)
      if (!Number.isNaN(val) && val > remainingCap) {
        setAmountInput(String(remainingCap))
      } else {
        setAmountInput(next)
      }
      return
    }
    const val = parseFloat(next)
    if (Number.isNaN(val)) {
      setAmountInput('')
      return
    }
    const capped = Math.min(val, remainingCap)
    setAmountInput(hasActiveAmount(String(capped)) ? String(capped) : '')
  }

  if (fullyCommitted) {
    return (
      <div className={styles.shell} data-flow-shell>
        <FlowChrome
          title="Fully committed"
          showBack={showBack}
          onBack={onBack}
          onClose={onClose}
        />
        {inShellBanner}

        <div className={styles.content}>
          <div className={styles.inputBlock}>
            <div className={styles.fullyCommittedGroup}>
              {hopLabel && (
                <span className={styles.hopBadge}>
                  {hopColor && (
                    <span
                      className={styles.hopBadgeDot}
                      style={{ background: hopColor }}
                      aria-hidden
                    />
                  )}
                  <span className={styles.hopBadgeLabel}>{hopLabel}</span>
                </span>
              )}
              <p className={styles.maxLabel}>
                You&apos;ve committed the maximum {maxAmount.toLocaleString('en-US')} USDC for
                this hop.
              </p>
            </div>
          </div>
        </div>

        <div className={styles.bottomDock}>
          <div className={styles.buttonRow}>
            {onViewPosition ? (
              <Button
                variant="secondary"
                size="lg"
                label="View your position"
                showIcon={false}
                onClick={onViewPosition}
              />
            ) : (
              showBack && (
                <Button
                  variant="secondary"
                  size="lg"
                  label="Back"
                  showIcon={false}
                  onClick={onBack}
                />
              )
            )}
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className={styles.shell} data-flow-shell>
      <FlowChrome
        title="How much USDC?"
        titleId="commit-title"
        showBack={showBack}
        onBack={onBack}
        onClose={onClose}
      />
      {inShellBanner}

      <div className={styles.content}>
        <div className={styles.inputBlock}>
          <div className={styles.amountGroup}>
            {hopLabel && (
              <span className={styles.hopBadge}>
                {hopColor && (
                  <span
                    className={styles.hopBadgeDot}
                    style={{ background: hopColor }}
                    aria-hidden
                  />
                )}
                <span className={styles.hopBadgeLabel}>{hopLabel}</span>
              </span>
            )}

            <div className={styles.amountCluster}>
              <label className={styles.amountWrapper} htmlFor="commit-amount">
                <span className={styles.visuallyHidden}>Amount in USDC</span>
                <span
                  className={[styles.amountField, showActiveAmount && styles.amountFieldHasValue]
                    .filter(Boolean)
                    .join(' ')}
                >
                  <span
                    className={[
                      styles.amountDisplay,
                      showActiveAmount ? styles.amountDisplayActive : '',
                    ]
                      .filter(Boolean)
                      .join(' ')}
                    aria-hidden="true"
                  >
                    {showActiveAmount ? amountInput : '0'}
                  </span>
                  <input
                    id="commit-amount"
                    type="text"
                    inputMode="decimal"
                    autoComplete="off"
                    value={amountInput}
                    onChange={(e) => handleInput(e.target.value)}
                    className={styles.amountInput}
                    aria-labelledby="commit-title"
                    aria-describedby="commit-balance"
                  />
                </span>
              </label>

              <p className={styles.balanceLabel} id="commit-balance">
                Balance {formatBalance(availableBalance)}
              </p>
              {overBalance && hasNewAmount && (
                <p className={styles.overBalance}>Amount exceeds your wallet balance.</p>
              )}
              {belowMin && !overBalance && (
                <p className={styles.overBalance}>
                  Minimum {MIN_COMMIT_USD.toLocaleString()} USDC per commit.
                </p>
              )}
              {commaError && <p className={styles.overBalance}>Use a period for decimals.</p>}
            </div>
          </div>
        </div>
      </div>

      <div className={styles.bottomDock}>
        <div className={styles.allocationBlock}>
          <div className={styles.barSection}>
            <div
              className={styles.barTrack}
              role="progressbar"
              aria-valuenow={Math.round((existingRatio + newRatio) * 100)}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-label="Committed amount toward your maximum"
            >
              {hasExisting && (
                <div
                  className={styles.barFillExisting}
                  style={{ width: `${existingRatio * 100}%` }}
                />
              )}
              {hasNewAmount && (
                <div className={styles.barFillNew} style={{ width: `${newRatio * 100}%` }} />
              )}
            </div>
            <div className={styles.barScale}>
              <span className={styles.barScaleMin}>
                {totalCommitted.toLocaleString('en-US')} USDC
              </span>
              {/* MAX doubles as a fill-to-cap control (armada-crowdfund
                  ArmAllocationBlock affordance). */}
              <button
                type="button"
                className={styles.barScaleMaxBtn}
                onClick={() => setAmountInput(String(remainingCap))}
                disabled={!canFillMax}
                aria-label={`Fill maximum ${maxAmount.toLocaleString('en-US')} USDC`}
              >
                MAX {maxAmount.toLocaleString('en-US')} USDC
              </button>
            </div>
          </div>
          <div className={styles.armCard}>
            <div className={styles.allocationLeft}>
              <span className={styles.allocationLabel}>EST. ARM allocation</span>
              <Tooltip
                variant="rich"
                title="EST. ARM Allocation"
                description="Your estimated allocation based on the amount committed."
                bullets={[
                  estimateArm ? 'Pro-rata to total pool demand' : '1 ARM per 1 USDC committed',
                  'Final allocation confirmed at close',
                  'Subject to pool cap',
                ]}
              >
                <button
                  type="button"
                  className={styles.infoTrigger}
                  aria-label="Estimated ARM allocation details"
                >
                  <InformationCircleIcon className={styles.infoIcon} aria-hidden />
                </button>
              </Tooltip>
            </div>
            <span
              className={
                hasNewAmount || hasExisting ? styles.allocationValueActive : styles.allocationValue
              }
            >
              {totalArm.toLocaleString()}
            </span>
          </div>
        </div>

        <div className={styles.buttonRow}>
          <Button
            variant="primary"
            size="lg"
            label={hasNewAmount ? 'Review' : 'Input amount'}
            showIcon={false}
            className={amount < MIN_COMMIT_USD || overBalance ? styles.ctaBlocked : undefined}
            aria-disabled={amount < MIN_COMMIT_USD || overBalance || undefined}
            onClick={() => {
              if (amount < MIN_COMMIT_USD || overBalance) return
              onNext(amount)
            }}
          />
        </div>
      </div>
    </div>
  )
}

// ── Multi-hop variant (local extension; designer hasn't shipped a spec) ──

function MultiHopVariant({
  hopRows,
  onNextMulti,
  onBack,
  onClose,
  availableBalance,
  showBack,
  maxOut,
  onViewPosition,
}: {
  hopRows: ReadonlyArray<Step2CommitHopRow>
  onNextMulti: ((amounts: Record<0 | 1 | 2, number>) => void) | undefined
  onBack: () => void
  onClose?: () => void
  availableBalance: number
  showBack: boolean
  maxOut?: Step2MaxOutOption
  onViewPosition?: () => void
}) {
  // Amounts are tracked as strings so the user can clear a field without it
  // collapsing to "0" mid-typing. Numeric conversion happens for sums + the
  // submit callback.
  const [amounts, setAmounts] = useState<Record<0 | 1 | 2, string>>({
    0: '',
    1: '',
    2: '',
  })
  const [commaError, setCommaError] = useState(false)

  // Reset row state if the input set changes mid-flow (e.g. eligibility
  // refresh adds a new hop). Keyed on the hop list so re-mounting isn't
  // required for the common case where rows are stable.
  const hopsKey = useMemo(() => hopRows.map((r) => r.hop).join(','), [hopRows])
  useEffect(() => {
    setAmounts({ 0: '', 1: '', 2: '' })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hopsKey])

  const parsedByHop = useMemo<Record<0 | 1 | 2, number>>(() => {
    const out: Record<0 | 1 | 2, number> = { 0: 0, 1: 0, 2: 0 }
    for (const row of hopRows) {
      const remaining = Math.max(0, row.maxAmount - row.existingCommittedUsdc)
      out[row.hop] = parseActiveAmount(amounts[row.hop], remaining)
    }
    return out
  }, [amounts, hopRows])

  const totalNew = useMemo(
    () => hopRows.reduce((sum, row) => sum + (parsedByHop[row.hop] ?? 0), 0),
    [parsedByHop, hopRows],
  )
  const totalExisting = useMemo(
    () => hopRows.reduce((sum, row) => sum + row.existingCommittedUsdc, 0),
    [hopRows],
  )
  const totalCap = useMemo(
    () => hopRows.reduce((sum, row) => sum + row.maxAmount, 0),
    [hopRows],
  )
  const totalArm = Math.round(totalExisting + totalNew)

  const overBalance = totalNew > availableBalance
  const anyOverHopCap = hopRows.some((row) => {
    const remaining = Math.max(0, row.maxAmount - row.existingCommittedUsdc)
    return parsedByHop[row.hop] > remaining
  })
  // Each hop the user commits to (amount > 0) must individually clear MIN_COMMIT.
  const anyBelowMin = hopRows.some((row) => {
    const a = parsedByHop[row.hop]
    return a > 0 && a < MIN_COMMIT_USD
  })
  const canReview = totalNew > 0 && !overBalance && !anyOverHopCap && !anyBelowMin

  const handleInputChange = (hop: 0 | 1 | 2, row: Step2CommitHopRow) =>
    (e: React.ChangeEvent<HTMLInputElement>) => {
      setCommaError(isInvalidCommaInput(e.target.value))
      const next = sanitizeAmountInput(e.target.value)
      const remaining = Math.max(0, row.maxAmount - row.existingCommittedUsdc)
      if (!hasActiveAmount(next)) {
        setAmounts((prev) => ({ ...prev, [hop]: '' }))
        return
      }
      // Trailing-dot mid-typing: preserve the literal string but cap the
      // integer portion so the per-row bar can't jump past `remaining`.
      if (next.endsWith('.')) {
        const val = parseFloat(next)
        if (!Number.isNaN(val) && val > remaining) {
          setAmounts((prev) => ({ ...prev, [hop]: String(remaining) }))
        } else {
          setAmounts((prev) => ({ ...prev, [hop]: next }))
        }
        return
      }
      const val = parseFloat(next)
      if (Number.isNaN(val)) {
        setAmounts((prev) => ({ ...prev, [hop]: '' }))
        return
      }
      const capped = Math.min(val, remaining)
      setAmounts((prev) => ({
        ...prev,
        [hop]: hasActiveAmount(String(capped)) ? String(capped) : '',
      }))
    }

  const handleNext = () => {
    if (!onNextMulti) return
    onNextMulti(parsedByHop)
  }

  // Bar fills: each hop contributes a slice proportional to its share of
  // totalCap. We render existing fills (purple-700) followed by new fills
  // (lavender) for each hop in declaration order.
  const safeTotalCap = totalCap > 0 ? totalCap : 1
  const existingRatio = Math.min(totalExisting / safeTotalCap, 1)
  const newRatio = Math.min((totalExisting + totalNew) / safeTotalCap, 1) - existingRatio

  // Every eligible hop is already at its cap — nothing left to commit anywhere.
  const allFullyCommitted =
    hopRows.length > 0 &&
    hopRows.every(
      (row) => row.existingCommittedUsdc > 0 && row.maxAmount - row.existingCommittedUsdc <= 0,
    )

  const inShellBanner =
    maxOut != null ? (
      <div className={styles.maxOutSlot}>
        <MaxOutBanner maxOut={maxOut} placement="inShell" />
      </div>
    ) : null

  if (allFullyCommitted) {
    return (
      <div className={styles.shell} data-flow-shell>
        <FlowChrome
          title="Fully committed"
          showBack={showBack}
          onBack={onBack}
          onClose={onClose}
        />
        {inShellBanner}

        <div className={styles.content}>
          <div className={styles.inputBlock}>
            <div className={styles.fullyCommittedGroup}>
              <p className={styles.maxLabel}>
                You&apos;ve committed the maximum {totalCap.toLocaleString()} USDC across your
                hops.
              </p>
            </div>
          </div>
        </div>

        <div className={styles.bottomDock}>
          <div className={styles.buttonRow}>
            {onViewPosition ? (
              <Button
                variant="secondary"
                size="lg"
                label="View your position"
                showIcon={false}
                onClick={onViewPosition}
              />
            ) : (
              showBack && (
                <Button
                  variant="secondary"
                  size="lg"
                  label="Back"
                  showIcon={false}
                  onClick={onBack}
                />
              )
            )}
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className={styles.shell} data-flow-shell>
      <FlowChrome
        title="How much USDC?"
        showBack={showBack}
        onBack={onBack}
        onClose={onClose}
      />
      {inShellBanner}

      <div className={styles.content}>
        <div className={styles.multiList}>
          <p className={styles.multiAvailableLabel}>Balance {formatBalance(availableBalance)}</p>

          {hopRows.map((row) => {
            const remaining = Math.max(0, row.maxAmount - row.existingCommittedUsdc)
            const hasExisting = row.existingCommittedUsdc > 0
            const value = amounts[row.hop]
            const inputId = `commit-amount-hop-${row.hop}`
            return (
              <label key={row.hop} htmlFor={inputId} className={styles.multiRow}>
                <div className={styles.multiRowLeft}>
                  <span
                    className={styles.multiHopDot}
                    style={{ background: row.hopColor }}
                    aria-hidden
                  />
                  <span className={styles.multiHopLabel}>{row.hopLabel}</span>
                </div>
                <span className={styles.multiCapLabel}>
                  {hasExisting
                    ? `${remaining.toLocaleString()} remaining`
                    : `Max ${row.maxAmount.toLocaleString()}`}
                </span>
                <span className={styles.visuallyHidden}>USDC amount for {row.hopLabel}</span>
                <input
                  id={inputId}
                  type="text"
                  inputMode="decimal"
                  autoComplete="off"
                  value={value}
                  placeholder="0"
                  onChange={handleInputChange(row.hop, row)}
                  className={styles.multiAmountInput}
                />
              </label>
            )
          })}
        </div>
      </div>

      <div className={styles.bottomDock}>
        <div className={styles.allocationBlock}>
          <div className={styles.barSection}>
            <div
              className={styles.barTrack}
              role="progressbar"
              aria-valuenow={Math.round((existingRatio + newRatio) * 100)}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-label="Total committed amount toward your maximum"
            >
              {existingRatio > 0 && (
                <div
                  className={styles.barFillExisting}
                  style={{ width: `${existingRatio * 100}%` }}
                />
              )}
              {newRatio > 0 && (
                <div className={styles.barFillNew} style={{ width: `${newRatio * 100}%` }} />
              )}
            </div>
            <div className={styles.barScale}>
              <span className={styles.barScaleMin}>
                {(totalExisting + totalNew).toLocaleString('en-US')} USDC
              </span>
              <span className={styles.barScaleMax}>
                MAX {totalCap.toLocaleString('en-US')} USDC
              </span>
            </div>
          </div>
          <div className={styles.armCard}>
            <div className={styles.allocationLeft}>
              <span className={styles.allocationLabel}>EST. ARM allocation</span>
              <Tooltip
                variant="rich"
                title="EST. ARM Allocation"
                description="Estimated total ARM across all hops based on the amounts entered."
                bullets={[
                  '1 ARM per 1 USDC committed',
                  'Final allocation confirmed at close',
                  'Subject to per-hop pool caps',
                ]}
              >
                <button
                  type="button"
                  className={styles.infoTrigger}
                  aria-label="Estimated ARM allocation details"
                >
                  <InformationCircleIcon className={styles.infoIcon} aria-hidden />
                </button>
              </Tooltip>
            </div>
            <span
              className={
                totalNew > 0 || totalExisting > 0
                  ? styles.allocationValueActive
                  : styles.allocationValue
              }
            >
              {totalArm.toLocaleString()}
            </span>
          </div>
          {overBalance && (
            <p className={styles.overBalance}>Total exceeds your wallet balance.</p>
          )}
          {anyBelowMin && !overBalance && (
            <p className={styles.overBalance}>
              Each hop you commit to must be at least {MIN_COMMIT_USD.toLocaleString()} USDC.
            </p>
          )}
          {commaError && <p className={styles.overBalance}>Use a period for decimals.</p>}
        </div>

        <div className={styles.buttonRow}>
          <Button
            variant="primary"
            size="lg"
            label={totalNew > 0 ? 'Review' : 'Input amount'}
            showIcon={false}
            className={!canReview ? styles.ctaBlocked : undefined}
            aria-disabled={!canReview || undefined}
            onClick={() => {
              if (!canReview) return
              handleNext()
            }}
          />
        </div>
      </div>
    </div>
  )
}
