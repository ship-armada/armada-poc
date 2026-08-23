// ABOUTME: Adapter from a live TxRecord to the processing UI's view model (hero card copy + timeline stages).
// ABOUTME: Drives TxProcessingLayout from our REAL lifecycle stages (lifecycleFor + record state), styled like the mockup.

import { lifecycleFor } from '@/lib/tx/lifecycles'
import type { TxKind, TxRecord } from '@/lib/tx/types'
import type { TxProgressCardCopy, TxProgressStage } from './processingCopy'

interface StageCopyEntry {
  label: string
  subtitle: string
  /** Shown on the final stage once the flow completes (else `label` is used). */
  completedLabel?: string
}

/**
 * Per-(kind, stage) processing copy. Labels are active-tense ("Shielding") with a `completedLabel`
 * for the final row ("Shielded"); subtitles echo the mockup's supporting line. Stage ids MUST match
 * `lifecycleFor(kind).stages` — every id a kind can reach needs an entry here.
 */
const STAGE_COPY: Record<TxKind, Record<string, StageCopyEntry>> = {
  shield: {
    'build-proof': { label: 'Preparing transaction', subtitle: 'Building zero-knowledge proof' },
    'submit-relayer': { label: 'Submitting transaction', subtitle: 'Confirm in your wallet' },
    'hub-confirmed': { label: 'Shielding', subtitle: 'Confirming on chain', completedLabel: 'Shielded' },
  },
  'shield-xchain': {
    'build-proof': { label: 'Preparing transaction', subtitle: 'Building zero-knowledge proof' },
    'submit-relayer': { label: 'Submitting on source chain', subtitle: 'Confirm in your wallet' },
    'client-burn-confirmed': { label: 'Bridging', subtitle: 'Confirmed on source chain' },
    'iris-attestation-pending': { label: 'Bridging', subtitle: 'Waiting for cross-chain confirmation' },
    'iris-attestation-ready': { label: 'Bridging', subtitle: 'Cross-chain confirmation ready' },
    'hub-mint-pending': { label: 'Shielding', subtitle: 'Delivering to your private balance' },
    'hub-mint-confirmed': { label: 'Shielding', subtitle: 'Confirming on chain', completedLabel: 'Shielded' },
  },
  'unshield-local': {
    'build-proof': { label: 'Preparing transaction', subtitle: 'Building zero-knowledge proof' },
    'submit-relayer': { label: 'Submitting transaction', subtitle: 'Relaying to public chain' },
    // One kind-keyed entry serves both external-send and withdraw (accepted limitation): the mockup
    // splits these by mode. We use the external-send subtitle (neutral — a withdraw also lands in an
    // external wallet) + the unshield completedLabel (accurate for both).
    'hub-confirmed': { label: 'Unshielding', subtitle: 'Sending USDC to external wallet', completedLabel: 'Unshielded' },
  },
  'unshield-xchain': {
    'build-proof': { label: 'Preparing transaction', subtitle: 'Building zero-knowledge proof' },
    'submit-relayer': { label: 'Submitting transaction', subtitle: 'Relaying to public chain' },
    'hub-burn-confirmed': { label: 'Bridging', subtitle: 'Confirmed on hub' },
    'iris-attestation-pending': { label: 'Bridging', subtitle: 'Waiting for cross-chain confirmation' },
    'iris-attestation-ready': { label: 'Bridging', subtitle: 'Cross-chain confirmation ready' },
    'client-mint-pending': { label: 'Delivering', subtitle: 'Delivering on the destination chain' },
    'client-mint-confirmed': { label: 'Delivering', subtitle: 'Confirming on chain', completedLabel: 'Funds delivered' },
  },
  'transfer-shielded': {
    'build-proof': { label: 'Preparing transaction', subtitle: 'Building zero-knowledge proof' },
    'submit-relayer': { label: 'Submitting transaction', subtitle: 'Relaying privately to recipient' },
    'hub-confirmed': { label: 'Sending', subtitle: 'Delivering privately to recipient', completedLabel: 'Sent' },
  },
  'transfer-shielded-received': {
    observed: { label: 'Received', subtitle: 'Payment received', completedLabel: 'Received' },
  },
  'yield-deposit': {
    'build-proof': { label: 'Preparing transaction', subtitle: 'Building zero-knowledge proof' },
    'submit-relayer': { label: 'Submitting privately', subtitle: 'Relaying to shielded vault' },
    'hub-confirmed': { label: 'Adding to shielded vault', subtitle: 'USDC is entering the shielded vault', completedLabel: 'Earning' },
  },
  'yield-withdraw': {
    'build-proof': { label: 'Preparing transaction', subtitle: 'Building zero-knowledge proof' },
    'submit-relayer': { label: 'Submitting privately', subtitle: 'Relaying to shielded vault' },
    'hub-confirmed': { label: 'Withdrawing', subtitle: 'USDC is returning to your balance', completedLabel: 'Returned to balance' },
  },
}

