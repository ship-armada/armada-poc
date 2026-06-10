// ABOUTME: Top-level route shell + wallet-status guard — runs the v2 schema migration before anything else, installs the visibility listener, hydrates tx history, starts the executor, and renders OnboardingFlow / UnlockFlow / Outlet based on local mode.
// ABOUTME: Guard uses a local mode state (not direct atom read) so the onboarding success screen gets to render even after createWallet flips the atom.

import { useEffect, useState } from 'react'
import { Outlet } from 'react-router-dom'
import { useAtomValue, useSetAtom } from 'jotai'
import { AppLayout } from '@/components/AppLayout'
import { OnboardingFlowV2, UnlockFlow } from '@/components/onboarding'
import { ShieldModal } from '@/components/shield'
import { UnshieldModal } from '@/components/unshield'
import { SendModal } from '@/components/payments'
import { ReceiveDialog } from '@/components/receive'
import { EarnModal } from '@/components/yield'
import { useAutoLock } from '@/hooks/useAutoLock'
import { useHistoryRecovery } from '@/hooks/useHistoryRecovery'
import { useIncomingTransferDetector } from '@/hooks/useIncomingTransferDetector'
import { useNowTicker } from '@/hooks/useNowTicker'
import { useRailgunEngineSync } from '@/hooks/useRailgunEngineSync'
import { useFees } from '@/hooks/useFees'
import { useShieldedBalanceSync } from '@/hooks/useShieldedBalanceSync'
import { useTabVisible } from '@/hooks/useTabVisible'
import { useTxHistory } from '@/hooks/useTxHistory'
import { useTxResume } from '@/hooks/useTxResume'
import { useUsdcBalances } from '@/hooks/useUsdcBalances'
import { useWallet } from '@/hooks/useWallet'
// Side-effect imports: register each feature's stage handler with the tx executor at module load.
// Per-feature handlers each have their own side-effect entry point under features/<area>/index.ts.
import '@/features/shield'
import '@/features/shield-xchain'
import '@/features/unshield'
import '@/features/unshield-xchain'
import '@/features/transfer-shielded'
import '@/features/yield-deposit'
import '@/features/yield-withdraw'
import { startEngine } from '@/lib/tx/executor'
import { trackError } from '@/lib/telemetry'
import { appModeForWalletStatus, type GuardMode } from '@/lib/app-mode'
import { initRailgunEngine } from '@/lib/railgun/init'
import { runSchemaMigrationIfNeeded } from '@/lib/railgun/schema-migration'
import { clearStoredWalletIdentity, readStoredWalletId } from '@/lib/railgun/wallet'
import { isLocalMode } from '@/config/network'
import {
  DEFAULT_DEV_MOCK_BALANCE,
  devMockBalanceAtom,
} from '@/state/devMockBalance'
import {
  activeRailgunWalletIdAtom,
  shieldedWalletAtom,
  shieldedWalletsAtom,
} from '@/state/wallet'

