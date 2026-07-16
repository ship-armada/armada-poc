// ABOUTME: Wallet connection state wrapping wagmi hooks.
// ABOUTME: Provides ethers Signer via adapter for backwards compatibility.

import { useCallback, useMemo } from 'react'
import { useAccount, useWalletClient, useDisconnect } from 'wagmi'
import { useConnectModal, useChainModal } from '@rainbow-me/rainbowkit'
import { walletClientToSigner } from '@/lib/wagmiAdapter'
import { getHubChainId } from '@/config/network'
import { useMobileChainReconciliation } from './useMobileChainReconciliation'
import type { JsonRpcSigner } from 'ethers'

export interface UseWalletResult {
  address: string | null
  signer: JsonRpcSigner | null
  chainId: number | null
  connected: boolean
  connecting: boolean
  isWrongNetwork: boolean
  error: string | null
  connect: () => void
  disconnect: () => void
  switchNetwork: () => void
}

export function useWallet(): UseWalletResult {
  const { address: rawAddress, isConnected, isConnecting, chainId: accountChainId, connector } =
    useAccount()
  const { openConnectModal } = useConnectModal()
  const { openChainModal } = useChainModal()
  const { disconnect: wagmiDisconnect } = useDisconnect()

  // Mobile-only, read-only correction for a stale wagmi chainId after a mobile
  // network switch (MetaMask Mobile can drop `chainChanged` — wagmi #4551/#4600,
  // MM #6706 — leaving `useAccount().chainId` pointing at the old chain). On
  // DESKTOP this is always `undefined`, so `effectiveChainId === accountChainId`
  // and every derived value below is identical to the wagmi-only behavior.
  const observedChainId = useMobileChainReconciliation(connector)
  const effectiveChainId = observedChainId ?? accountChainId

  const expectedChainId = getHubChainId()
  // Detect the wrong network from `useAccount().chainId` (the per-connection
  // value, which tracks the wallet's actual chain) rather than `useChainId()`.
  // With a single-chain config, `useChainId()` always returns the configured
  // chain id and silently ignores a wallet switch to an unconfigured chain, so
  // a mid-session switch to the wrong network would never be detected. On mobile
  // `effectiveChainId` substitutes the provider-observed chain when wagmi's value
  // is stale; on desktop it is exactly `accountChainId`.
  const isWrongNetwork =
    isConnected && effectiveChainId !== undefined && effectiveChainId !== expectedChainId

  // The wallet-client query must not fetch while the wallet sits on an
  // unconfigured chain. wagmi's useWalletClient always requests the CONFIG's
  // chain id, and getConnectorClient throws ConnectorChainMismatchError when
  // the wallet's live chain differs; the errored query has staleTime: Infinity
  // and is only invalidated on address change, so it never recovers for the
  // session. That bites the fresh-connect path with newer MetaMask (per-site
  // network permissions connect on mainnet, then a second prompt switches to
  // the hub chain): the first fetch poisons the query before the switch lands,
  // and the signer stays null until a page refresh. Gating `enabled` on the
  // account's chain means the first fetch happens only once it can succeed —
  // the chain switch itself flips the gate and triggers it. A disabled query
  // keeps previously-fetched data, so a wallet that wanders off-chain
  // mid-session retains its signer (see the signer comment below).
  const { data: walletClient } = useWalletClient({
    query: { enabled: isConnected && !isWrongNetwork },
  })

  // TODO: invite-link signing (useInviteLinks.createLink/revokeLink) and direct
  // invites (useInviteSlots.onInviteOnchain) still consume this hook-derived
  // signer, which can be unavailable after a fresh connect (wagmi #2784/#3825).
  // The commit/claim pipelines fall back to lib/resolveSigner at click time;
  // migrate those invite paths the same way if the fresh-connect repro shows up
  // there too.
  //
  // The signer reflects wallet *connection*, not chain correctness — those are
  // separate concerns. Gating it on `isWrongNetwork` would make signer-using
  // actions (on-chain invites, invite-link signing) silently no-op on a chain
  // mismatch. Chain correctness is surfaced via `isWrongNetwork` / `connected`
  // (commit + claim gate on `connected`); a genuine wrong-chain send still fails
  // loudly via wagmi's connector chain assertion rather than vanishing.
  const signer = useMemo(() => {
    if (!walletClient) return null
    try {
      return walletClientToSigner(walletClient)
    } catch {
      return null
    }
  }, [walletClient])

  // Open RainbowKit's chain modal so the user explicitly switches to the hub
  // chain — a clear, deliberate affordance consistent with the participate
  // flow's "Switch network" button, rather than a silent programmatic switch.
  const switchNetwork = useCallback(() => {
    openChainModal?.()
  }, [openChainModal])

  return {
    address: rawAddress ? rawAddress.toLowerCase() : null,
    signer,
    chainId: effectiveChainId ?? null,
    connected: isConnected && !isWrongNetwork,
    connecting: isConnecting,
    isWrongNetwork,
    error: isWrongNetwork ? `Wrong network. Please switch to chain ${expectedChainId}.` : null,
    connect: () => openConnectModal?.(),
    disconnect: () => wagmiDisconnect(),
    switchNetwork,
  }
}
