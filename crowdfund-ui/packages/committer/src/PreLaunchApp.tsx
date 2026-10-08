// ABOUTME: Pre-launch committer — the crowdfund hero's pre-open state driven by a fixed opening time.
// ABOUTME: Published before the contracts exist: no wallet, manifest, RPC or indexer; reloads once the opening passes.

import { useEffect, useMemo } from 'react'
import {
  AppShell,
  CrowdfundExperience,
  formatOpensAtDetail,
  type CrowdfundExperienceLiveData,
} from '@armada/crowdfund-shared'
import { getNetworkMode } from '@/config/network'
import { PRELAUNCH_RELOAD_CHECK_MS, prelaunchShouldReload } from '@/config/prelaunch'
import { formatSaleStatusLabel } from '@/lib/saleStatus'
import { AboutLink, PageNav } from '@/appNav'
import { PROJECT_URL } from '@/config/socials'

function reloadPage() {
  window.location.reload()
}

/**
 * Renders what the live committer shows before the commit window opens —
 * OPENS SOON, the Progress "OPENS IN …" countdown, the PreOpenCard and an
 * empty network — but from the announced opening time instead of the chain's
 * `windowStart`. Every action surface is off: no wallet button, Participate,
 * Details, Your position or Claim.
 *
 * The countdown runs on the device clock (there is no chain time to anchor
 * to). Once the opening passes, the page reloads every
 * `PRELAUNCH_RELOAD_CHECK_MS` so a tab left open picks up the live committer
 * as soon as the site is switched over.
 */
export function PreLaunchApp({
  opensAtUnix,
  onReload = reloadPage,
}: {
  /** Announced commit-window opening (unix seconds, UTC). */
  opensAtUnix: number
  /** Injected in tests; defaults to a full page reload. */
  onReload?: () => void
}) {
  useEffect(() => {
    const id = window.setInterval(() => {
      if (prelaunchShouldReload(opensAtUnix, Date.now())) onReload()
    }, PRELAUNCH_RELOAD_CHECK_MS)
    return () => window.clearInterval(id)
  }, [opensAtUnix, onReload])

  // Same shape the live App builds pre-open, with no participants and nothing
  // committed. Phase 0 (active) + pre-open gives the live OPENS SOON pill.
  const liveData = useMemo<CrowdfundExperienceLiveData>(() => {
    const saleStatus = formatSaleStatusLabel(0, false, true)
    return {
      status: 'ready',
      dashRows: [],
      totalCommitted: 0,
      opensAtUnix,
      daysLeftTooltip: formatOpensAtDetail(opensAtUnix) || undefined,
      saleStatusLabel: saleStatus.label,
      saleStatusDot: saleStatus.dot,
    }
  }, [opensAtUnix])

  return (
    <AppShell
      appName="Committer"
      network={getNetworkMode()}
      headerNav={
        <PageNav current="network" onChange={() => {}} myPositionEnabled={false} />
      }
      mobileActions={<AboutLink className="text-sm" />}
      logoHref={PROJECT_URL}
      bare
    >
      <CrowdfundExperience
        view="crowdfund"
        header={null}
        // Explicit empties so the hero never falls back to its demo slots /
        // demo wallet.
        inviteSlotSections={[]}
        liveData={liveData}
        myPositionData={{ status: 'disconnected' }}
        participationEnabled={false}
      />
    </AppShell>
  )
}
