// ABOUTME: Settings page — Private Wallet (lock / export / reset) + Preferences (auto-lock, technical details default) + Advanced (network, version).
// ABOUTME: Auxiliary dialogs (RecoverySecretExportDialog, ResetWalletDialog) are opened via local state, not openModalAtom.

import { useEffect, useState, type ChangeEvent } from 'react'
import { useAtom, useAtomValue, useSetAtom } from 'jotai'
import { Button } from '@armada/ui'
import { Card, SectionHeader } from '@/components/ui'
import {
  ClearHistoryDialog,
  RecoverySecretExportDialog,
  ResetWalletDialog,
} from '@/components/settings'
import { useShieldedWallet } from '@/hooks/useShieldedWallet'
import { preferencesAtom, type AutoLockMinutes } from '@/state/preferences'
import {
  activeShieldedWalletIdAtom,
  autoLockDeadlineAtom,
} from '@/state/wallet'
import { historyRecoveryAtom, historyRecoveryEpochAtom } from '@/state/history'
import { clearHistoryCheckpoint } from '@/lib/railgun/history-checkpoint'
import { getNetworkMode } from '@/config/network'
import styles from './Settings.module.css'

const APP_VERSION = import.meta.env.VITE_APP_VERSION as string | undefined

const AUTO_LOCK_OPTIONS: ReadonlyArray<AutoLockMinutes> = [5, 15, 30]