export function App() {
  useTabVisible()
  useNowTicker() // refresh "3m ago" labels on a 60s cadence
  useTxHistory() // hydrate tx history from IDB on cold load
  useTxResume() // on unlock (leader only), resume watchers for broadcast txs / fail pre-broadcast interruptions (P0-2)
  useHistoryRecovery() // chain-recover synthetic rows on unlock + re-scan epoch (Phase 9.3)
  useIncomingTransferDetector() // re-scan on balance events so received transfers surface live (Phase 9.4)
  useAutoLock()  // idle-timer-driven lock for the shielded wallet
  // Mirror wagmi's connection state into evmAddressAtom for atom-consumers (OnboardingFlow's
  // SignEnrollment step, UnshieldModal's recipient pre-fill, useShieldedWallet.enroll). Mounted
  // before the onboarding/unlock guard so the atom is correct even before the user reaches /app.
  useWallet()
  // Mirror lib/railgun/init's engine lifecycle into railgunEngineAtom so the UI can render
  // a "warming up…" indicator. No-op until the first call to initRailgunEngine (currently
  // triggered by enroll/unlock); future commits may pre-warm on app mount.
  useRailgunEngineSync()
  // Subscribe to SDK balance-update events + drive initial scan whenever the wallet unlocks;
  // mirrors the active wallet's shielded USDC balance into shieldedUsdcAtom for BalanceHero
  // and the shield/unshield modals.
  useShieldedBalanceSync()
  // Poll the connected wallet's hub USDC balance into usdcBalancesAtom so the ShieldModal's
  // MAX is populated and the user can shield without typing an arbitrary number.
  useUsdcBalances()
  // Fetch the relayer's fee schedule on mount + auto-refresh near expiry. Modals all share the
  // same cached quote via feeQuoteAtom; mounting at root ensures it's warm by the time any
  // modal opens (otherwise the first modal sees `quote=null` briefly).
  useFees()

  const setDevMockBalance = useSetAtom(devMockBalanceAtom)

  // First local boot: enable mock USDC unless opted out (VITE_DEV_MOCK_BALANCE=false) or Debug saved a preference.
  useEffect(() => {
    if (!isLocalMode()) return
    if (import.meta.env.VITE_DEV_MOCK_BALANCE === 'false') return
    if (localStorage.getItem('armada-interface.devMockBalance') != null) return
    setDevMockBalance({ ...DEFAULT_DEV_MOCK_BALANCE, enabled: true })
  }, [setDevMockBalance])

  const wallet = useAtomValue(shieldedWalletAtom)
  const setShieldedWallets = useSetAtom(shieldedWalletsAtom)
  const setActiveWalletId = useSetAtom(activeRailgunWalletIdAtom)
  const [mode, setMode] = useState<GuardMode>('pre-migration')

  // v2 schema migration: drops legacy localStorage keys + IndexedDB databases on first run of
  // the v2 schema. Synchronous portion (localStorage) is done by the time the awaited promise
  // resolves; async portion (IDB drops) is awaited before we transition out of `pre-migration`
  // so the Railgun engine init below doesn't race against `armada-shielded` being deleted.
  // Idempotent — `runSchemaMigrationIfNeeded` short-circuits when the on-disk version is current,
  // making StrictMode's double-mount safe.
  useEffect(() => {
    if (mode !== 'pre-migration') return
    let cancelled = false
    void runSchemaMigrationIfNeeded()
      .catch((err) => trackError('schema-migration', err))
      .finally(() => {
        if (!cancelled) setMode('pre-init')
      })
    return () => {
      cancelled = true
    }
  }, [mode])

  useEffect(() => {
    if (mode === 'pre-migration') return
    // Start the tx execution engine. Idempotent + module-scope, so this runs
    // safely under StrictMode's double-mount and never spawns a second engine.
    startEngine()
    // Opportunistically pre-warm the Railgun engine — loads the WASM proving stack + IDB DB +
    // artifact store in the background while the user is still onboarding or browsing. Without
    // this, the first proof-generating tx pays a 1-2s warmup before the SDK can do anything.
    // Idempotent: a later enroll/unlock call also goes through ensureRailgunReady() which is a
    // no-op once initialized.
    void initRailgunEngine()
  }, [mode])
  // Sticky flag: true when this device boot started with NO persisted walletId. Drives whether
  // we offer the bidirectional Onboarding ↔ Unlock fork. A returning user (had a wallet at boot)
  // never sees the "Create new" link in UnlockFlow — preventing accidental orphaning of their
  // existing wallet. A new-device user (no persisted wallet at boot) sees both fork links.
  const [hadPersistedWalletAtBoot, setHadPersistedWalletAtBoot] = useState(false)

  // Cold-boot hydration + initial mode derivation, in one pass to avoid a race between
  // separate effects (the mode effect would otherwise read a stale `wallet.status` before the
  // hydration setState landed). Source of truth on cold boot is localStorage — the Railgun
  // SDK persists wallet IDB and we persist the walletId on enroll, but Jotai atoms reset to
  // defaults on every page load.
  //
  // Three cases:
  //   - `wallet.status === 'unlocked'`: HMR re-mount, atoms already populated → straight to app.
  //   - persisted walletId in localStorage: returning user → seed `locked` entry → UnlockFlow.
  //   - neither: first run → OnboardingFlow (with Restore escape hatch — see below).
  useEffect(() => {
    if (mode !== 'pre-init') return
    if (wallet.status === 'unlocked') {
      setMode('app')
      return
    }
    const persistedId = readStoredWalletId()
    if (persistedId) {
      setHadPersistedWalletAtBoot(true)
      setShieldedWallets(prev =>
        prev[persistedId] ? prev : { ...prev, [persistedId]: { id: persistedId, status: 'locked' } },
      )
      setActiveWalletId(prev => prev ?? persistedId)
      setMode('unlock')
      return
    }
    setMode('onboarding')
  }, [mode, wallet.status, setShieldedWallets, setActiveWalletId])

  // After initial derivation, react to subsequent wallet-status changes while in app mode:
  //   locked  → auto-lock timer / account-switch locked the wallet → back to the unlock screen.
  //   missing → Settings → Reset wiped the wallet, or an account-switch landed on an account with
  //             no wallet on this device → back to onboarding. Without this, the app shell renders
  //             with no active wallet and the first action throws 'no active shielded walletId'. (P1-14)
  useEffect(() => {
    const next = appModeForWalletStatus(mode, wallet.status)
    if (next) setMode(next)
  }, [mode, wallet.status])

  if (mode === 'pre-migration' || mode === 'pre-init') {
    // Brief pre-render gap. `pre-migration` waits for the v2 schema-migration to drop legacy
    // localStorage + IDB state (usually under 50ms — synchronous localStorage clear plus a
    // single-tick IDB delete that's a no-op when the DBs are already absent). `pre-init` is
    // the brief window before the cold-boot derivation effect fires. Either state should
    // rarely paint; null avoids flashing the wrong shell.
    return null
  }

  if (mode === 'onboarding') {
    // Always offer the Restore escape hatch — the onboarding flow has no way to know whether
    // the user is genuinely new vs. arriving on a new device with an existing backup. The link
    // is harmless for genuinely new users (they ignore it) and load-bearing for the second case.
    return <OnboardingFlowV2 onDone={() => setMode('app')} onRestore={() => setMode('unlock')} />
  }

  if (mode === 'unlock') {
    const handleStartOver = () => {
      if (
        hadPersistedWalletAtBoot &&
        !window.confirm(
          "Clear the saved login on this device? If you sign in again with the same EVM wallet, your account is restored — your shielded funds are not affected. " +
            'Only continue if you want to switch wallets. If you originally restored from a backup file or recovery secret, make sure you still have it before continuing.',
        )
      ) {
        return
      }
      clearStoredWalletIdentity()
      setShieldedWallets({})
      setActiveWalletId(null)
      setHadPersistedWalletAtBoot(false)
      setMode('onboarding')
    }
    return (
      <UnlockFlow
        onUnlocked={() => setMode('app')}
        onCreateNew={handleStartOver}
        createNewLabel={
          hadPersistedWalletAtBoot ? "Clear this browser's saved login" : undefined
        }
      />
    )
  }

  return (
    <>
      <AppLayout>
        <Outlet />
      </AppLayout>
      {/* Feature modals — mounted at App level so opening one doesn't depend on the current route. */}
      <ShieldModal />
      <UnshieldModal />
      <SendModal />
      <EarnModal />
      <ReceiveDialog />
    </>
  )
}
