// ABOUTME: Ported from the armada-crowdfund mockup (components/MyPosition/MyPositionSplit.tsx).
// ABOUTME: Header rendering is exposed via a `header` slot prop (default falls back to @armada/ui's Header) so consuming apps render only one chrome instead of two.

import { useMemo, useState, type ReactNode } from 'react'
import styles from './MyPositionSplit.module.css'
import { Header } from '@armada/ui'
import { Tag } from '@armada/ui'
import { InformationCircleIcon } from '@heroicons/react/24/solid'
import { Tooltip } from '@armada/ui'
import SlotCard from '../InviteFlow/screens/SlotCard'
import { NodeSphere } from '../NodeSphere/NodeSphere'
import {
  buildInvitePinnedNodes,
  DEMO_SLOTS,
  DEMO_WALLET,
  DEMO_WALLET_DISPLAY,
  FILL_PCT,
  formatArmAllocation,
  formatUsdcCommitted,
  GRAPH_PARTICIPANTS,
  GRAPH_SEED,
} from './myPositionDemo'

export interface MyPositionSplitProps {
  /**
   * Header slot. When provided, replaces the default @armada/ui `<Header>`.
   * Pass `null` to render no header at all (e.g. when wrapped in an AppShell
   * that already renders a header).
   */
  header?: ReactNode
}

export function MyPositionSplit({ header }: MyPositionSplitProps = {}) {
  const [copiedId, setCopiedId] = useState<number | null>(null)
  const [loadingId, setLoadingId] = useState<number | null>(null)

  const invitePinnedNodes = useMemo(() => buildInvitePinnedNodes(DEMO_SLOTS), [])

  const handleGenerateLink = async (slotId: number) => {
    setLoadingId(slotId)
    await new Promise((r) => setTimeout(r, 800))
    setLoadingId(null)
  }

  const handleCopy = (slotId: number, link: string) => {
    navigator.clipboard.writeText(link)
    setCopiedId(slotId)
    setTimeout(() => setCopiedId(null), 2000)
  }

  const handleRevoke = async () => {}
  const handleInviteOnchain = async (slotId: number) => {
    setLoadingId(slotId)
    await new Promise((r) => setTimeout(r, 800))
    setLoadingId(null)
  }

  return (
    <div className={styles.page}>
      {header === undefined ? (
        <Header
          activeNav="myposition"
          walletAddress={DEMO_WALLET_DISPLAY}
          autoHideOnScroll={false}
        />
      ) : (
        header
      )}

      <main className={styles.layout}>
        <section className={styles.graphColumn} aria-label="Invite graph">
          <div className={styles.sphereFrame}>
            <NodeSphere
              highlightAddress={DEMO_WALLET}
              interactionDisabled={false}
              scenarioParticipants={GRAPH_PARTICIPANTS}
              scenarioSeed={GRAPH_SEED}
              pinnedNodes={invitePinnedNodes}
              walletAddress={DEMO_WALLET}
              lockOnWallet
              inviteGraph
            />
          </div>
        </section>

        <aside className={styles.sidebarColumn} aria-label="Your position and invites">
          <div className={styles.sidebarStack}>
            <section className={styles.positionCard} aria-label="Your position">
              <div className={styles.cardHeader}>
                <h1 className={styles.pageTitle}>My Position</h1>
                <div className={styles.metaTags}>
                  <Tag label={DEMO_WALLET_DISPLAY} dot="lavender" />
                  <Tag label="HOP-1" dot="lavender" />
                </div>
              </div>

              <div className={styles.positionFooter}>
                <div className={styles.statsRow}>
                  <div className={styles.statBlock}>
                    <p className={styles.statLabel}>USDC committed</p>
                    <p className={styles.statAmount}>{formatUsdcCommitted()}</p>
                  </div>

                  <div className={styles.statBlock}>
                    <div className={styles.statLabelRow}>
                      <p className={styles.statLabel}>ARM allocation</p>
                      <Tooltip
                        variant="centered"
                        content="Estimated · pending finalization"
                      >
                        <button
                          type="button"
                          className={styles.infoTrigger}
                          aria-label="ARM allocation info"
                        >
                          <InformationCircleIcon className={styles.infoIcon} aria-hidden />
                        </button>
                      </Tooltip>
                    </div>
                    <p className={styles.statAmountAccent}>{formatArmAllocation()}</p>
                  </div>
                </div>

                <div className={styles.barSection}>
                  <div className={styles.barTrack}>
                    <div
                      className={styles.barFill}
                      style={{ width: `${FILL_PCT}%` }}
                    />
                  </div>
                  <div className={styles.barLabels}>
                    <span className={styles.barCaption}>{FILL_PCT}% of cap</span>
                    <span className={styles.barCaption}>Cap $10,000</span>
                  </div>
                </div>
              </div>
            </section>

            <section className={styles.inviteCard} aria-label="Your invites">
              <h2 className={styles.inviteTitle}>Your Invites</h2>
              <div className={styles.slotList}>
                {DEMO_SLOTS.map((slot) => (
                  <SlotCard
                    key={slot.id}
                    slot={slot}
                    onGenerateLink={handleGenerateLink}
                    onCopy={handleCopy}
                    onRevoke={handleRevoke}
                    onInviteOnchain={handleInviteOnchain}
                    copied={copiedId === slot.id}
                    loading={loadingId === slot.id}
                  />
                ))}
              </div>
            </section>
          </div>
        </aside>
      </main>
    </div>
  )
}