export function Settings() {
  const { state, lock } = useShieldedWallet()
  const [prefs, setPrefs] = useAtom(preferencesAtom)
  const [exportOpen, setExportOpen] = useState(false)
  const [resetOpen, setResetOpen] = useState(false)
  const [clearHistoryOpen, setClearHistoryOpen] = useState(false)
  const activeWalletId = useAtomValue(activeShieldedWalletIdAtom)
  const recovery = useAtomValue(historyRecoveryAtom)
  const setEpoch = useSetAtom(historyRecoveryEpochAtom)

  const walletUnlocked = state?.status === 'unlocked'
  const isScanning = recovery.state === 'scanning'

  function handleRescan() {
    // Re-scan: drop the per-wallet checkpoint so useHistoryRecovery walks from the hub deploy
    // block again, then bump the epoch to fire the effect. The user's existing rows stay in
    // place; the dedup guard inside runScanAndPersist prevents duplicates.
    if (activeWalletId) clearHistoryCheckpoint(activeWalletId)
    setEpoch((prev) => prev + 1)
  }

  return (
    <div className={styles.page}>
      <SectionHeader title="Settings" />

      <Card className={styles.section}>
        <h3 className={styles.sectionTitle}>Private wallet</h3>
        <ul className={styles.rows}>
          <li className={styles.row}>
            <div className={styles.rowLabel}>Status</div>
            <div className={styles.rowValue}>
              {state?.status === 'unlocked' ? 'Unlocked' : state?.status === 'locked' ? 'Locked' : 'No wallet'}
            </div>
          </li>
          <li className={styles.row}>
            <div className={styles.rowLabel}>Lock now</div>
            <div className={styles.rowAction}>
              <Button
                variant="secondary"
                size="sm"
                showIcon={false}
                label="Lock"
                onClick={lock}
                disabled={!walletUnlocked}
              />
            </div>
          </li>
          <li className={styles.row}>
            <div className={styles.rowLabel}>Recovery secret</div>
            <div className={styles.rowAction}>
              <Button
                variant="secondary"
                size="sm"
                showIcon={false}
                label="Export"
                onClick={() => setExportOpen(true)}
                disabled={!walletUnlocked}
              />
            </div>
          </li>
          <li className={styles.row}>
            <div className={styles.rowLabel}>Reset private wallet</div>
            <div className={styles.rowAction}>
              <Button
                variant="secondary"
                size="sm"
                showIcon={false}
                label="Reset…"
                onClick={() => setResetOpen(true)}
                disabled={!state}
              />
            </div>
          </li>
        </ul>
      </Card>

      <Card className={styles.section}>
        <h3 className={styles.sectionTitle}>Preferences</h3>
        <ul className={styles.rows}>
          <li className={styles.row}>
            <div className={styles.rowLabel}>Auto-lock after</div>
            <div className={styles.rowAction}>
              <select
                aria-label="Auto-lock timer"
                className={styles.select}
                value={prefs.autoLockMinutes}
                onChange={(e: ChangeEvent<HTMLSelectElement>) =>
                  setPrefs({ ...prefs, autoLockMinutes: Number(e.target.value) as AutoLockMinutes })
                }
              >
                {AUTO_LOCK_OPTIONS.map(min => (
                  <option key={min} value={min}>
                    {min} minutes
                  </option>
                ))}
              </select>
            </div>
          </li>
          <li className={styles.row}>
            <div className={styles.rowLabel}>Time until auto-lock</div>
            <div className={styles.rowValue}>
              <AutoLockCountdown />
            </div>
          </li>
          <li className={styles.row}>
            <div className={styles.rowLabel}>Show technical details by default</div>
            <div className={styles.rowAction}>
              <label className={styles.toggle}>
                <input
                  type="checkbox"
                  aria-label="Show technical details by default"
                  checked={prefs.showTechnicalDetailsByDefault}
                  onChange={(e: ChangeEvent<HTMLInputElement>) =>
                    setPrefs({ ...prefs, showTechnicalDetailsByDefault: e.target.checked })
                  }
                />
                <span className={styles.toggleTrack} aria-hidden="true">
                  <span className={styles.toggleThumb} />
                </span>
              </label>
            </div>
          </li>
          <li className={styles.row}>
            <div className={styles.rowLabel}>
              Submit transactions from my wallet
              <div className={styles.rowSubLabel}>
                Pay gas in ETH and sign each transaction in your wallet, instead of having the
                relayer broadcast for you. Use this if the relayer is unreachable.
              </div>
            </div>
            <div className={styles.rowAction}>
              <label className={styles.toggle}>
                <input
                  type="checkbox"
                  aria-label="Submit transactions from my wallet"
                  checked={prefs.submitFromWallet}
                  onChange={(e: ChangeEvent<HTMLInputElement>) =>
                    setPrefs({ ...prefs, submitFromWallet: e.target.checked })
                  }
                />
                <span className={styles.toggleTrack} aria-hidden="true">
                  <span className={styles.toggleThumb} />
                </span>
              </label>
            </div>
          </li>
        </ul>
      </Card>

      <Card className={styles.section}>
        <h3 className={styles.sectionTitle}>History</h3>
        <ul className={styles.rows}>
          <li className={styles.row}>
            <div className={styles.rowLabel}>
              Re-scan history from chain
              <div className={styles.rowSubLabel}>
                Re-fetches your shielded-pool activity from the hub chain. Useful if records
                seem to be missing — chain history is the source of truth.
              </div>
            </div>
            <div className={styles.rowAction}>
              <Button
                variant="secondary"
                size="sm"
                showIcon={false}
                label={isScanning ? 'Scanning…' : 'Re-scan'}
                onClick={handleRescan}
                disabled={!walletUnlocked || isScanning}
              />
            </div>
          </li>
          <li className={styles.row}>
            <div className={styles.rowLabel}>
              Clear local history
              <div className={styles.rowSubLabel}>
                Removes the local activity log. Your wallet and funds are untouched. Chain
                history is rebuilt automatically on the next scan.
              </div>
            </div>
            <div className={styles.rowAction}>
              <Button
                variant="secondary"
                size="sm"
                showIcon={false}
                label="Clear…"
                onClick={() => setClearHistoryOpen(true)}
                disabled={!walletUnlocked}
              />
            </div>
          </li>
        </ul>
      </Card>

      <Card className={styles.section}>
        <h3 className={styles.sectionTitle}>Advanced</h3>
        <ul className={styles.rows}>
          <li className={styles.row}>
            <div className={styles.rowLabel}>Network</div>
            <div className={styles.rowValue}>{getNetworkMode()}</div>
          </li>
          <li className={styles.row}>
            <div className={styles.rowLabel}>App version</div>
            <div className={styles.rowValue}>{APP_VERSION ?? 'dev'}</div>
          </li>
        </ul>
      </Card>

      <RecoverySecretExportDialog open={exportOpen} onClose={() => setExportOpen(false)} />
      <ResetWalletDialog open={resetOpen} onClose={() => setResetOpen(false)} />
      <ClearHistoryDialog open={clearHistoryOpen} onClose={() => setClearHistoryOpen(false)} />
    </div>
  )
}

/**
 * Live countdown to the next auto-lock. Reads `autoLockDeadlineAtom` (written by `useAutoLock`
 * on each user-activity reset). Ticks every 10s — finer-grained ticking isn't useful at minute
 * granularity. Returns '—' when no timer is armed (wallet missing/locked).
 */
function AutoLockCountdown() {
  const deadline = useAtomValue(autoLockDeadlineAtom)
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    if (deadline == null) return
    const t = window.setInterval(() => setNow(Date.now()), 10_000)
    return () => window.clearInterval(t)
  }, [deadline])
  if (deadline == null) return <>—</>
  const remaining = Math.max(0, deadline - now)
  if (remaining <= 0) return <>Locking now…</>
  const minutes = Math.ceil(remaining / 60_000)
  return <>{minutes === 1 ? 'Less than a minute' : `${minutes} minutes`}</>
}
