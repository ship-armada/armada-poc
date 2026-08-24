// ABOUTME: Deposit amount card — optional in-card title, chain slot, left-aligned large mono amount, balance/fee row.
// ABOUTME: The chain UI (when shown) is supplied by the caller via `chainSlot` (e.g. the shared ChainSelect).

import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { WalletIcon } from '@heroicons/react/24/solid'
import { formatAmountInputDisplay, hasActiveAmount, sanitizeAmountInput } from '@/utils/amountInput'
import { AmountFieldWarning } from '@/components/ui/AmountFieldWarning'
import { FeeBreakdownTooltip, type FlowFeeBreakdown } from '@/components/ui/FeeBreakdownTooltip'
import { RollingBalanceValue } from '@/components/dashboard/RollingBalanceValue'
import {
  BALANCE_ROLL_DURATION_MS,
  BALANCE_ROLL_DIGIT_STAGGER_MS,
} from '@/components/dashboard/BalanceCard/balanceRevealMotion'
import { formatUsdcAmount, formatUsdcPlain } from '@/lib/format'
import type { DisplayFees } from '@/lib/fees/displayFees'
import { incompleteCtaShakeClass } from '@/design'
import styles from './DepositAmountCard.module.css'

function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined') return false
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

/** Roll animation lifetime for a target value — long enough for the odometer + digit stagger to settle. */
function amountRollMs(formatted: string): number {
  const digitCount = formatted.replace(/\D/g, '').length
  return BALANCE_ROLL_DURATION_MS + Math.max(0, digitCount - 1) * BALANCE_ROLL_DIGIT_STAGGER_MS + 80
}

export interface DepositAmountCardProps {
  /**
   * Chain-row content rendered above the title (e.g. the shared `ChainSelect`). Omit for flows with
   * no in-card chain row (e.g. Send/Earn, where the chain is chosen on a prior step or is fixed).
   */
  chainSlot?: ReactNode
  /**
   * Optional node rendered at the very top of the card, above the title (e.g. the Earn flow's
   * Add/Withdraw SegmentedControl). Matches the mockup's in-card `headerSlot`.
   */
  header?: ReactNode
  /** Optional heading rendered inside the card (left-aligned) above the amount. */
  title?: string
  amount: string
  onAmountChange: (value: string) => void
  balance?: string
  /** Not-yet-spendable ("pending") amount, pre-formatted. Shown as a "· X pending" suffix on the
   *  balance row when set — notes still inside the finality buffer, excluded from `balance`/Max. */
  pendingBalance?: string
  /** When set, fee row shows total + breakdown tooltip. */
  displayFees?: DisplayFees
  feeLoading?: boolean
  /**
   * Optional flow-level breakdown (broadcaster fee, recipient-receives, total-deducted) layered
   * onto the tooltip and into the FEE label total. Used by relayer-mediated / gasless flows
   * where the displayed total USDC fee is `protocolFee + broadcasterFee`.
   */
  flowBreakdown?: FlowFeeBreakdown
  onMax?: () => void
  /**
   * Raw 6-decimal cap the amount input accepts. When provided, the balance row renders
   * 25% / 50% / 75% / Max percentage pills (each sets the amount to that fraction of `maxInput`);
   * when omitted the card falls back to the single `Max` button (driven by `onMax`).
   */
  maxInput?: bigint
  /**
   * Full (pre-fee) balance the percent pills take a share of — a % of this, capped at `maxInput`.
   * When omitted the pills fall back to a share of `maxInput` (fine where the cap equals the balance,
   * e.g. shield). Set on fee-on-top paths (send/withdraw/earn) so 25/50/75 land on round balance
   * fractions rather than fractions of the fee-adjusted cap.
   */
  balanceRaw?: bigint
  error?: string
  /** Accessible name for the amount field (e.g. "Deposit amount", "Withdrawal amount"). */
  amountAriaLabel?: string
  /** Ref onto the amount `<input>` — lets a sibling footer focus the field (e.g. the incomplete-CTA nudge). */
  inputRef?: React.Ref<HTMLInputElement>
  /**
   * When true, plays a one-shot shake on the card — the incomplete-CTA nudge (mockup: the field the
   * disabled "Input amount" CTA points at shakes, not the button). Pair with `onShakeAnimationEnd`.
   */
  shaking?: boolean
  /** Clears the shake once the animation finishes; wire to `useNudgeShake().onShakeAnimationEnd`. */
  onShakeAnimationEnd?: (event: React.AnimationEvent<HTMLDivElement>) => void
}

