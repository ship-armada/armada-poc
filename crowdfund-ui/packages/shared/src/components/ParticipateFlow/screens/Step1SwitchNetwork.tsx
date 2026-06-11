// ABOUTME: Participate-flow wrong-network screen — prompts switching to the deployment's chain.
// ABOUTME: Shown when a wallet is connected but on the wrong chain (hero modal and /invite flow).

import styles from './Step1Wallet.module.css'
import { Steps, Button } from '@armada/ui'

const STEPS = ['Connect', 'Commit', 'Review', 'Confirmation']

interface Step1SwitchNetworkProps {
  /** Human-readable target network name (derived from the deployment chain). */
  networkLabel: string
  /** Opens the chain switcher (e.g. RainbowKit openChainModal). */
  onSwitch: () => void
  showSteps?: boolean
  compact?: boolean
}

export default function Step1SwitchNetwork({
  networkLabel,
  onSwitch,
  showSteps = true,
  compact = false,
}: Step1SwitchNetworkProps) {
  return (
    <div className={[styles.shell, compact && styles.shellCompact].filter(Boolean).join(' ')}>
      {showSteps && <Steps steps={STEPS} currentStep={1} />}
      <div className={[styles.content, compact && styles.contentCompact].filter(Boolean).join(' ')}>
        <div className={styles.titleBlock}>
          <h2 className={styles.title}>Wrong network</h2>
          <p className={styles.subtitle}>Switch to {networkLabel} to continue.</p>
        </div>
        <Button
          variant="primary"
          size="lg"
          label="Switch network"
          showIcon={false}
          onClick={onSwitch}
        />
      </div>
    </div>
  )
}
