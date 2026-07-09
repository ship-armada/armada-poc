// ABOUTME: Shared progress step — renders the active tx's <TxLifecycleStepper> for any TxKind, with a Cancel CTA on in-flight records.
// ABOUTME: When no record exists yet (user clicked Confirm but executor hasn't written the first transition), shows a preparing placeholder.

import { useAtomValue } from 'jotai'
import type { TxRecord } from '@/lib/tx/types'
import { TxActions, TxLifecycleStepper } from '@/components/tx'
import { WalletConfirmList } from '../WalletConfirmList/WalletConfirmList'
import { shieldWalletSteps } from '@/lib/tx/shieldWalletSteps'
import { preferencesAtom } from '@/state/preferences'
import styles from './ProgressStep.module.css'

export interface ProgressStepProps {
  /** The in-flight tx record. Null when the executor hasn't created a record yet (e.g. user just clicked Confirm). */
  record: TxRecord | null
  /**
   * Override the user's "Show technical details by default" preference. When undefined, falls back to
   * preferencesAtom. Modals don't need to thread the preference; ProgressStep handles it once here.
   */
  technicalDetailsDefaultOpen?: boolean
}

export function ProgressStep({ record, technicalDetailsDefaultOpen }: ProgressStepProps) {
  const prefs = useAtomValue(preferencesAtom)
  const defaultOpen = technicalDetailsDefaultOpen ?? prefs.showTechnicalDetailsByDefault

  if (!record) {
    return (
      <div className={styles.root}>
        <div className={styles.headline}>Preparing transaction</div>
        <div className={styles.sub}>Hang on a moment…</div>
      </div>
    )
  }
  // S-M4: shield / shield-xchain surface a wallet-prompt checklist (approve + deposit, or a single
  // "Authorize deposit" row on the gasless path) so the user can see which wallet prompts are
  // pending vs done. Other kinds rely on the stepper's submit-relayer row alone.
  const isShieldKind = record.kind === 'shield' || record.kind === 'shield-xchain'

  return (
    <div className={styles.root}>
      {isShieldKind ? (
        <WalletConfirmList
          steps={shieldWalletSteps(
            record as TxRecord<'shield'> | TxRecord<'shield-xchain'>,
            record.meta.amount,
          )}
        />
      ) : null}
      <TxLifecycleStepper record={record} technicalDetailsDefaultOpen={defaultOpen} />
      {/* Cancel only — Retry on failure is handled by the modal's dedicated ErrorStep. */}
      <TxActions record={record} variant="cancel" />
    </div>
  )
}
