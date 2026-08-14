// ABOUTME: Primary dashboard card showing the private USDC balance with reveal animations, actions, and vault position.
// ABOUTME: Ported from the armada-app design mockup.
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import {
  ArrowDownIcon,
  ArrowLeftIcon,
  ChartBarIcon,
  EllipsisHorizontalIcon,
  EyeIcon,
  EyeSlashIcon,
  PlusIcon,
  QueueListIcon,
} from '@heroicons/react/24/outline'
import { ShieldedUsdcBadge } from '@/components/dashboard/ShieldedUsdcBadge'
import { IconButton } from '@/design'
import { RollingBalanceValue, type BalanceRollMode } from '@/components/dashboard/RollingBalanceValue'
import { BalanceScrambleValue } from '@/components/dashboard/BalanceScrambleValue'
import {
  BALANCE_REVEAL_DELAY_MS,
  BALANCE_REVEAL_DURATION_MS,
  BALANCE_ROLL_DIGIT_STAGGER_MS,
  balanceRevealRollDurationMs,
} from './balanceRevealMotion'
import { SendButton } from '@/components/dashboard/SendButton'
import { Tooltip } from '@/design'
import { BottomSheet, afterBottomSheetHandoff } from '@/design'
import { VaultPositionBar } from '@/components/dashboard/VaultPositionBar'
import { useDashboardBackground } from '@/hooks/useDashboardBackground'
import { useMobileLayout } from '@/hooks/useMobileLayout'
import { formatUsdcAmount, truncateArmadaAddress } from '@/components/dashboard/dashboardFormat'
import styles from './BalanceCard.module.css'

const SHIELDED_BALANCE_BADGE_PX =
  /* spacing-10 − spacing-1 — keep in sync with BalanceCard.module.css .shieldedBalanceBadge */
  36

export type BalanceCardActionLayout = 'default' | 'v2'

