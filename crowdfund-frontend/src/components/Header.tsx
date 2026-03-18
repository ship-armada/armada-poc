// ABOUTME: Top header bar with network badge, account selector, and balances.
// ABOUTME: Shows Anvil account dropdown (local) or MetaMask connect button (Sepolia).
import { Wallet, CircleDollarSign, Coins, Droplets, Copy, Check } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Badge } from '@/components/ui/badge'
import { useState } from 'react'
import { isLocalMode } from '@/config/network'
import { formatUsdc, truncateAddress } from '@/utils/format'
import { CROWDFUND_CONSTANTS } from '@/types/crowdfund'
import type { useAccounts } from '@/hooks/useAccounts'
import type { useCrowdfund } from '@/hooks/useCrowdfund'

interface HeaderProps {
  accounts: ReturnType<typeof useAccounts>
  crowdfund: ReturnType<typeof useCrowdfund>
}

export function Header({ accounts, crowdfund }: HeaderProps) {
  const { currentAddress, isAdmin, wallet, selectAnvilAccount, connectMetaMask, disconnectMetaMask, anvilAccounts } = accounts
  const { state, mintUsdc } = crowdfund
  const local = isLocalMode()
  const [copied, setCopied] = useState(false)

  const handleMintUsdc = () => {
    if (!state.currentParticipant) {
      // Default to hop-0 cap for non-participants
      mintUsdc(CROWDFUND_CONSTANTS.HOP_CAPS[0])
      return
    }
    const cap = CROWDFUND_CONSTANTS.HOP_CAPS[state.currentHop] ?? CROWDFUND_CONSTANTS.HOP_CAPS[0]
    mintUsdc(cap)
  }

  return (
    <header className="border-b border-border bg-card px-6 py-3">
      <div className="max-w-6xl mx-auto flex items-center justify-between gap-4">
        {/* Left: Title + Network */}
        <div className="flex items-center gap-3">
          <h1 className="text-lg font-semibold">Armada Crowdfund</h1>
          <Badge variant="outline" className={local ? 'border-success text-success' : 'border-accent text-accent'}>
            {local ? 'Local' : 'Sepolia'}
          </Badge>
        </div>

        {/* Right: Account + Balances */}
        <div className="flex items-center gap-3">
          {/* USDC Balance */}
          {currentAddress && (
            <div className="flex items-center gap-1.5 text-sm text-muted-foreground">
              <CircleDollarSign className="h-4 w-4" />
              <span>{formatUsdc(state.usdcBalance)}</span>
            </div>
          )}

          {/* ARM Balance */}
          {currentAddress && (
            <div className="flex items-center gap-1.5 text-sm text-muted-foreground">
              <Coins className="h-4 w-4" />
              <span>{(Number(state.armBalance) / 1e18).toLocaleString('en-US', { maximumFractionDigits: 0 })} ARM</span>
            </div>
          )}

          {/* Mint USDC button (local only) */}
          {local && currentAddress && (
            <Button variant="outline" size="sm" onClick={handleMintUsdc} className="gap-1.5">
              <Droplets className="h-3.5 w-3.5" />
              Mint USDC
            </Button>
          )}

          {/* Account Selector */}
          {local ? (
            <>
              <Select
                value={wallet.anvilAccount?.index.toString() ?? ''}
                onValueChange={(val) => {
                  const account = anvilAccounts[parseInt(val)]
                  if (account) selectAnvilAccount(account)
                }}
              >
                <SelectTrigger className="w-[260px]">
                  <SelectValue placeholder="Select account" />
                </SelectTrigger>
                <SelectContent>
                  {anvilAccounts.map((acc) => (
                    <SelectItem key={acc.index} value={acc.index.toString()}>
                      <span className="font-mono text-xs">{truncateAddress(acc.address)}</span>
                      {' '}
                      <span className="text-muted-foreground">{acc.label}</span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {currentAddress && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-8 w-8 p-0"
                  onClick={() => {
                    navigator.clipboard.writeText(currentAddress)
                    setCopied(true)
                    setTimeout(() => setCopied(false), 1500)
                  }}
                >
                  {copied ? <Check className="h-3.5 w-3.5 text-success" /> : <Copy className="h-3.5 w-3.5" />}
                </Button>
              )}
            </>
          ) : (
            <>
              {wallet.metaMaskAddress ? (
                <div className="flex items-center gap-2">
                  <span className="font-mono text-sm">{truncateAddress(wallet.metaMaskAddress)}</span>
                  <Button variant="ghost" size="sm" onClick={disconnectMetaMask}>
                    Disconnect
                  </Button>
                </div>
              ) : (
                <Button variant="outline" size="sm" onClick={connectMetaMask} disabled={wallet.isConnecting}>
                  <Wallet className="h-4 w-4 mr-1.5" />
                  {wallet.isConnecting ? 'Connecting...' : 'Connect MetaMask'}
                </Button>
              )}
            </>
          )}

          {/* Admin indicator */}
          {isAdmin && (
            <Badge className="bg-accent text-accent-foreground">Admin</Badge>
          )}
        </div>
      </div>
    </header>
  )
}
