// ABOUTME: Bridges wagmi state to a single ergonomic shape ({ address, chainId, signer | null }) + detects EVM-account switches and auto-locks the shielded wallet so the in-memory keys don't outlive the EVM session they were bound to.
// ABOUTME: `signer` is ethers v6 (via walletClientToSigner); use it for contract writes.

import { useEffect, useMemo, useRef } from 'react'
import { useSetAtom } from 'jotai'
import { useAccount, useDisconnect, useWalletClient } from 'wagmi'
import { toast } from 'sonner'
import type { JsonRpcSigner } from 'ethers'
import { walletClientToSigner } from '@/lib/wagmi-adapter'
import { evmAddressAtom, activeRailgunWalletIdAtom, shieldedWalletsAtom } from '@/state/wallet'
import { track, trackError } from '@/lib/telemetry'
import { isUnlocked, getEvmAddress, getWalletId } from '@/lib/railgun/keyManager'
import { lockWallet } from '@/lib/railgun/wallet'
import { cancelAllRunning } from '@/lib/tx/executor'

export interface UseWalletResult {
  address: string | null
  chainId: number | null
  isConnected: boolean
  signer: JsonRpcSigner | null
  disconnect: () => void
}

export function useWallet(): UseWalletResult {
  const { address, chainId, isConnected } = useAccount()
  const { data: walletClient } = useWalletClient()
  const { disconnect } = useDisconnect()
  const setEvmAddress = useSetAtom(evmAddressAtom)
  const setActiveWalletId = useSetAtom(activeRailgunWalletIdAtom)
  const setShieldedWallets = useSetAtom(shieldedWalletsAtom)

  const signer = useMemo(() => {
    if (!walletClient) return null
    try {
      return walletClientToSigner(walletClient)
    } catch {
      return null
    }
  }, [walletClient])

  // Ref so the toast deduplication survives StrictMode's double-fire and remembers across the
  // same address-change event. The effect below sets this when an account-switch fires; the
  // setEvmAddress call later in the effect kicks off other UI changes (UnlockFlow renders),
  // but we want the toast to fire exactly once per switch event.
  const lastSeenAddress = useRef<string | null>(null)

  useEffect(() => {
    const normalized = address?.toLowerCase() ?? null
    const previous = lastSeenAddress.current
    lastSeenAddress.current = normalized

    // Telemetry: emit chainId only — EVM address is sensitive and excluded by EventRegistry.
    if (address) track('wallet.connected', { chainId: chainId ?? null })
    else track('wallet.disconnected', {})

    // Account-switch auto-lock: if a shielded wallet is unlocked AND it's bound to an EVM
    // address AND that address differs from the wagmi-reported one, lock immediately. This
    // covers two real scenarios:
    //   (a) The user switched accounts in MetaMask while the dashboard was open — the wagmi
    //       hook fires with a new address, the keyManager's bound address mismatches, we lock.
    //   (b) The user disconnected the wallet (address = null) — same logic, we lock so the
    //       in-memory keys don't outlive the session they were bound to.
    //
    // We deliberately do NOT lock when:
    //   - This is the FIRST address render (previous === null AND the keyManager wasn't
    //     unlocked at boot — atoms are still hydrating).
    //   - The keyManager was unlocked but `getEvmAddress()` returns null (the unlock had no
    //     EVM binding — paste-restore happened with no wallet connected). Account-switch
    //     detection isn't applicable in that case; the user would need to manually lock.
    if (isUnlocked()) {
      const boundEvmAddress = getEvmAddress()
      if (boundEvmAddress && normalized !== boundEvmAddress) {
        // Capture the active walletId BEFORE `lockWallet` clears the keyManager — we need it
        // to flip the wallet's status from 'unlocked' to 'locked' in the atom (see below). If
        // the read fails we still proceed with the lock; we just can't preserve the locked
        // record in the atom (downstream the app will route through onboarding instead of
        // unlock — acceptable fallback for the rare "we couldn't read the walletId" branch).
        let lockedWalletId: string | null = null
        try {
          lockedWalletId = getWalletId()
        } catch {
          // keyManager isn't unlocked (race with another lock). Nothing to preserve.
        }

        // Abort any in-flight tx BEFORE locking (P1-15). The executor is module-scope and would
        // otherwise keep running a handler bound to the OLD account under the new unlock screen —
        // orphaned wallet prompts, and a gasless permit signed by the wrong signer. Must run while
        // still unlocked so each terminal record can be persisted (putTxIfFresh needs the key).
        cancelAllRunning('account-switch')

        // The mismatch is the trigger. Lock first (zeroizes keyManager + unloads SDK wallet
        // best-effort). `lockWallet`'s `_id` parameter is API-consistency baggage; the
        // implementation always locks whichever wallet the keyManager holds.
        lockWallet('').catch((err) => {
          trackError('useWallet.account-switch-lock', err, {
            scope: 'shielded.lock',
            message: 'lock-on-account-switch failed',
          })
        })

        // Flip the active wallet's status to 'locked' (keep the entry + the activeId) so the
        // derived `shieldedWalletAtom` reports `{ status: 'locked', ... }` and App.tsx's
        // lock-watch effect routes the user from the dashboard to UnlockFlow. Wiping the atoms
        // entirely produces `{ status: 'missing' }`, which App.tsx's existing guard doesn't
        // catch — the user would see the toast but stay on the dashboard. The cached walletId
        // in localStorage also persists, so re-signing with the original EVM restores the same
        // identity (no re-enroll).
        if (lockedWalletId) {
          const idForUpdate = lockedWalletId
          setShieldedWallets(prev => {
            const existing = prev[idForUpdate]
            if (!existing) return prev
            return { ...prev, [idForUpdate]: { ...existing, status: 'locked' } }
          })
          // Keep activeRailgunWalletIdAtom pointing at the locked entry.
        } else {
          // Defensive fallback: couldn't read the walletId. Clear the atoms so we don't leave
          // a stale 'unlocked' entry in place.
          setActiveWalletId(null)
          setShieldedWallets({})
        }

        // One-time toast — only fire when this is a *change* event (not the first render).
        // `previous === null` AND a wagmi address arriving means initial connect, which is a
        // legitimate first-unlock signal, not an account-switch. The keyManager-bound check
        // above already ruled out initial-render (keyManager wasn't unlocked at boot).
        if (previous !== null && previous !== normalized) {
          toast('Switched EVM accounts — please sign in with the new wallet.', {
            id: 'shielded-account-switch', // dedup if wagmi re-fires
          })
        }
      }
    }

    setEvmAddress(address ?? null)
  }, [address, chainId, setEvmAddress, setActiveWalletId, setShieldedWallets])

  return {
    address: address ?? null,
    chainId: chainId ?? null,
    isConnected,
    signer,
    disconnect,
  }
}
