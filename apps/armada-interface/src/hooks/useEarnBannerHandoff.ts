// ABOUTME: Dashboard promo-banner handoff hooks — sequence the deposit tooltip and earn banner with
// ABOUTME: the balance/vault odometer rolls instead of swapping instantly. Ported from armada-app (5c2b3e8).

import { useEffect, useRef, useState } from 'react'
import {
  shieldBannerExitSettleMs,
  vaultBannerAfterDepositMs,
  vaultBannerAfterWithdrawMs,
} from '@/components/dashboard/BalanceCard/balanceRevealMotion'
import { formatUsdcAmount } from '@/components/dashboard/dashboardFormat'

export interface DepositTooltipHandoff {
  showDepositTooltip: boolean
  depositTooltipPersistVisible: boolean
  depositTooltipExiting: boolean
  revealEarnBanner: boolean
}

type ShieldPromoPhase = 'idle' | 'keep' | 'exit' | 'done'

/**
 * After a first shield, keep the deposit promo until the balance finishes rolling,
 * collapse it, then allow the earn banner to enter.
 */
export function useDepositTooltipHandoff(
  walletConnected: boolean,
  hasCompletedDeposit: boolean,
  dashboardBalance: number,
): DepositTooltipHandoff {
  const previousBalanceRef = useRef(dashboardBalance)
  const phaseRef = useRef<ShieldPromoPhase>('idle')
  const [, setHandoffEpoch] = useState(0)

  const previous = previousBalanceRef.current
  if (previous !== dashboardBalance) {
    if (previous <= 0 && dashboardBalance > 0) {
      phaseRef.current = 'keep'
    }
    previousBalanceRef.current = dashboardBalance
  }

  const phase = phaseRef.current

  useEffect(() => {
    if (phase !== 'keep') return
    const timer = window.setTimeout(() => {
      phaseRef.current = 'exit'
      setHandoffEpoch((epoch) => epoch + 1)
    }, vaultBannerAfterDepositMs(formatUsdcAmount(dashboardBalance)))
    return () => window.clearTimeout(timer)
  }, [phase, dashboardBalance])

  useEffect(() => {
    if (phase !== 'exit') return
    const timer = window.setTimeout(() => {
      phaseRef.current = 'done'
      setHandoffEpoch((epoch) => epoch + 1)
    }, shieldBannerExitSettleMs())
    return () => window.clearTimeout(timer)
  }, [phase])

  const natural = walletConnected && !hasCompletedDeposit && dashboardBalance <= 0
  const showDepositTooltip = natural || phase === 'keep' || phase === 'exit'

  return {
    showDepositTooltip,
    depositTooltipPersistVisible: phase === 'keep',
    depositTooltipExiting: phase === 'exit',
    revealEarnBanner: phase === 'done',
  }
}

export interface EarnBannerHandoff {
  showEarnBanner: boolean
  /** Grow the banner in immediately — do not reserve empty delayed-tooltip space. */
  earnBannerHandoffEnter: boolean
  /** Banner is already on screen — do not restart the page-load enter animation. */
  earnBannerPersistVisible: boolean
}

type Handoff = 'keep-banner' | 'keep-hidden'

/**
 * After a first vault deposit, keep the earn banner until the vault row has
 * appeared and the balances have finished rolling.
 * After a full vault withdraw, keep the banner hidden until the vault row has rolled
 * to zero, exited, and the post-exit pause has elapsed.
 *
 * Decides on the same render as the balance change so the banner slot cannot flash empty.
 */
export function useEarnBannerHandoff(
  walletConnected: boolean,
  hasCompletedDeposit: boolean,
  earningBalance: number,
  dashboardBalance: number,
): EarnBannerHandoff {
  const previousEarningRef = useRef(earningBalance)
  const handoffRef = useRef<Handoff | null>(null)
  const handoffEnterRef = useRef(false)
  const [, setHandoffEpoch] = useState(0)

  const previous = previousEarningRef.current
  if (previous !== earningBalance) {
    if (previous <= 0 && earningBalance > 0) {
      handoffRef.current = 'keep-banner'
      handoffEnterRef.current = false
    } else if (previous > 0 && earningBalance <= 0) {
      handoffRef.current = 'keep-hidden'
      handoffEnterRef.current = true
    } else {
      handoffRef.current = null
    }
    previousEarningRef.current = earningBalance
  }

  const handoff = handoffRef.current

  useEffect(() => {
    if (!handoff) return
    const delay =
      handoff === 'keep-banner'
        ? vaultBannerAfterDepositMs(formatUsdcAmount(Math.max(dashboardBalance, earningBalance)))
        : vaultBannerAfterWithdrawMs(formatUsdcAmount(dashboardBalance))
    const timer = window.setTimeout(() => {
      handoffRef.current = null
      setHandoffEpoch((epoch) => epoch + 1)
    }, delay)
    return () => window.clearTimeout(timer)
  }, [handoff, earningBalance, dashboardBalance])

  const eligible = walletConnected && hasCompletedDeposit
  let showEarnBanner = eligible && earningBalance <= 0
  if (handoff === 'keep-banner') showEarnBanner = eligible
  if (handoff === 'keep-hidden') showEarnBanner = false

  return {
    showEarnBanner,
    earnBannerHandoffEnter: showEarnBanner && handoffEnterRef.current,
    earnBannerPersistVisible: showEarnBanner && handoff === 'keep-banner',
  }
}
