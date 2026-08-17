// ABOUTME: Deposit amount card — chain dropdown, large mono amount, balance/fee row. Matches crowdfund showcase DepositAmountCard.
// ABOUTME: Chain list from parent (network config); icons via @web3icons when mapped, else letter fallback.

import { useEffect, useId, useRef, useState } from 'react'
import { ChevronDownIcon, WalletIcon } from '@heroicons/react/24/solid'
import TokenUSDC from '@web3icons/react/icons/tokens/TokenUSDC'
import { hasActiveAmount, sanitizeAmountInput } from '@/utils/amountInput'
import { chainIconForChainId } from '@/components/deposit/depositChainIcons'
import { FeeBreakdownTooltip, type FlowFeeBreakdown } from '@/components/ui/FeeBreakdownTooltip'
import { formatUsdcPlain } from '@/lib/format'
import type { DisplayFees } from '@/lib/fees/displayFees'
import styles from './DepositAmountCard.module.css'

const ICON_SIZE = 32
// USDC coin beside the amount: rendered oversized inside a 40px clipped badge (matches the mockup —
// the web3icons glyph carries padding, so scaling up + clipping makes it fill the circle).
const AMOUNT_TOKEN_BADGE_PX = 40
const AMOUNT_TOKEN_ICON_SIZE = Math.round((AMOUNT_TOKEN_BADGE_PX * 24) / 18)

export interface DepositChainOption {
  chainId: number
  label: string
}

export interface DepositAmountCardProps {
  chains: ReadonlyArray<DepositChainOption>
  chainId: number
  onChainIdChange?: (chainId: number) => void
  token?: string
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
  error?: string
  /** Accessible name for the amount field (e.g. "Deposit amount", "Withdrawal amount"). */
  amountAriaLabel?: string
}

function ChainIcon({ chainId, label }: { chainId: number; label: string }) {
  const Icon = chainIconForChainId(chainId)
  if (Icon) {
    return (
      <span className={styles.chainIconSlot} aria-hidden>
        <Icon size={ICON_SIZE} variant="branded" />
      </span>
    )
  }
  return (
    <span className={styles.chainIconSlot} aria-hidden>
      {label.charAt(0).toUpperCase()}
    </span>
  )
}

