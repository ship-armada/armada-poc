// ABOUTME: Empty-state screen shown when the connected wallet is not eligible for the crowdfund.
// ABOUTME: Ported from the armada-crowdfund mockup (ParticipateFlow/screens/Step1WalletNotWhitelisted.tsx); demo's truncateWalletAddress import replaced with a local em-dash truncation shim.

import { ExclamationCircleIcon } from '@heroicons/react/24/outline'
import { Button } from '@armada/ui'
import styles from './Step1WalletNotWhitelisted.module.css'

interface Step1WalletNotWhitelistedProps {
  address: string
  onSelectAnother: () => void
}

// Local mirror of the mockup's `truncateWalletAddress` helper (em-dash variant).
// The shared `truncateAddress` in `lib/format.ts` uses three dots and is
// load-bearing in other places; an em dash matches the designer's typography
// here without changing the broader helper.
function truncateWalletAddress(address: string): string {
  if (address.length <= 12) return address
  return `${address.slice(0, 6)}…${address.slice(-4)}`
}

export default function Step1WalletNotWhitelisted({
  address,
  onSelectAnother,
}: Step1WalletNotWhitelistedProps) {
  const displayAddress = truncateWalletAddress(address)

  return (
    <div className={styles.shell}>
      <div className={styles.content}>
        <ExclamationCircleIcon className={styles.icon} aria-hidden />
        <h2 className={styles.title}>Address not whitelisted</h2>
        <p className={styles.body}>
          <span className={styles.address}>{displayAddress}</span> isn't on the allowlist for
          this crowdfund. Connect a different wallet to try another address.
        </p>
      </div>
      <div className={styles.buttonRow}>
        <Button
          variant="primary"
          size="lg"
          label="Connect a different wallet"
          showIcon={false}
          onClick={onSelectAnother}
        />
      </div>
    </div>
  )
}