export function DepositAmountCard({
  chainSlot,
  header,
  title,
  amount,
  onAmountChange,
  balance = '0.00',
  pendingBalance,
  displayFees,
  feeLoading = false,
  flowBreakdown,
  onMax,
  maxInput,
  balanceRaw,
  error,
  amountAriaLabel = 'Amount',
  inputRef,
  shaking = false,
  onShakeAnimationEnd,
}: DepositAmountCardProps) {
  const amountInputId = useId()
  const amountErrorId = useId()

  // Odometer roll for preset/Max taps (mockup): the amount digit-spins from the old value to the new
  // one. A preset handler records where we're rolling *from*; the effect below detects the resulting
  // `amount` change and starts the roll. Typing clears the marker so keystrokes never roll.
  const [amountRoll, setAmountRoll] = useState<{
    fromValue: string
    toValue: string
    trigger: number
  } | null>(null)
  const rollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const rollCounterRef = useRef(0)
  const pendingRollFromRef = useRef<string | null>(null)

  function clearAmountRoll() {
    if (rollTimerRef.current) {
      clearTimeout(rollTimerRef.current)
      rollTimerRef.current = null
    }
    setAmountRoll(null)
  }

  useEffect(
    () => () => {
      if (rollTimerRef.current) clearTimeout(rollTimerRef.current)
    },
    [],
  )

  // Start the roll once the preset-driven `amount` change lands. Typed changes leave the marker null.
  useEffect(() => {
    const fromValue = pendingRollFromRef.current
    if (fromValue === null) return
    pendingRollFromRef.current = null
    const toValue = hasActiveAmount(amount) ? amount : '0'
    if (prefersReducedMotion() || fromValue === toValue) {
      clearAmountRoll()
      return
    }
    rollCounterRef.current += 1
    const trigger = rollCounterRef.current
    setAmountRoll({ fromValue, toValue, trigger })
    if (rollTimerRef.current) clearTimeout(rollTimerRef.current)
    rollTimerRef.current = setTimeout(() => {
      rollTimerRef.current = null
      setAmountRoll(null)
    }, amountRollMs(toValue))
    // eslint-disable-next-line react-hooks/exhaustive-deps -- roll is keyed off the amount change only.
  }, [amount])

  function handleAmountInput(raw: string) {
    clearAmountRoll()
    pendingRollFromRef.current = null
    // Pass the sanitized value straight through — including forward-typing states like `0`, `.`,
    // and `0.` that `hasActiveAmount` reports false. Rewriting those to `''` (the previous
    // behaviour) discarded a leading `0`/`.` keystroke, making sub-one amounts impossible to type.
    // `hasActiveAmount` still gates display styling (`showActiveAmount`) and the `amount > 0n`
    // submit checks, so a bare `0`/`.` never advances the flow.
    onAmountChange(sanitizeAmountInput(raw))
  }

  /** Mark the current display as the roll origin, then apply the preset amount (the effect rolls it). */
  function applyPreset(nextAmount: string) {
    pendingRollFromRef.current = hasActiveAmount(amount) ? amount : '0'
    onAmountChange(nextAmount)
  }

  // Percentage pills set the amount to a share of the full balance (mockup parity), capped at the
  // fee-aware `maxInput`. When `balanceRaw` isn't supplied (e.g. shield, where the cap equals the
  // balance) they fall back to a share of the cap. Integer bigint math keeps full 6-decimal precision.
  function applyPercent(percent: bigint) {
    if (maxInput === undefined) return
    const share = ((balanceRaw ?? maxInput) * percent) / 100n
    const capped = share < maxInput ? share : maxInput
    applyPreset(formatUsdcPlain(capped))
  }

  // Max reuses the caller's `onMax` when supplied so fee-on-top paths keep their exact cap, else it
  // falls back to the full `maxInput`. Either way the roll origin is marked so the value spins.
  function handleMax() {
    if (onMax) {
      pendingRollFromRef.current = hasActiveAmount(amount) ? amount : '0'
      onMax()
    } else {
      applyPercent(100n)
    }
  }

  const showActiveAmount = hasActiveAmount(amount)
  const isAmountRolling = amountRoll !== null
  // Thousand-grouped for display only ("1,000,000"); the stored `amount` stays ungrouped and the
  // sanitizer strips the commas back out on the next keystroke (mockup parity).
  const displayAmount = formatAmountInputDisplay(amount)
  // Any validation error (over-balance, below-minimum, parse, withdraw fee-shortfall) reddens the
  // amount numeral + balance row (mockup parity) alongside the above-field warning tooltip.
  const hasError = Boolean(error)

  // Total displayed fee (protocol + broadcaster + CCTP). Rendered as the under-amount caption
  // ("+ $X.XX FEE") once an amount is entered and the fee is non-zero — matching the mockup, which
  // moved the fee off a bottom row and into a caption directly below the amount.
  const totalFeeRaw = displayFees
    ? displayFees.totalFee + (flowBreakdown?.broadcasterFee ?? 0n) + (flowBreakdown?.cctpFee ?? 0n)
    : 0n
  const showFee = showActiveAmount && displayFees !== undefined && totalFeeRaw > 0n

  return (
    <div
      className={[styles.card, shaking && incompleteCtaShakeClass].filter(Boolean).join(' ')}
      onAnimationEnd={onShakeAnimationEnd}
    >
      <div className={styles.cardTop}>
      {header ? <div className={styles.cardHeader}>{header}</div> : null}
      {title ? <p className={styles.cardTitle}>{title}</p> : null}
      {chainSlot ? <div className={styles.topRow}>{chainSlot}</div> : null}

      <div className={styles.amountStack}>
        <label className={styles.amountWrapper} htmlFor={amountInputId}>
          <span className={styles.visuallyHidden}>{amountAriaLabel}</span>
          <AmountFieldWarning id={amountErrorId} visible={Boolean(error)} message={error ?? ''}>
          <span
            className={[styles.amountField, showActiveAmount && styles.amountFieldHasValue]
              .filter(Boolean)
              .join(' ')}
          >
            <span
              className={[
                styles.amountDisplay,
                showActiveAmount && styles.amountDisplayActive,
                hasError && styles.amountDisplayError,
                isAmountRolling && styles.amountValueHidden,
              ]
                .filter(Boolean)
                .join(' ')}
              aria-hidden="true"
            >
              {showActiveAmount ? displayAmount : '0'}
            </span>
            <input
              ref={inputRef}
              id={amountInputId}
              type="text"
              inputMode="decimal"
              autoComplete="off"
              autoCorrect="off"
              spellCheck={false}
              data-1p-ignore
              data-lpignore="true"
              className={[styles.amountInput, isAmountRolling && styles.amountValueHidden]
                .filter(Boolean)
                .join(' ')}
              value={displayAmount}
              onChange={(e) => handleAmountInput(e.target.value)}
              aria-label={amountAriaLabel}
              aria-invalid={Boolean(error)}
              aria-describedby={error ? amountErrorId : undefined}
              readOnly={isAmountRolling}
            />
            {isAmountRolling && amountRoll ? (
              <span className={styles.amountRollLayer} aria-hidden>
                <RollingBalanceValue
                  key={amountRoll.trigger}
                  value={formatAmountInputDisplay(amountRoll.toValue)}
                  fromValue={formatAmountInputDisplay(amountRoll.fromValue)}
                  mode="fromValue"
                  rollTrigger={amountRoll.trigger}
                  rollStartMs={0}
                />
              </span>
            ) : null}
          </span>
          </AmountFieldWarning>
        </label>

        {/* Fee caption (mockup): "+ $X.XX FEE" directly under the amount. The line is always
            reserved (non-breaking space when there's no fee) so the card height stays stable. The
            breakdown tooltip is kept beside the value for the full protocol/broadcaster split. */}
        <div className={`armada-text-ui-label-md ${styles.feeCaption}`} role="status">
          {showFee && displayFees ? (
            <>
              <span>+ ${formatUsdcAmount(totalFeeRaw)} FEE</span>
              <FeeBreakdownTooltip
                fees={displayFees}
                isLoading={feeLoading}
                flowBreakdown={flowBreakdown}
              />
            </>
          ) : (
            ' '
          )}
        </div>
      </div>

      </div>

      <div className={styles.bottomRow}>
        <div className={styles.balanceControls}>
          <div className={styles.balanceGroup}>
            <WalletIcon
              className={[styles.walletIcon, hasError && styles.walletIconError]
                .filter(Boolean)
                .join(' ')}
              aria-hidden
            />
            <span
              className={[styles.balanceText, hasError && styles.balanceTextError]
                .filter(Boolean)
                .join(' ')}
            >
              {balance}
              {pendingBalance ? ` · ${pendingBalance} pending` : ''}
            </span>
          </div>
          {maxInput !== undefined ? (
            <div className={styles.pctPills}>
              <button type="button" className={styles.pctPill} onClick={() => applyPercent(25n)}>
                25%
              </button>
              <button type="button" className={styles.pctPill} onClick={() => applyPercent(50n)}>
                50%
              </button>
              <button type="button" className={styles.pctPill} onClick={() => applyPercent(75n)}>
                75%
              </button>
              <button type="button" className={styles.pctPill} onClick={handleMax}>
                Max
              </button>
            </div>
          ) : onMax ? (
            <button type="button" className={styles.maxBtn} onClick={handleMax}>
              Max
            </button>
          ) : null}
        </div>
      </div>
    </div>
  )
}
