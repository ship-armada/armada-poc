// ABOUTME: Observe-page status card — committer-styled adaptation of the admin StatusDashboard.
// ABOUTME: Phase + sale-size header, the sale progress bar (modeled on the hero Progress card), and the per-hop stats table (styled like the crowdfund participants list).

import {
  formatUsdc,
  phaseName,
  hopLabel,
  heroListHopColor,
  CROWDFUND_CONSTANTS,
  HOP_CONFIGS,
  estimateAllocation,
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
  const { MAX_SALE, MIN_SALE } = CROWDFUND_CONSTANTS
  const estimate = estimateAllocation(state.hopStats, state.cappedDemand, state.saleSize)

  // `state.saleSize` is 0 until finalize(); show the projected size (BASE/MAX by
  // demand) pre-finalization so the header isn't "$0" the whole active window.
  const projectedSaleSize = estimate.effectiveSaleSize
  const saleIsProjected = state.saleSize === 0n
  const saleLabel = projectedSaleSize > CROWDFUND_CONSTANTS.BASE_SALE ? 'EXPANDED' : 'BASE'

  // Sale progress bar — same math as the hero Progress card: a gradient fill up
  // to the min-raise threshold, an animated "over min" fill beyond it.
  const filledPct =
    MAX_SALE > 0n ? Math.max(0, Math.min(100, Number((state.totalCommitted * 100n) / MAX_SALE))) : 0
  const minRaisePct = MAX_SALE > 0n ? Number((MIN_SALE * 100n) / MAX_SALE) : 0
  const gradientFillPct = Math.min(filledPct, minRaisePct)
  const overMinFillPct = Math.max(0, filledPct - minRaisePct)
  const raisedTowardMin =
    MIN_SALE > 0n ? Math.max(0, Math.min(100, Number((state.totalCommitted * 100n) / MIN_SALE))) : 0
  const leftToMin = state.totalCommitted >= MIN_SALE ? 0n : MIN_SALE - state.totalCommitted

  return (
    <div className={styles.card}>
      {/* Phase + sale size */}
      <div className={styles.header}>
        <Tag label={phaseName(state.phase)} dot={phaseDot(state.phase)} />
        <span className={styles.saleSize}>
          {saleIsProjected ? 'Projected size' : 'Sale size'} {formatUsdc(projectedSaleSize)} ·{' '}
          {saleLabel}
        </span>
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
            {overMinFillPct > 0 && (
              <div
                className={styles.barFillOverMin}
                style={{ left: `${minRaisePct}%`, width: `${overMinFillPct}%` }}
              />
            )}
            <div className={styles.threshold} style={{ left: `${minRaisePct}%` }} />
          </div>
          <div className={styles.barLabels}>
            <div className={styles.labelLeft}>
              <span className={styles.stat}>
                <span className={styles.statValue}>{raisedTowardMin}%</span>
                <span className={styles.statKey}>RAISED</span>
              </span>
              <span className={styles.stat}>
                <span className={styles.statValue}>{formatUsdc(leftToMin)}</span>
                <span className={styles.statKey}>LEFT</span>
              </span>
            </div>
            <div className={styles.labelMinRaise} style={{ left: `${minRaisePct}%` }}>
              <span className={styles.stat}>
                <span className={styles.statValue}>{formatUsdc(MIN_SALE)}</span>
                <span className={styles.statKey}>MIN RAISE</span>
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
                <th>Hop</th>
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
                const cfg = hop < HOP_CONFIGS.length ? HOP_CONFIGS[hop] : null
                const isFloor = hop === 2
                // Hops 0/1 have a ceiling; hop-2 is the floor hop (no ceiling — it
                // absorbs leftover allocation from the other hops), so "fill vs
                // ceiling" doesn't apply and the Fill cell shows "Floor" instead.
                // The ceiling is projected off the *projected* sale size (BASE/MAX
                // until finalized) so the % is meaningful pre-finalization, since
                // `state.saleSize` is 0 until finalize() (matches Est. alloc).
                const effCeiling = estimate.perHopCeiling[hop] ?? 0n
                const fillPct =
                  effCeiling > 0n ? Number((stats.cappedCommitted * 10_000n) / effCeiling) / 100 : 0
                const fillClass =
                  fillPct <= 100 ? styles.fillOk : fillPct <= 120 ? styles.fillWarn : styles.fillOver
                const dotColor = heroListHopColor(hop === 0 ? 'SEED' : hop === 1 ? 'HOP-1' : 'HOP-2')
                return (
                  <tr key={hop}>
                    <td>
                      <span className={styles.hopCell}>
                        <span className={styles.dot} style={{ background: dotColor }} />
                        {hopLabel(hop)}
                      </span>
                    </td>
                    <td>{isFloor ? '15% floor' : `${(cfg?.ceilingBps ?? 0) / 100}% raw`}</td>
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
                      {isFloor ? 'Floor' : `${fillPct.toFixed(0)}%`}
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
