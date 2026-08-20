// ABOUTME: RequestReceiveScreen — compose a payment request (amount + expiry + note) that becomes a shareable link.
// ABOUTME: The first step of the Request flow; "Create link" advances to RequestLinkScreen. Amount-less requests copy the raw address instead.

import { useId } from 'react'
import { Button, modalStepBodyEnter, modalActionRowEnter } from '@/design'
import { SegmentedControl } from '@/components/ui'
import { hasActiveAmount, sanitizeAmountInput } from '@/utils/amountInput'
import {
  REQUEST_LINK_EXPIRY_OPTIONS,
  REQUEST_NOTE_MAX_LENGTH,
  type RequestLinkExpiryId,
} from '@/lib/payViaLink'
import styles from './RequestReceiveScreen.module.css'

export interface RequestReceiveScreenProps {
  amount: string
  note: string
  expiryId: RequestLinkExpiryId
  onAmountChange: (amount: string) => void
  onNoteChange: (note: string) => void
  onExpiryChange: (expiryId: RequestLinkExpiryId) => void
  onCancel: () => void
  onCreateLink: () => void
}

export function RequestReceiveScreen({
  amount,
  note,
  expiryId,
  onAmountChange,
  onNoteChange,
  onExpiryChange,
  onCancel,
  onCreateLink,
}: RequestReceiveScreenProps) {
  const amountInputId = useId()
  const noteInputId = useId()

  const canCreateLink = hasActiveAmount(amount)
  const ctaLabel = canCreateLink ? 'Create link' : 'Input amount'

  function handleAmountChange(raw: string) {
    const next = sanitizeAmountInput(raw)
    onAmountChange(hasActiveAmount(next) ? next : '')
  }

  return (
    <div className={styles.column}>
      <div className={modalStepBodyEnter}>
        <div className={styles.linkCard}>
          <h1 className={`armada-text-ui-body-lg ${styles.cardTitle}`}>Request USDC via link</h1>

          <div className={styles.amountRow}>
            <div className={styles.amountGroup}>
              <div className={styles.amountField}>
                <input
                  id={amountInputId}
                  className={styles.amountInput}
                  type="text"
                  inputMode="decimal"
                  autoComplete="off"
                  placeholder="0"
                  value={amount}
                  onChange={(event) => handleAmountChange(event.target.value)}
                  aria-label="Requested amount in USDC"
                  size={Math.max(1, amount.length || 1)}
                />
              </div>
            </div>
          </div>

          <div className={[styles.fieldBlock, styles.expiryFieldBlock].join(' ')}>
            <p className={styles.fieldLabel}>Link expires</p>
            <SegmentedControl<RequestLinkExpiryId>
              size="md"
              aria-label="Link expiry"
              value={expiryId}
              onChange={onExpiryChange}
              options={REQUEST_LINK_EXPIRY_OPTIONS}
            />
          </div>

          <div className={[styles.fieldBlock, styles.noteFieldBlock].join(' ')}>
            <label className={styles.fieldLabel} htmlFor={noteInputId}>
              Note <span className={styles.fieldOptional}>(optional)</span>
            </label>
            <textarea
              id={noteInputId}
              className={styles.noteInput}
              value={note}
              maxLength={REQUEST_NOTE_MAX_LENGTH}
              placeholder="For invoice #123"
              rows={2}
              onChange={(event) => onNoteChange(event.target.value)}
            />
            <p className={styles.noteMeta}>
              {note.length}/{REQUEST_NOTE_MAX_LENGTH}
            </p>
          </div>
        </div>
      </div>

      <div className={`${styles.buttonRow} ${modalActionRowEnter}`}>
        <Button variant="secondary" size="lg" label="Cancel" showIcon={false} onClick={onCancel} />
        <Button
          variant="primary"
          size="lg"
          label={ctaLabel}
          showIcon={false}
          disabled={!canCreateLink}
          onClick={onCreateLink}
        />
      </div>
    </div>
  )
}