/**
 * Reassurance subtitle — shown ONLY once the tx has broadcast on chain (`sourceTxHash` present).
 * Before broadcast, closing the browser tab would abort the tx (useTxResume fails pre-broadcast
 * interruptions), so we don't promise background processing until it's genuinely safe to leave.
 */
const CLOSE_SUBTITLE_LINES = [
  'You can now close this window.',
  "We'll keep processing in the background.",
] as const

/** Generic pre-broadcast subtitle (shown for every kind until the tx is on chain). */
const PREPARING_SUBTITLE = 'Preparing your transaction…'

/** Which Send/Withdraw flow the user is in — needed to disambiguate the shared `unshield-*` kinds. */
export type SendVariant = 'send' | 'withdraw'

type CardBase = Pick<TxProgressCardCopy, 'tag' | 'title' | 'titleLines' | 'titleBreakAfter'>

/**
 * Hero card tag + title per flow. The Send/Withdraw flow shares the `unshield-*` kinds across two
 * user intents — an external send vs a withdraw-to-wallet — so those need `sendVariant` to pick the
 * right framing (mirrors the mockup's `sendProcessingCopyMode`). Every other kind resolves from the
 * kind alone. (`tag` isn't rendered today — the card shows title + subtitle — but is kept for
 * accessible-name fidelity with the mockup.)
 */
function resolveCardBase(record: TxRecord, sendVariant?: SendVariant): CardBase {
  switch (record.kind) {
    case 'shield':
    case 'shield-xchain':
      return {
        tag: 'Shield in progress',
        title: 'Your USDC is being shielded',
        titleLines: ['Your USDC is', 'being shielded'],
      }
    case 'transfer-shielded':
      return {
        tag: 'Private send in progress',
        title: 'Sending your USDC privately',
        titleBreakAfter: 'your',
      }
    case 'transfer-shielded-received':
      return { tag: 'Received', title: 'Payment received' }
    case 'unshield-local':
    case 'unshield-xchain':
      return sendVariant === 'withdraw'
        ? {
            tag: 'Unshield in progress',
            title: 'Unshielding your USDC',
            titleLines: ['Unshielding your', 'USDC'],
          }
        : {
            tag: 'Send in progress',
            title: 'Unshielding and sending your USDC',
            titleLines: ['Unshielding and sending', 'your USDC'],
          }
    case 'yield-deposit':
      return {
        tag: 'Deposit to shielded vault in progress',
        title: 'Sending USDC to shielded vault',
        titleBreakAfter: 'USDC',
      }
    case 'yield-withdraw':
      return {
        tag: 'Withdraw from shielded vault in progress',
        title: 'Withdraw from shielded vault in progress',
      }
  }
}

export interface ProcessingView {
  cardCopy: TxProgressCardCopy
  stages: TxProgressStage[]
  activeStageIndex: number
  completed: boolean
}

/**
 * Build the processing view model from a live record. Stages come from the record's real lifecycle
 * (not a fixed 3-step demo); `activeStageIndex` tracks `record.stage`, snapping to the final stage
 * once the flow completes.
 */
export function buildProcessingView(
  record: TxRecord,
  opts?: { sendVariant?: SendVariant },
): ProcessingView {
  const stageIds = lifecycleFor(record.kind).stages as ReadonlyArray<string>
  const copyMap = STAGE_COPY[record.kind]
  const stages: TxProgressStage[] = stageIds.map((id) => {
    const entry = copyMap[id]
    return {
      id,
      label: entry?.label ?? id,
      subtitle: entry?.subtitle ?? '',
      completedLabel: entry?.completedLabel,
    }
  })

  const completed = record.executionState === 'completed'
  const currentIndex = stageIds.indexOf(record.stage as string)
  const activeStageIndex = completed
    ? Math.max(0, stages.length - 1)
    : Math.max(0, currentIndex)

  // Only promise "safe to close" once the tx has broadcast on chain — before that, leaving the tab
  // would abort it (nothing was submitted yet). Pre-broadcast keeps the neutral per-kind subtitle.
  const broadcast = Boolean(record.artifacts.sourceTxHash)
  const base = resolveCardBase(record, opts?.sendVariant)
  const cardCopy: TxProgressCardCopy = broadcast
    ? { ...base, subtitle: CLOSE_SUBTITLE_LINES.join(' '), subtitleLines: CLOSE_SUBTITLE_LINES }
    : { ...base, subtitle: PREPARING_SUBTITLE }

  return { cardCopy, stages, activeStageIndex, completed }
}