export interface BalanceCardProps {
  balance: number
  balanceRollTrigger?: number
  balanceRollMode?: BalanceRollMode
  balanceRollFromValue?: string
  /** When true, show hide/show activity in the ellipses menu. */
  hasActivityItems?: boolean
  /** v2: deposit in ellipses menu; request as lavender pill beside send. */
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

const BALANCE_BASE_FONT_SIZE_PX = 40
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

interface BalanceCardMoreMenuItemsProps {
  isV2Actions: boolean
  hasActivityItems: boolean
  activityVisible: boolean
  canWithdraw: boolean
  /** APR meta shown beside the Earn item (e.g. "4.2% APR"); omitted when the rate is unknown. */
  earnMeta?: string
  onDeposit?: () => void
  onEarn?: () => void
  onWithdraw?: () => void
  onToggleActivity?: () => void
  /** Close the menu; on mobile, pass the action to run after the sheet exits. */
  onSelect: (action: () => void) => void
}

function BalanceCardMoreMenuItems({
  isV2Actions,
  hasActivityItems,
  activityVisible,
  canWithdraw,
  earnMeta,
  onDeposit,
  onEarn,
  onWithdraw,
  onToggleActivity,
  onSelect,
}: BalanceCardMoreMenuItemsProps) {
  function run(action?: () => void) {
    if (!action) return
    onSelect(action)
  }

  return (
    <>
      {isV2Actions ? (
        <button
          type="button"
          className={styles.moreMenuItem}
          role="menuitem"
          onClick={() => run(onDeposit)}
          data-testing-click="deposit_button"
        >
          <span className={styles.moreMenuItemLead}>
            <span className={styles.moreMenuIconBadge}>
              <PlusIcon className={styles.moreMenuIcon} strokeWidth={1.5} />
            </span>
            <span className={styles.moreMenuLabel}>Deposit</span>
          </span>
        </button>
      ) : null}
      <button
        type="button"
        className={styles.moreMenuItem}
        role="menuitem"
        onClick={() => run(onEarn)}
        data-testing-click="vault_open_button"
      >
        <span className={styles.moreMenuItemLead}>
          <span className={styles.moreMenuIconBadge}>
            <ChartBarIcon className={styles.moreMenuIcon} strokeWidth={1.5} />
          </span>
          <span className={styles.moreMenuLabel}>Earn</span>
        </span>
        {earnMeta ? <span className={styles.moreMenuMeta}>{earnMeta}</span> : null}
      </button>
        <button
          type="button"
          className={styles.moreMenuItem}
          role="menuitem"
          disabled={!canWithdraw}
          onClick={() => run(onWithdraw)}
          data-testing-click="withdraw_og_button"
        >
        <span className={styles.moreMenuItemLead}>
          <span className={styles.moreMenuIconBadge}>
            <ArrowLeftIcon className={styles.moreMenuIcon} strokeWidth={1.5} />
          </span>
          <span className={styles.moreMenuLabel}>Withdraw</span>
        </span>
      </button>
      {hasActivityItems ? (
        <button
          type="button"
          className={styles.moreMenuItem}
          role="menuitem"
          onClick={() => run(onToggleActivity)}
        >
          <span className={styles.moreMenuItemLead}>
            <span className={styles.moreMenuIconBadge}>
              <QueueListIcon className={styles.moreMenuIcon} strokeWidth={1.5} />
            </span>
            <span className={styles.moreMenuLabel}>
              {activityVisible ? 'Hide activity' : 'Show activity'}
            </span>
          </span>
        </button>
      ) : null}
    </>
  )
}

export function BalanceCard({
  balance,
  balanceRollTrigger = 0,
  balanceRollMode = 'fromZero',
  balanceRollFromValue,
  hasActivityItems = false,
  actionLayout = 'default',
  onSend,
  onDeposit,
  onRequest,
  onEarn,
  onWithdraw,
  vaultBalance = 0,
  vaultApy,
  vaultRollFromValue,
  onVaultOpen,
  activityVisible = false,
  onToggleActivity,
  balanceHidden: balanceHiddenProp,
  onBalanceHiddenChange,
  armadaAddress,
}: BalanceCardProps) {
  const isV2Actions = actionLayout === 'v2'
  const isMobileLayout = useMobileLayout()
  const hasFunds = balance > 0
  const [background] = useDashboardBackground()
  const isSolidBackground = background === 'solid'
  const [moreMenuOpen, setMoreMenuOpen] = useState(false)
  const [moreMenuHoverSuppressed, setMoreMenuHoverSuppressed] = useState(false)
  const moreMenuRootRef = useRef<HTMLDivElement>(null)
  const pendingMoreActionRef = useRef<(() => void) | null>(null)
  const moreActionHandoffTimerRef = useRef<number | null>(null)
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
      if (moreActionHandoffTimerRef.current) window.clearTimeout(moreActionHandoffTimerRef.current)
    }
  }, [])

  useEffect(() => {
    if (!moreMenuOpen || isMobileLayout) return

    function handlePointerDown(event: PointerEvent) {
      const target = event.target
      if (!(target instanceof Node)) return
      if (moreMenuRootRef.current?.contains(target)) return
      setMoreMenuOpen(false)
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') setMoreMenuOpen(false)
    }

    window.addEventListener('pointerdown', handlePointerDown)
    window.addEventListener('keydown', handleKeyDown)
    return () => {
      window.removeEventListener('pointerdown', handlePointerDown)
      window.removeEventListener('keydown', handleKeyDown)
    }
  }, [moreMenuOpen, isMobileLayout])

  function toggleMoreMenu() {
    if (isMobileLayout) {
      setMoreMenuOpen((open) => !open)
      return
    }

    setMoreMenuOpen(false)
    setMoreMenuHoverSuppressed(true)
  }

  function closeMoreMenu() {
    setMoreMenuOpen(false)
    setMoreMenuHoverSuppressed(true)
    const active = document.activeElement
    if (active instanceof HTMLElement && moreMenuRootRef.current?.contains(active)) {
      active.blur()
    }
  }

  function requestMoreMenuAction(action: () => void) {
    if (!isMobileLayout) {
      closeMoreMenu()
      action()
      return
    }
    pendingMoreActionRef.current = action
    closeMoreMenu()
  }

  function handleMoreMenuExited() {
    const action = pendingMoreActionRef.current
    pendingMoreActionRef.current = null
    if (!action) return
    if (moreActionHandoffTimerRef.current) window.clearTimeout(moreActionHandoffTimerRef.current)
    moreActionHandoffTimerRef.current = afterBottomSheetHandoff(() => {
      moreActionHandoffTimerRef.current = null
      action()
    })
  }

  function handleMoreMenuPointerLeave() {
    setMoreMenuHoverSuppressed(false)
  }

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

  const formattedBalance = formatUsdcAmount(balance)

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
  const sendClassName = [styles.sendButton, !hasFunds && styles.actionAmber]
    .filter(Boolean)
    .join(' ')

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

  const moreMenuItems = (
    <BalanceCardMoreMenuItems
      isV2Actions={isV2Actions}
      hasActivityItems={hasActivityItems}
      activityVisible={activityVisible}
      canWithdraw={hasFunds}
      earnMeta={vaultApy !== undefined ? `${vaultApy.toFixed(1)}% APR` : undefined}
      onDeposit={onDeposit}
      onEarn={onEarn}
      onWithdraw={onWithdraw}
      onToggleActivity={onToggleActivity}
      onSelect={requestMoreMenuAction}
    />
  )

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

  const shieldedBalanceBadge = (
    <ShieldedUsdcBadge size={SHIELDED_BALANCE_BADGE_PX} className={styles.shieldedBalanceBadge} />
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
      <svg
        className={styles.cardStrokeSvg}
        aria-hidden="true"
        xmlns="http://www.w3.org/2000/svg"
      >
        <defs>
          <linearGradient id="balanceCardStroke" x1="0%" y1="0%" x2="100%" y2="0%">
            <stop offset="0%" stopColor="var(--primitives-color-purple-300)" />
            <stop offset="100%" stopColor="var(--primitives-color-amber-300)" />
          </linearGradient>
        </defs>
        <rect
          className={styles.cardStrokeRect}
          x="2"
          y="2"
          width="99%"
          height="99%"
          rx="20"
          ry="20"
          fill="none"
          stroke="url(#balanceCardStroke)"
          strokeWidth="2"
        />
      </svg>
      <div
        className={[styles.card, isSolidBackground && styles.cardSolid].filter(Boolean).join(' ')}
      >
        <div className={styles.cardBodyTop}>
          <div className={styles.topRow}>
            {isMobileLayout ? (
              shieldedBalanceBadge
            ) : (
              <Tooltip variant="centered" content="This is your shielded balance">
                {shieldedBalanceBadge}
              </Tooltip>
            )}
            <div className={styles.labelStack}>
              {armadaAddress ? (
                <button
                  type="button"
                  className={[
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
                  {armadaAddressCopied
                    ? 'Copied'
                    : truncateArmadaAddress(armadaAddress)}
                </button>
              ) : null}
              <span className={styles.label}>Private USDC Balance</span>
            </div>
            <button
              type="button"
              className={`${styles.iconBadge} ${styles.eyeBadge}`}
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
          </div>
        </div>

        <div className={styles.cardBodyBalance}>
          <div className={styles.balanceRow} ref={balanceRowRef} {...balancePeekHandlers}>
            {balanceIntroPlaying ? (
              <div className={[styles.balanceCluster, styles.balanceClusterIntro].join(' ')}>
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
              >
                {balanceClusterLayers}
              </div>
            )}
          </div>
        </div>

        <div className={styles.cardFooter}>
          <div
            className={[styles.actionRow, isV2Actions && styles.actionRowV2].filter(Boolean).join(' ')}
          >
          <div className={styles.actionEnter}>
            <SendButton
              variant={hasFunds ? 'gradient' : 'solid'}
              className={sendClassName}
              onClick={onSend}
              testingClickId="send_button"
            />
          </div>
          {isV2Actions ? (
            <div className={styles.actionEnter}>
              <SendButton
                variant="lavender"
                label="REQUEST"
                icon={<ArrowDownIcon className={styles.pillIcon} strokeWidth={1.5} />}
                className={sendClassName}
                onClick={onRequest}
                testingClickId="request_button"
              />
            </div>
          ) : (
            <>
              <div className={styles.actionEnter}>
                {isMobileLayout ? (
                  <IconButton
                    variant={hasFunds ? 'solid' : 'gradient'}
                    className={hasFunds ? styles.actionAmber : undefined}
                    icon={<PlusIcon className={styles.actionIcon} strokeWidth={1.5} />}
                    aria-label="Deposit"
                    onClick={onDeposit}
                    testingClickId="deposit_button"
                  />
                ) : (
                  <Tooltip variant="action" content="Deposit">
                    <IconButton
                      variant={hasFunds ? 'solid' : 'gradient'}
                      className={hasFunds ? styles.actionAmber : undefined}
                      icon={<PlusIcon className={styles.actionIcon} strokeWidth={1.5} />}
                      aria-label="Deposit"
                      onClick={onDeposit}
                      testingClickId="deposit_button"
                    />
                  </Tooltip>
                )}
              </div>
              <div className={styles.actionEnter}>
                {isMobileLayout ? (
                  <IconButton
                    variant="solid"
                    className={styles.actionAmber}
                    icon={<ArrowDownIcon className={styles.actionIcon} strokeWidth={1.5} />}
                    aria-label="Request"
                    onClick={onRequest}
                  />
                ) : (
                  <Tooltip variant="action" content="Request">
                    <IconButton
                      variant="solid"
                      className={styles.actionAmber}
                      icon={<ArrowDownIcon className={styles.actionIcon} strokeWidth={1.5} />}
                      aria-label="Request"
                      onClick={onRequest}
                    />
                  </Tooltip>
                )}
              </div>
            </>
          )}
          <div className={styles.actionEnter}>
            <div
              ref={moreMenuRootRef}
              className={styles.moreMenuRoot}
              data-menu-open={moreMenuOpen ? 'true' : 'false'}
              data-hover-suppressed={moreMenuHoverSuppressed ? 'true' : 'false'}
              onPointerLeave={handleMoreMenuPointerLeave}
            >
              {!isMobileLayout ? (
                <div className={styles.moreMenu} role="menu" aria-label="More options">
                  {moreMenuItems}
                </div>
              ) : null}
              <IconButton
                variant="ghost"
                className={styles.actionMore}
                icon={<EllipsisHorizontalIcon className={styles.actionIcon} strokeWidth={2} />}
                aria-label="More options"
                aria-expanded={moreMenuOpen}
                aria-haspopup="menu"
                onClick={toggleMoreMenu}
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
              {...balancePeekHandlers}
            >
              <VaultPositionBar
                balance={vaultBalance}
                apy={vaultApy}
                vaultRollActive={vaultTransferRollActive}
                vaultRollFromValue={vaultRollFromValue}
                vaultRollTrigger={balanceRollTrigger}
                balanceRevealed={showBalance}
                onOpen={onVaultOpen ?? onEarn}
              />
            </div>
          ) : null}
        </div>
      </div>

      {isMobileLayout ? (
        <BottomSheet
          open={moreMenuOpen}
          onClose={() => {
            pendingMoreActionRef.current = null
            closeMoreMenu()
          }}
          onExited={handleMoreMenuExited}
          ariaLabel="More options"
        >
          <div className={styles.moreMenuSheet} role="menu">
            {moreMenuItems}
          </div>
        </BottomSheet>
      ) : null}
    </div>
  )
}
