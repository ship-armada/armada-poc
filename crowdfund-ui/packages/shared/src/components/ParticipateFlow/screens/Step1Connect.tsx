// ABOUTME: Participate-flow connect screen — a single "Connect wallet" CTA that opens the wallet picker.
// ABOUTME: Replaces the legacy three-tile Step1Wallet (whose tiles all opened the same picker anyway).

import styles from './Step1Wallet.module.css'
import { Steps, Button } from '@armada/ui'

const STEPS = ['Connect', 'Commit', 'Review', 'Confirmation']

interface Step1ConnectProps {
  /** Opens the wallet picker (e.g. RainbowKit openConnectModal). */
  onConnect: () => void
  showSteps?: boolean
  compact?: boolean
}

export default function Step1Connect({
  onConnect,
  showSteps = true,
  compact = false,
}: Step1ConnectProps) {
  return (
    <div className={[styles.shell, compact && styles.shellCompact].filter(Boolean).join(' ')}>
      {showSteps && <Steps steps={STEPS} currentStep={1} />}
      <div className={[styles.content, compact && styles.contentCompact].filter(Boolean).join(' ')}>
        <div className={styles.titleBlock}>
          <h2 className={styles.title}>Connect your wallet</h2>
          <p className={styles.subtitle}>
            Connect your wallet to verify your invite and see your allocation.
          </p>
        </div>
        <Button
          variant="primary"
          size="lg"
          label="Connect wallet"
          showIcon={false}
          onClick={onConnect}
        />
      </div>
    </div>
  )
}
