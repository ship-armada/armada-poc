// ABOUTME: Wallet picker for the Participate flow — three provider tiles (Metamask, Phantom, WalletConnect) calling `onNext(provider)`.
// ABOUTME: Ported from the armada-crowdfund mockup; demo whitelist branching is intentionally NOT ported — the consuming controller (e.g. ParticipateFlowV2) handles eligibility checks against real on-chain data.

import { useState } from 'react'
import styles from './Step1Wallet.module.css'
import { Steps } from '@armada/ui'
import { WalletItem } from '@armada/ui'
import {
  WalletMetamask,
  WalletPhantom,
  WalletWalletConnect,
} from '@web3icons/react'

interface Step1WalletProps {
  onNext: (wallet: string) => void
  showSteps?: boolean
  compact?: boolean
}

const STEPS = ['Connect', 'Commit', 'Review', 'Confirmation']
const SELECT_EXIT_MS = 220

export default function Step1Wallet({
  onNext,
  showSteps = true,
  compact = false,
}: Step1WalletProps) {
  const [exiting, setExiting] = useState(false)

  const handleSelect = (wallet: string) => {
    if (exiting) return
    setExiting(true)
    window.setTimeout(() => onNext(wallet), SELECT_EXIT_MS)
  }

  return (
    <div
      className={[
        styles.shell,
        compact && styles.shellCompact,
        exiting && styles.shellExit,
      ]
        .filter(Boolean)
        .join(' ')}
    >
      {showSteps && <Steps steps={STEPS} currentStep={1} />}
      <div className={[styles.content, compact && styles.contentCompact].filter(Boolean).join(' ')}>
        <div className={styles.titleBlock}>
          <h2 className={styles.title}>Select your wallet</h2>
          <p className={styles.subtitle}>
            Connect your wallet to verify your invite and see your allocation.
          </p>
        </div>
        <div className={styles.walletList}>
          <WalletItem
            name="MetaMask"
            iconComponent={<WalletMetamask size={24} />}
            onClick={() => handleSelect('metamask')}
          />
          <WalletItem
            name="Phantom"
            iconComponent={<WalletPhantom size={24} />}
            onClick={() => handleSelect('phantom')}
          />
          <WalletItem
            name="WalletConnect"
            iconComponent={<WalletWalletConnect size={24} />}
            onClick={() => handleSelect('walletconnect')}
          />
        </div>
      </div>
    </div>
  )
}
