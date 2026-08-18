// ABOUTME: Private-USDC balance card — address + animated balance + Shield/Send/Request/Earn action row + optional vault position bar.
// ABOUTME: Ported from the armada-app design mockup (polish update). Presentational; Dashboard.tsx wires real data + actions.
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import {
  ArrowDownIcon,
  ArrowRightIcon,
  ChartBarIcon,
  EyeIcon,
  EyeSlashIcon,
  PlusIcon,
} from '@heroicons/react/24/outline'
import { BalanceActionButton } from '@/components/dashboard/BalanceActionButton'
import { RollingBalanceValue, type BalanceRollMode } from '@/components/dashboard/RollingBalanceValue'
import { BalanceScrambleValue } from '@/components/dashboard/BalanceScrambleValue'
import {
  BALANCE_REVEAL_DELAY_MS,
  BALANCE_REVEAL_DURATION_MS,
  BALANCE_ROLL_DIGIT_STAGGER_MS,
  balanceRevealRollDurationMs,
} from './balanceRevealMotion'
import { VaultPositionBar } from '@/components/dashboard/VaultPositionBar'
import { useDashboardBackground } from '@/hooks/useDashboardBackground'
import { useMobileLayout } from '@/hooks/useMobileLayout'
import { formatUsdcAmount, truncateArmadaAddress } from '@/components/dashboard/dashboardFormat'
import styles from './BalanceCard.module.css'

export type BalanceCardActionLayout = 'default' | 'v2'

export interface BalanceCardProps {
  balance: number
  balanceRollTrigger?: number
  balanceRollMode?: BalanceRollMode
  balanceRollFromValue?: string
  /** When true, show hide/show activity in the ellipses menu. */
  hasActivityItems?: boolean
  /** Kept for callers; action row is the same on both dashboard versions. */
  actionLayout?: BalanceCardActionLayout
  onSend?: () => void
  onDeposit?: () => void
  onRequest?: () => void
  onMore?: () => void
  onEarn?: () => void
  onWithdraw?: () => void
  vaultBalance?: number
  vaultApy?: number
  vaultRollFromValue?: string
  onVaultOpen?: () => void
  activityVisible?: boolean
  onToggleActivity?: () => void
  balanceHidden?: boolean
  onBalanceHiddenChange?: (hidden: boolean) => void
  /** User's shielded Armada address — shown above the balance label when set. */
  armadaAddress?: string
}

function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined') return false
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

const BALANCE_BASE_FONT_SIZE_PX = 44
const BALANCE_MIN_FONT_SIZE_PX = 24

function fitBalanceFontSize(rowWidth: number, naturalTextWidth: number): number {
  const maxTextWidth = Math.max(0, rowWidth)
  if (maxTextWidth === 0 || naturalTextWidth <= maxTextWidth) {
    return BALANCE_BASE_FONT_SIZE_PX
  }

  const scaled = (BALANCE_BASE_FONT_SIZE_PX * maxTextWidth) / naturalTextWidth
  return Math.max(BALANCE_MIN_FONT_SIZE_PX, scaled)
}

function estimateDepositRollDurationMs(formattedBalance: string): number {
  const digitCount = formattedBalance.replace(/\D/g, '').length
  const stagger = Math.max(0, digitCount - 1) * BALANCE_ROLL_DIGIT_STAGGER_MS
  return balanceRevealRollDurationMs() + stagger + 80
}

