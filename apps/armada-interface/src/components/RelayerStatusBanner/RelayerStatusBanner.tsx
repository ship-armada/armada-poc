// ABOUTME: RelayerStatusBanner — surfaced inside relayer-mediated modals when /health reports stale/unhealthy.
// ABOUTME: Offers a one-click "Submit from your wallet instead" path that toggles the persisted preference.

import { useAtom } from 'jotai'
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
  const { isDegraded, data } = useRelayerHealth({ enabled: isOpen })
  const [prefs, setPrefs] = useAtom(preferencesAtom)

  // Already opted in? No nudge needed — handler will use the wallet path regardless of relayer state.
  if (prefs.submitFromWallet) return null
  // Relayer's fine — no banner, default relayer-mediated path proceeds.
  if (!isDegraded) return null

  const statusLabel = data?.status ?? 'unreachable'

  return (
    <div className={styles.root} role="status" aria-live="polite">
      <div className={styles.message}>
        The relayer is reporting <strong>{statusLabel}</strong>. Your transaction may not be
        broadcast promptly.
      </div>
      <button
        type="button"
        className={styles.action}
        onClick={() => setPrefs({ ...prefs, submitFromWallet: true })}
      >
        Submit from my wallet instead
      </button>
    </div>
  )
}
