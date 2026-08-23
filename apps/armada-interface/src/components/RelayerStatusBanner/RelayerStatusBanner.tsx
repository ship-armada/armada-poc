// ABOUTME: RelayerStatusBanner — surfaced inside relayer-mediated modals when /health reports stale/unhealthy.
// ABOUTME: Offers a one-click "Submit from your wallet instead" path that toggles the persisted preference.

import { useAtom } from 'jotai'
import { Button } from '@/design'
import { preferencesAtom } from '@/state/preferences'
import { useRelayerHealth } from '@/hooks/useRelayerHealth'
import styles from './RelayerStatusBanner.module.css'

export interface RelayerStatusBannerProps {
  /** Match the parent modal's open state so the query pauses while closed. */
  isOpen: boolean
}

/**
 * Renders nothing when the relayer is healthy or the user already has the wallet-override
 * preference enabled. When `/health` is degraded AND the preference is off, surfaces a banner
 * with a one-click "submit from my wallet for this session" toggle. The toggle writes back to
 * `preferencesAtom` — same source of truth as the Settings page — so a single click persists.
 *
 * The banner does NOT decide the submit path itself; it just nudges the user. The handlers
 * read `preferencesAtom.submitFromWallet` directly at submit-time.
 */
export function RelayerStatusBanner({ isOpen }: RelayerStatusBannerProps) {
  const { isDegraded, isConfigured } = useRelayerHealth({ enabled: isOpen })
  // preferencesAtom is `atomWithStorage` → persisted to localStorage. The action button's flip
  // therefore SURVIVES page reload + session restart; reverting requires the Settings toggle.
  const [prefs, setPrefs] = useAtom(preferencesAtom)

  // Already opted in? No nudge needed — handler will use the wallet path regardless of relayer state.
  if (prefs.submitFromWallet) return null

  // No relayer configured for this build (P0-10) — distinct from "degraded". Be explicit and steer
  // the user to the wallet-submit path, which works without a relayer.
  if (!isConfigured) {
    return (
      <div className={styles.root} role="status" aria-live="polite">
        <div className={styles.message}>
          No relayer is configured for this site. You can still submit transactions from your own
          wallet (you'll pay network gas).
        </div>
        <Button
          variant="secondary"
          size="sm"
          label="Submit from my wallet"
          showIcon={false}
          className={styles.action}
          onClick={() => setPrefs({ ...prefs, submitFromWallet: true })}
        />
      </div>
    )
  }

  // Relayer's fine — no banner, default relayer-mediated path proceeds.
  if (!isDegraded) return null

  return (
    <div className={styles.root} role="status" aria-live="polite">
      <div className={styles.message}>
        Can't find an available relayer. Your transaction may not be broadcast promptly.
      </div>
      <Button
        variant="secondary"
        size="sm"
        label="Submit from my wallet instead"
        showIcon={false}
        className={styles.action}
        onClick={() => setPrefs({ ...prefs, submitFromWallet: true })}
      />
    </div>
  )
}
