// ABOUTME: Top-level route shell + wallet-status guard — installs the visibility listener once, hydrates tx history, starts the executor, and renders OnboardingFlow / UnlockFlow / Outlet based on local mode.
// ABOUTME: Guard uses a local mode state (not direct atom read) so the onboarding success screen gets to render even after createWallet flips the atom.

import { useEffect, useState } from 'react'
import { Outlet } from 'react-router-dom'
import { useAtomValue, useSetAtom } from 'jotai'
import { AppLayout } from '@/components/AppLayout'
import { OnboardingFlow, UnlockFlow } from '@/components/onboarding'
import { ShieldModal } from '@/components/shield'
import { UnshieldModal } from '@/components/unshield'
import { SendModal } from '@/components/payments'
import { EarnModal } from '@/components/yield'
import { useAutoLock } from '@/hooks/useAutoLock'
import { useRailgunEngineSync } from '@/hooks/useRailgunEngineSync'
import { useFees } from '@/hooks/useFees'
import { useShieldedBalanceSync } from '@/hooks/useShieldedBalanceSync'
import { useTabVisible } from '@/hooks/useTabVisible'
import { useTxHistory } from '@/hooks/useTxHistory'
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
import { initRailgunEngine } from '@/lib/railgun/init'
import { readStoredWalletId } from '@/lib/railgun/wallet'
import {
  activeRailgunWalletIdAtom,
  shieldedWalletAtom,
  shieldedWalletsAtom,
} from '@/state/wallet'

type GuardMode = 'pre-init' | 'onboarding' | 'unlock' | 'app'

export function App() {
  useTabVisible()
  useTxHistory() // hydrate tx history from IDB on cold load
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

  useEffect(() => {
    // Start the tx execution engine. Idempotent + module-scope, so this runs
    // safely under StrictMode's double-mount and never spawns a second engine.
    startEngine()
    // Pre-warm the Railgun engine — loads the WASM proving stack + IDB DB + artifact store
    // AFTER first paint so the initial render isn't competing with the multi-megabyte WASM
    // download + compile. The unlock path will await `ensureRailgunReady()` regardless, so
    // correctness is independent of this scheduling — this is purely a paint-latency win.
    //
    // requestIdleCallback waits for browser idle (after paint + layout); setTimeout(0) is the
    // fallback for Safari < 16.4 which still ships without it. The 2-second timeout cap on
    // requestIdleCallback ensures we don't wait forever if the browser stays busy.
    const scheduleInit = () => { void initRailgunEngine() }
    const win = window as typeof window & {
      requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number
      cancelIdleCallback?: (id: number) => void
    }
    let idleId: number | null = null
    let timeoutId: number | null = null
    if (typeof win.requestIdleCallback === 'function') {
      idleId = win.requestIdleCallback(scheduleInit, { timeout: 2000 })
    } else {
      timeoutId = window.setTimeout(scheduleInit, 0)
    }
    return () => {
      if (idleId !== null && win.cancelIdleCallback) win.cancelIdleCallback(idleId)
      if (timeoutId !== null) clearTimeout(timeoutId)
    }
  }, [])

  const wallet = useAtomValue(shieldedWalletAtom)
  const setShieldedWallets = useSetAtom(shieldedWalletsAtom)
  const setActiveWalletId = useSetAtom(activeRailgunWalletIdAtom)
  const [mode, setMode] = useState<GuardMode>('pre-init')
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

  // After initial derivation, react to subsequent lock events (auto-lock timer).
  useEffect(() => {
    if (mode === 'app' && wallet.status === 'locked') setMode('unlock')
  }, [mode, wallet.status])

  if (mode === 'pre-init') {
    // Brief pre-render gap — atom hydration is synchronous in Jotai so this
    // usually never paints. Return null to avoid flashing the wrong shell.
    return null
  }

  if (mode === 'onboarding') {
    // Always offer the Restore escape hatch — the onboarding flow has no way to know whether
    // the user is genuinely new vs. arriving on a new device with an existing backup. The link
    // is harmless for genuinely new users (they ignore it) and load-bearing for the second case.
    return <OnboardingFlow onDone={() => setMode('app')} onRestore={() => setMode('unlock')} />
  }

  if (mode === 'unlock') {
    // Only expose the Create-new link when there's no persisted wallet on this device. A
    // returning user (had a persisted wallet at boot) MUST go through Unlock — accidentally
    // starting Create would orphan their existing IDB-stored wallet without recovery.
    return (
      <UnlockFlow
        onUnlocked={() => setMode('app')}
        onCreateNew={hadPersistedWalletAtBoot ? undefined : () => setMode('onboarding')}
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
    </>
  )
}