export function DepositAmountCard({
  chains,
  chainId,
  onChainIdChange,
  token = 'USDC',
  amount,
  onAmountChange,
  balance = '0.00',
  pendingBalance,
  displayFees,
  feeLoading = false,
  flowBreakdown,
  onMax,
  maxInput,
  error,
  amountAriaLabel = 'Amount',
}: DepositAmountCardProps) {
  const [menuOpen, setMenuOpen] = useState(false)
  const chainRootRef = useRef<HTMLDivElement>(null)
  const listboxId = useId()
  const amountInputId = useId()

  const selected = chains.find((c) => c.chainId === chainId) ?? chains[0]
  const chainSelectable = Boolean(onChainIdChange) && chains.length > 1

  useEffect(() => {
    if (!menuOpen) return
    function handlePointerDown(event: MouseEvent) {
      if (!chainRootRef.current?.contains(event.target as Node)) {
        setMenuOpen(false)
      }
    }
    document.addEventListener('mousedown', handlePointerDown)
    return () => document.removeEventListener('mousedown', handlePointerDown)
  }, [menuOpen])

  function selectChain(nextId: number) {
    onChainIdChange?.(nextId)
    setMenuOpen(false)
  }

  function handleAmountInput(raw: string) {
    const next = sanitizeAmountInput(raw)
    onAmountChange(hasActiveAmount(next) ? next : '')
  }

  // Percentage pills set the amount to a fraction of the raw input cap. Integer bigint math keeps
  // full 6-decimal precision (no float rounding); Max reuses the caller's `onMax` when supplied so
  // fee-on-top paths keep their exact cap, else it falls back to the full `maxInput`.
  function applyPercent(percent: bigint) {
    if (maxInput === undefined) return
    onAmountChange(formatUsdcPlain((maxInput * percent) / 100n))
  }

  const showActiveAmount = hasActiveAmount(amount)

  return (
    <div className={styles.card}>
      <div className={styles.topRow}>
        <div className={styles.chainRoot} ref={chainRootRef}>
          {chainSelectable ? (
            <button
              type="button"
              className={styles.chainTrigger}
              aria-haspopup="listbox"
              aria-expanded={menuOpen}
              aria-controls={listboxId}
              onClick={() => setMenuOpen((open) => !open)}
            >
              <ChainIcon chainId={chainId} label={selected?.label ?? ''} />
              <span className={styles.chainName}>{selected?.label}</span>
              <ChevronDownIcon className={styles.chevron} aria-hidden />
            </button>
          ) : (
            <div className={styles.chainTriggerStatic}>
              <ChainIcon chainId={chainId} label={selected?.label ?? ''} />
              <span className={styles.chainName}>{selected?.label}</span>
            </div>
          )}

          {menuOpen && chainSelectable ? (
            <ul id={listboxId} className={styles.chainMenu} role="listbox" aria-label="Network">
              {chains.map((option) => (
                <li key={option.chainId} role="presentation">
                  <button
                    type="button"
                    role="option"
                    aria-selected={option.chainId === chainId}
                    className={styles.chainOption}
                    onClick={() => selectChain(option.chainId)}
                  >
                    <ChainIcon chainId={option.chainId} label={option.label} />
                    <span className={styles.chainOptionLabel}>{option.label}</span>
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
        </div>

      </div>

      <label className={styles.amountWrapper} htmlFor={amountInputId}>
        <span className={styles.visuallyHidden}>{amountAriaLabel}</span>
        <span className={styles.amountTokenIcon} aria-hidden>
          <TokenUSDC size={AMOUNT_TOKEN_ICON_SIZE} variant="branded" />
        </span>
        <span
          className={[styles.amountField, showActiveAmount && styles.amountFieldHasValue]
            .filter(Boolean)
            .join(' ')}
        >
          <span
            className={[styles.amountDisplay, showActiveAmount && styles.amountDisplayActive]
              .filter(Boolean)
              .join(' ')}
            aria-hidden="true"
          >
            {showActiveAmount ? amount : '0'}
          </span>
          <input
            id={amountInputId}
            type="text"
            inputMode="decimal"
            className={styles.amountInput}
            value={amount}
            onChange={(e) => handleAmountInput(e.target.value)}
            aria-label={amountAriaLabel}
            aria-invalid={Boolean(error)}
          />
        </span>
      </label>

      {error ? (
        <p className={styles.amountError} role="alert">
          {error}
        </p>
      ) : null}

      <div className={styles.bottomRow}>
        <div className={styles.balanceControls}>
          <div className={styles.balanceGroup}>
            <WalletIcon className={styles.walletIcon} aria-hidden />
            <span className={styles.balanceText}>
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
              <button
                type="button"
                className={styles.pctPill}
                onClick={onMax ?? (() => applyPercent(100n))}
              >
                Max
              </button>
            </div>
          ) : onMax ? (
            <button type="button" className={styles.maxBtn} onClick={onMax}>
              Max
            </button>
          ) : null}
        </div>
        {/* Fee surfaces only once an amount is entered (mockup behavior). The info tooltip with the
            full breakdown is kept even though the mockup has no tooltip. */}
        {showActiveAmount && displayFees ? (
          <div className={styles.feeRow}>
            <span className={styles.feeLabel}>Fee</span>
            <span className={styles.feeValueGroup}>
              <span className={styles.feeValue}>
                {formatUsdcPlain(displayFees.totalFee + (flowBreakdown?.broadcasterFee ?? 0n) + (flowBreakdown?.cctpFee ?? 0n))}{' '}
                {token}
              </span>
              <FeeBreakdownTooltip
                fees={displayFees}
                isLoading={feeLoading}
                flowBreakdown={flowBreakdown}
              />
            </span>
          </div>
        ) : null}
      </div>
    </div>
  )
}