export function BalanceCard({
  balance,
  balanceRollTrigger = 0,
  balanceRollMode = 'fromZero',
  balanceRollFromValue,
  onSend,
  onDeposit,
  onRequest,
  onEarn,
  vaultBalance = 0,
  vaultApy,
  vaultRollFromValue,
  onVaultOpen,
  balanceHidden: balanceHiddenProp,
  onBalanceHiddenChange,
  armadaAddress,
}: BalanceCardProps) {
  const isMobileLayout = useMobileLayout()
  const [background] = useDashboardBackground()
  const isSolidBackground = background === 'solid'
  const [internalBalanceHidden, setInternalBalanceHidden] = useState(false)
  const balanceHiddenControlled = balanceHiddenProp !== undefined
  const balanceHidden = balanceHiddenControlled ? balanceHiddenProp : internalBalanceHidden
  const setBalanceHidden = (next: boolean | ((hidden: boolean) => boolean)) => {
    const resolved = typeof next === 'function' ? next(balanceHidden) : next
    onBalanceHiddenChange?.(resolved)
    if (!balanceHiddenControlled) {
      setInternalBalanceHidden(resolved)
    }
  }
  const [peekBalance, setPeekBalance] = useState(false)
  const [balanceIntroPlaying, setBalanceIntroPlaying] = useState(() => !prefersReducedMotion())
  const balanceRowRef = useRef<HTMLDivElement>(null)
  const balanceValueRef = useRef<HTMLSpanElement>(null)
  const balanceValueSizerRef = useRef<HTMLSpanElement>(null)
  const [balanceFontSize, setBalanceFontSize] = useState(BALANCE_BASE_FONT_SIZE_PX)
  const [lockedWidth, setLockedWidth] = useState<number | null>(null)
  const [completedRollTrigger, setCompletedRollTrigger] = useState(0)
  const [armadaAddressCopied, setArmadaAddressCopied] = useState(false)
  const armadaAddressCopyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    return () => {
      if (armadaAddressCopyTimerRef.current) clearTimeout(armadaAddressCopyTimerRef.current)
    }
  }, [])

  async function copyArmadaAddress() {
    if (!armadaAddress) return
    try {
      await navigator.clipboard.writeText(armadaAddress)
      setArmadaAddressCopied(true)
      if (armadaAddressCopyTimerRef.current) clearTimeout(armadaAddressCopyTimerRef.current)
      armadaAddressCopyTimerRef.current = setTimeout(() => setArmadaAddressCopied(false), 2000)
    } catch {
      setArmadaAddressCopied(false)
    }
  }

  useEffect(() => {
    if (!balanceIntroPlaying) return
    const timer = window.setTimeout(
      () => setBalanceIntroPlaying(false),
      BALANCE_REVEAL_DELAY_MS + BALANCE_REVEAL_DURATION_MS + 50,
    )
    return () => window.clearTimeout(timer)
  }, [balanceIntroPlaying])

  // Show full USDC precision (up to 6 decimals, trailing zeros trimmed) rather than the mockup's
  // 2-decimal truncation — a shielded balance should never look rounded.
  const formattedBalance = formatUsdcAmount(balance, 6)

  useEffect(() => {
    if (balanceRollTrigger <= completedRollTrigger) return

    const timer = window.setTimeout(
      () => setCompletedRollTrigger(balanceRollTrigger),
      estimateDepositRollDurationMs(formattedBalance),
    )
    return () => window.clearTimeout(timer)
  }, [balanceRollTrigger, completedRollTrigger, formattedBalance])

  useLayoutEffect(() => {
    if (balanceIntroPlaying) return
    const width = balanceValueSizerRef.current?.scrollWidth
    if (!width) return
    setLockedWidth(width)
  }, [balanceIntroPlaying, formattedBalance, balanceFontSize])

  useLayoutEffect(() => {
    if (balanceIntroPlaying) {
      setBalanceFontSize(BALANCE_BASE_FONT_SIZE_PX)
      return
    }

    const row = balanceRowRef.current
    const balanceValue = balanceValueRef.current
    const sizer = balanceValueSizerRef.current
    if (!row || !balanceValue || !sizer) return

    const updateFit = () => {
      balanceValue.style.setProperty('font-size', `${BALANCE_BASE_FONT_SIZE_PX}px`)
      balanceValue.style.setProperty('line-height', `${BALANCE_BASE_FONT_SIZE_PX}px`)
      const naturalWidth = sizer.scrollWidth
      balanceValue.style.removeProperty('font-size')
      balanceValue.style.removeProperty('line-height')
      setBalanceFontSize(fitBalanceFontSize(row.clientWidth, naturalWidth))
    }

    updateFit()

    const observer = new ResizeObserver(updateFit)
    observer.observe(row)
    return () => observer.disconnect()
  }, [formattedBalance, balanceIntroPlaying])

  const showBalance = !balanceHidden || peekBalance
  const depositRollActive =
    !balanceIntroPlaying &&
    showBalance &&
    !balanceHidden &&
    balance > 0 &&
    balanceRollTrigger > completedRollTrigger
  const vaultTransferRollActive =
    !balanceIntroPlaying &&
    vaultRollFromValue !== undefined &&
    balanceRollTrigger > completedRollTrigger
  const showRollingBalance = balanceIntroPlaying || depositRollActive
  const lockBalanceWidth = showRollingBalance || vaultTransferRollActive

  function revealBalancePeek() {
    if (balanceHidden) setPeekBalance(true)
  }

  function hideBalancePeek() {
    setPeekBalance(false)
  }

  const balancePeekHandlers = isMobileLayout
    ? {
        onPointerDown: revealBalancePeek,
        onPointerUp: hideBalancePeek,
        onPointerCancel: hideBalancePeek,
      }
    : {
        onMouseEnter: revealBalancePeek,
        onMouseLeave: hideBalancePeek,
      }

  const balanceClusterLayers = (
    <span
      ref={balanceValueRef}
      className={styles.balanceValue}
      style={
        {
          '--balance-font-size': `${balanceFontSize}px`,
          ...(balanceIntroPlaying
            ? undefined
            : lockBalanceWidth
              ? { width: lockedWidth ?? 'max-content' }
              : undefined),
        } as React.CSSProperties
      }
      aria-label={showBalance ? formattedBalance : 'Balance hidden'}
    >
      <span ref={balanceValueSizerRef} className={styles.balanceValueSizer} aria-hidden>
        {formattedBalance}
      </span>
      <span className={[styles.balanceValueLayer, styles.balanceValueLayerVisible].join(' ')}>
        {showRollingBalance ? (
          <RollingBalanceValue
            value={formattedBalance}
            enableRoll={balanceIntroPlaying ? balance > 0 : depositRollActive}
            mode={balanceRollMode}
            fromValue={balanceRollFromValue}
            rollTrigger={balanceRollTrigger}
          />
        ) : (
          <BalanceScrambleValue value={formattedBalance} revealed={showBalance} />
        )}
      </span>
    </span>
  )

  const showVaultPosition = vaultBalance > 0 || vaultTransferRollActive
  const vaultBarWasRevealed = useRef(vaultBalance > 0)
  const shouldAnimateVaultEnter =
    showVaultPosition && !vaultBarWasRevealed.current && !vaultTransferRollActive

  if (showVaultPosition) {
    vaultBarWasRevealed.current = true
  } else {
    vaultBarWasRevealed.current = false
  }

  return (
    <div className={styles.cardShell}>
      <div
        className={[styles.card, isSolidBackground && styles.cardSolid].filter(Boolean).join(' ')}
      >
        <button
          type="button"
          className={styles.visibilityToggle}
          aria-label={balanceHidden ? 'Show balance' : 'Hide balance'}
          aria-pressed={balanceHidden}
          onClick={() => {
            setBalanceHidden((hidden) => !hidden)
            setPeekBalance(false)
          }}
        >
          {balanceHidden ? (
            <EyeSlashIcon className={styles.badgeIcon} strokeWidth={1.5} aria-hidden />
          ) : (
            <EyeIcon className={styles.badgeIcon} strokeWidth={1.5} aria-hidden />
          )}
        </button>

        <div className={styles.contentArea}>
          <div className={styles.headerBlock}>
            <div className={styles.headingStack}>
              {armadaAddress ? (
                <button
                  type="button"
                  className={[
                    'armada-text-ui-label-md',
                    styles.armadaAddress,
                    armadaAddressCopied && styles.armadaAddressCopied,
                  ]
                    .filter(Boolean)
                    .join(' ')}
                  onClick={() => void copyArmadaAddress()}
                  title={armadaAddressCopied ? undefined : armadaAddress}
                  aria-label={
                    armadaAddressCopied
                      ? 'Address copied'
                      : `Copy Armada address ${truncateArmadaAddress(armadaAddress)}`
                  }
                >
                  {armadaAddressCopied ? 'Copied' : truncateArmadaAddress(armadaAddress)}
                </button>
              ) : null}
              <div className={styles.balanceStack}>
                <span className={`armada-text-ui-label-md ${styles.label}`}>USDC shielded balance</span>
                <div className={styles.balanceRow} ref={balanceRowRef}>
                  {balanceIntroPlaying ? (
                    <div
                      className={[styles.balanceCluster, styles.balanceClusterIntro].join(' ')}
                      {...balancePeekHandlers}
                    >
                      {balanceClusterLayers}
                    </div>
                  ) : (
                    <div
                      className={[
                        styles.balanceCluster,
                        styles.balanceClusterStable,
                        balanceHidden && styles.balanceClusterPrivate,
                      ]
                        .filter(Boolean)
                        .join(' ')}
                      {...balancePeekHandlers}
                    >
                      {balanceClusterLayers}
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>

          <div className={styles.actionRow}>
            <div className={styles.actionEnter}>
              <BalanceActionButton
                variant="primary"
                label="Shield"
                icon={<PlusIcon strokeWidth={1.5} />}
                onClick={onDeposit}
                testingClickId="deposit_button"
              />
            </div>
            <div className={styles.actionEnter}>
              <BalanceActionButton
                label="Send"
                icon={<ArrowRightIcon strokeWidth={1.5} />}
                onClick={onSend}
                testingClickId="send_button"
              />
            </div>
            <div className={styles.actionEnter}>
              <BalanceActionButton
                label="Request"
                icon={<ArrowDownIcon strokeWidth={1.5} />}
                onClick={onRequest}
                testingClickId="request_button"
              />
            </div>
            <div className={styles.actionEnter}>
              <BalanceActionButton
                label="Earn"
                icon={<ChartBarIcon strokeWidth={1.5} />}
                onClick={onEarn}
                testingClickId="vault_open_button"
              />
            </div>
          </div>
        </div>

        {showVaultPosition ? (
          <div
            className={[
              styles.vaultPositionWrap,
              shouldAnimateVaultEnter ? styles.vaultPositionEnter : styles.vaultPositionVisible,
            ].join(' ')}
          >
            <VaultPositionBar
              balance={vaultBalance}
              apy={vaultApy}
              vaultRollActive={vaultTransferRollActive}
              vaultRollFromValue={vaultRollFromValue}
              vaultRollTrigger={balanceRollTrigger}
              balanceHidden={balanceHidden}
              onOpen={onVaultOpen ?? onEarn}
            />
          </div>
        ) : null}
      </div>
    </div>
  )
}
