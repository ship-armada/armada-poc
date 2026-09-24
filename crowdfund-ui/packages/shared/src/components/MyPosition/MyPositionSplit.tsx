// ABOUTME: Ported from armada-crowdfund MyPositionSplit — hop InvitesCard demo surface.
// ABOUTME: Header rendering exposed via a `header` slot prop for consuming apps.

import { useMemo, useState } from 'react'
import styles from './MyPositionSplit.module.css'
import { Header } from '@armada/ui'
import { Tag } from '@armada/ui'
import { InformationCircleIcon } from '@heroicons/react/24/solid'
import { Tooltip } from '@armada/ui'
import { InvitesCard } from './InvitesCard'
import { NodeSphere } from '../NodeSphere/NodeSphere'
import {
  buildInvitePinnedNodes,
  COMMITTED,
  DEMO_INVITE_ALLOWANCE,
  DEMO_SLOTS,
  DEMO_WALLET,
  DEMO_WALLET_DISPLAY,
  FILL_PCT,
  formatArmAllocation,
  formatUsdcCommitted,
  GRAPH_PARTICIPANTS,
  GRAPH_SEED,
} from './myPositionDemo'
import type { InviteeHop } from './inviteModel'
import type { ReactNode } from 'react'

export interface MyPositionSplitProps {
  header?: ReactNode
}

export function MyPositionSplit({ header }: MyPositionSplitProps = {}) {
  const [copiedId, setCopiedId] = useState<number | null>(null)
  const [loadingHop, setLoadingHop] = useState<InviteeHop | null>(null)

  const invitePinnedNodes = useMemo(
    () => buildInvitePinnedNodes(DEMO_SLOTS, DEMO_WALLET, COMMITTED),
    [],
  )

  const handleGenerateLink = async (hop: InviteeHop) => {
    setLoadingHop(hop)
    await new Promise((r) => setTimeout(r, 800))
    setLoadingHop(null)
    const expiresAt = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000)
    return {
      id: Date.now(),
      link: `https://armada.wtf/join?invite=demo&hop=hop-${hop}`,
      expiresAt,
    }
  }

  const handleCopy = (slotId: number, link: string) => {
    void navigator.clipboard.writeText(link)
    setCopiedId(slotId)
    setTimeout(() => setCopiedId(null), 1200)
  }

  const handleRevoke = async () => {}
  const handleInviteOnchain = async (hop: InviteeHop) => {
    setLoadingHop(hop)
    await new Promise((r) => setTimeout(r, 800))
    setLoadingHop(null)
  }

  return (
    <div className={styles.page}>
      {header === null
        ? null
        : (header ?? (
            <Header
              activeNav="myposition"
              walletAddress={DEMO_WALLET_DISPLAY}
              walletCopyAddress={DEMO_WALLET}
              walletProvider="metamask"
              autoHideOnScroll={false}
            />
          ))}

      <main className={styles.layout}>
        <section className={styles.graphColumn} aria-label="Invite graph">
          <div className={styles.sphereFrame}>
            <NodeSphere
              walletAddress={DEMO_WALLET}
              lockOnWallet
              inviteGraph
              highlightAddress={DEMO_WALLET}
              interactionDisabled={false}
              scenarioParticipants={GRAPH_PARTICIPANTS}
              scenarioSeed={GRAPH_SEED}
              pinnedNodes={invitePinnedNodes}
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

            <InvitesCard
              variant="split"
              slots={DEMO_SLOTS}
              allowance={DEMO_INVITE_ALLOWANCE}
              onGenerateLink={handleGenerateLink}
              onCopy={handleCopy}
              onRevoke={handleRevoke}
              onInviteOnchain={handleInviteOnchain}
              copiedSlotId={copiedId}
              loadingHop={loadingHop}
              onViewRedeemed={(address) => {
                const url = new URL('/', window.location.origin)
                url.searchParams.set('view', 'crowdfund')
                url.searchParams.set('select', address)
                window.location.assign(url.toString())
              }}
            />
          </div>
        </aside>
      </main>
    </div>
  )
}
