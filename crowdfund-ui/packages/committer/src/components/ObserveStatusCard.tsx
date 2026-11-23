// ABOUTME: Observe-page status card — committer-styled adaptation of the admin StatusDashboard.
// ABOUTME: Phase + sale-size header, the sale progress bar (modeled on the hero Progress card), and the per-hop stats table (styled like the crowdfund participants list).

import {
  formatUsdc,
  phaseName,
  hopLabel,
  heroListHopColor,
  CROWDFUND_CONSTANTS,
  CROWDFUND_FEATURES,
  TIER_NOUN,
  HOP_CONFIGS,
  estimateAllocation,
  hop2HasFloor,
  hopCeilingLabel,
  type ContractState,
} from '@armada/crowdfund-shared'
import { Tag, BarTrackTicks } from '@armada/ui'
import styles from './ObserveStatusCard.module.css'

type TagDot = 'active' | 'warning' | 'error' | 'neutral' | 'lavender'

export interface ObserveStatusCardProps {
  state: ContractState
}

/** Phase → Tag dot: active (live), lavender (finalized), warning (cancelled). */
function phaseDot(phase: number): TagDot {
  if (phase === 1) return 'lavender'
  if (phase === 2) return 'warning'
  return 'active'
}

export function ObserveStatusCard({ state }: ObserveStatusCardProps) {
  const { MAX_SALE, MIN_SALE, BASE_SALE, FUNDING_GOAL } = CROWDFUND_CONSTANTS
  const allocationConfig = { constants: CROWDFUND_CONSTANTS, hopConfigs: HOP_CONFIGS }
  const estimate = estimateAllocation(state.hopStats, state.cappedDemand, state.saleSize, allocationConfig)
  // Waterfall profiles with a hop-2 floor show "Floor" instead of a fill % for hop 2.
  const hasFloor = hop2HasFloor(allocationConfig)
  // The sale-size badge only means something when the sale can expand.
  const canExpand = MAX_SALE !== BASE_SALE

  // `state.saleSize` is 0 until finalize(); show the projected size (BASE/MAX by
  // demand) pre-finalization so the header isn't "$0" the whole active window.
  const projectedSaleSize = estimate.effectiveSaleSize
  const saleIsProjected = state.saleSize === 0n
  const saleLabel = projectedSaleSize > BASE_SALE ? 'EXPANDED' : 'BASE'

  // Sale progress bar — same math as the hero Progress card: the bar scales to MAX_SALE, with a
  // gradient fill up to the funding-goal tick and an "over goal" fill beyond it.
  const filledPct =
    MAX_SALE > 0n ? Math.max(0, Math.min(100, Number((state.totalCommitted * 100n) / MAX_SALE))) : 0
  const goalPct = MAX_SALE > 0n ? Number((FUNDING_GOAL * 100n) / MAX_SALE) : 0
  const gradientFillPct = Math.min(filledPct, goalPct)
  const overGoalFillPct = Math.max(0, filledPct - goalPct)
  // FUNDED and LEFT measure progress toward the goal; FUNDED can pass 100% and LEFT is hidden once
  // the goal is met. The goal and the contract's minimum are their own stats beside them.
  const fundedTowardGoal = FUNDING_GOAL > 0n ? Number((state.totalCommitted * 100n) / FUNDING_GOAL) : 0
  const leftToGoal = state.totalCommitted >= FUNDING_GOAL ? 0n : FUNDING_GOAL - state.totalCommitted

  return (
    <div className={styles.card}>
      {/* Phase + sale size. The size line only informs where the sale can expand; otherwise it is
          always MAX_SALE, already shown as "of … max" below. */}
      <div className={styles.header}>
        <Tag label={phaseName(state.phase)} dot={phaseDot(state.phase)} />
        {canExpand && (
          <span className={styles.saleSize}>
            {saleIsProjected ? 'Projected size' : 'Sale size'} {formatUsdc(projectedSaleSize)} · {saleLabel}
          </span>
        )}
      </div>

      {/* Sale progress bar — modeled on the hero Progress card */}
      <div className={styles.progress}>
        <div className={styles.progressHead}>
          <span className={styles.progressKey}>Total committed</span>
          <span className={styles.progressMax}>of {formatUsdc(MAX_SALE)} max</span>
        </div>
        <p className={styles.progressAmount}>{formatUsdc(state.totalCommitted)}</p>
        <div className={styles.barWrapper}>
          <div className={styles.barTrack}>
            <BarTrackTicks />
            <div className={styles.barFillGradient} style={{ width: `${gradientFillPct}%` }} />
            {overGoalFillPct > 0 && (
              <div
                className={styles.barFillOverMin}
                style={{ left: `${goalPct}%`, width: `${overGoalFillPct}%` }}
              />
            )}
            <div className={styles.threshold} style={{ left: `${goalPct}%` }} />
          </div>
          <div className={styles.barLabels}>
            <div className={styles.labelLeft}>
              <span className={styles.stat}>
                <span className={styles.statValue}>{fundedTowardGoal}%</span>
                <span className={styles.statKey}>FUNDED</span>
              </span>
              {leftToGoal > 0n && (
                <span className={styles.stat}>
                  <span className={styles.statValue}>{formatUsdc(leftToGoal)}</span>
                  <span className={styles.statKey}>LEFT</span>
                </span>
              )}
              <span className={styles.stat}>
                <span className={styles.statValue}>{formatUsdc(FUNDING_GOAL)}</span>
                <span className={styles.statKey}>GOAL</span>
              </span>
              <span className={styles.stat}>
                <span className={styles.statValue}>{formatUsdc(MIN_SALE)}</span>
                <span className={styles.statKey}>MIN</span>
              </span>
            </div>
          </div>
        </div>
      </div>

      {/* Per-hop stats — styled like the crowdfund participants list */}
      <div className={styles.tableShell}>
        <div className={styles.tableScroll}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th>{TIER_NOUN}</th>
                <th>Ceiling</th>
                <th>Cap/slot</th>
                <th>Whitelist</th>
                <th>Committers</th>
                <th>Committed</th>
                <th>Capped</th>
                <th>Est. alloc</th>
                <th>Fill</th>
              </tr>
            </thead>
            <tbody>
              {state.hopStats.map((stats, hop) => {
                // Team inviter wallets (hop 1) are hidden from public views on profiles that hide them.
                if (hop === 1 && CROWDFUND_FEATURES.hideTeamWallets) return null
                const cfg = hop < HOP_CONFIGS.length ? HOP_CONFIGS[hop] : null
                const isFloor = hop === 2 && hasFloor
                // Fill is capped demand against the hop's effective ceiling: the most it can
                // absorb given the other hops' demand (under the waterfall, its bps ceiling or
                // hop 2's rollover; under the hop-2 reserve model, its allocation plus any
                // unallocated capacity). With a hop-2 floor configured, "fill vs ceiling"
                // doesn't apply and the Fill cell shows "Floor". The ceiling is computed off
                // the *projected* sale size (BASE/MAX until finalized) so the % is meaningful
                // pre-finalization, since `state.saleSize` is 0 until finalize() (matches
                // Est. alloc).
                const effCeiling = estimate.perHopCeiling[hop] ?? 0n
                const fillPct =
                  effCeiling > 0n ? Number((stats.cappedCommitted * 10_000n) / effCeiling) / 100 : 0
                const fillClass =
                  fillPct <= 100 ? styles.fillOk : fillPct <= 120 ? styles.fillWarn : styles.fillOver
                const dotColor = heroListHopColor(hop === 0 ? 'HOP-0' : hop === 1 ? 'HOP-1' : 'HOP-2')
                return (
                  <tr key={hop}>
                    <td>
                      <span className={styles.hopCell}>
                        <span className={styles.dot} style={{ background: dotColor }} />
                        {hopLabel(hop)}
                      </span>
                    </td>
                    <td>{hopCeilingLabel(hop, allocationConfig)}</td>
                    <td>{cfg ? formatUsdc(cfg.capUsdc) : '—'}</td>
                    <td>
                      {hop === 0
                        ? `${stats.whitelistCount}/${CROWDFUND_CONSTANTS.MAX_SEEDS}`
                        : stats.whitelistCount}
                    </td>
                    <td>{stats.uniqueCommitters}</td>
                    <td>{formatUsdc(stats.totalCommitted)}</td>
                    <td>{formatUsdc(stats.cappedCommitted)}</td>
                    <td>{formatUsdc(estimate.perHopAlloc[hop])}</td>
                    <td className={isFloor ? styles.fillFloor : fillClass}>
                      {isFloor
                        ? 'Floor'
                        : effCeiling === 0n && stats.cappedCommitted > 0n
                          ? '—' // no capacity left for this hop (e.g. crowded out by earlier hops)
                          : `${fillPct.toFixed(0)}%`}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}
