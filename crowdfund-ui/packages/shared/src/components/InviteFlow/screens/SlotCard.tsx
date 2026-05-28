// ABOUTME: Ported from the armada-crowdfund mockup (InviteFlow/screens/SlotCard.tsx).
// ABOUTME: Extended with optional controlled `resolveEns` prop so consumers can plumb real ENS resolution; the internal mock resolver still runs when the prop is undefined (preview only — returns a random address).

import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import styles from './SlotCard.module.css'
import { Button } from '@armada/ui'
import { Tag } from '@armada/ui'

// ── Types ──────────────────────────────────────────────────────────────────

export type SlotStatus = 'empty' | 'link-active' | 'onchain-pending' | 'redeemed'
type ExpandedAction = 'link' | 'onchain' | null
type EnsState = 'idle' | 'resolving' | 'resolved' | 'error'

export interface SlotData {
  id: number
  status: SlotStatus
  link?: string
  expiresAt?: Date
  invitedAddress?: string
  ensName?: string
  redeemedBy?: string
}

/**
 * Result of resolving an ENS name. Consumers that don't pass `resolveEns`
 * fall back to the internal mock resolver — fine for showcase but should NOT
 * be used to issue real on-chain invites (mock returns a random address).
 */
export type SlotCardEnsResult =
  | { address: string }
  | { error: string }

interface SlotCardProps {
  slot: SlotData
  onGenerateLink: (slotId: number) => Promise<void>
  onCopy: (slotId: number, link: string) => void
  onRevoke: (slotId: number) => void
  onInviteOnchain: (slotId: number, address: string, ensName?: string) => Promise<void>
  copied?: boolean
  loading?: boolean
  /** Showcase / static demos — start with link or onchain panel open */
  defaultExpandedAction?: Exclude<ExpandedAction, null>
  /**
   * Controlled ENS resolver. Called when the user types an ENS-looking input.
   * Return `{ address }` on success or `{ error }` on failure. Omit to use
   * the internal mock (random address — preview only).
   */
  resolveEns?: (input: string) => Promise<SlotCardEnsResult>
}

// ── Helpers ────────────────────────────────────────────────────────────────

function formatExpiry(date: Date): string {
  const diffDays = Math.ceil((date.getTime() - Date.now()) / 86400000)
  if (diffDays <= 0) return 'Expired'
  if (diffDays === 1) return 'Expires tomorrow'
  return `Expires in ${diffDays} days`
}

function truncateLink(link: string): string {
  if (link.length <= 28) return link
  return link.slice(0, 14) + '…' + link.slice(-8)
}

export function truncateAddress(addr: string): string {
  if (addr.length <= 12) return addr
  return addr.slice(0, 6) + '…' + addr.slice(-4)
}

function isValidAddress(val: string): boolean {
  return /^0x[a-fA-F0-9]{40}$/.test(val)
}

function isEns(val: string): boolean {
  return val.endsWith('.eth') && val.length > 4
}

// ── Component ──────────────────────────────────────────────────────────────

export default function SlotCard({
  slot,
  onGenerateLink,
  onCopy,
  onRevoke,
  onInviteOnchain,
  copied = false,
  loading = false,
  defaultExpandedAction,
  resolveEns,
}: SlotCardProps) {
  const [expandedAction, setExpandedAction] = useState<ExpandedAction>(
    slot.status === 'empty' ? (defaultExpandedAction ?? null) : null
  )
  const [addressInput, setAddressInput] = useState('')
  // Mirror of `addressInput` in a ref so async ENS resolution can race-guard
  // against the user typing more characters while a lookup is in flight.
  const addressInputRef = useRef(addressInput)
  addressInputRef.current = addressInput
  const [ensState, setEnsState] = useState<EnsState>('idle')
  const [resolvedAddress, setResolvedAddress] = useState('')
  const [revokeConfirmOpen, setRevokeConfirmOpen] = useState(false)
  const [revokePopoverPos, setRevokePopoverPos] = useState<{ top: number; left: number } | null>(
    null,
  )
  const revokeBtnRef = useRef<HTMLButtonElement>(null)
  const revokePopoverRef = useRef<HTMLDivElement>(null)

  const resetInput = () => {
    setAddressInput('')
    setEnsState('idle')
    setResolvedAddress('')
  }

  const toggleExpand = (action: ExpandedAction) => {
    if (expandedAction === action) {
      setExpandedAction(null)
      resetInput()
    } else {
      setExpandedAction(action)
      resetInput()
    }
  }

  const handleAddressChange = async (val: string) => {
    setAddressInput(val)
    setResolvedAddress('')
    if (isEns(val)) {
      setEnsState('resolving')
      // Controlled mode — delegate to the consumer's real ENS resolver.
      // Race-guard via the input value: if the user kept typing while we
      // were resolving, drop a stale result on the floor.
      if (resolveEns) {
        try {
          const result = await resolveEns(val)
          if (val !== addressInputRef.current) return
          if ('address' in result) {
            setResolvedAddress(result.address)
            setEnsState('resolved')
          } else {
            setEnsState('error')
          }
        } catch {
          if (val !== addressInputRef.current) return
          setEnsState('error')
        }
        return
      }
      // Uncontrolled mock — preserved for showcase / preview only.
      await new Promise(r => setTimeout(r, 900))
      if (val === 'invalid.eth') {
        setEnsState('error')
      } else {
        const mock = '0x' + Math.random().toString(16).slice(2, 42)
        setResolvedAddress(mock)
        setEnsState('resolved')
      }
    } else if (isValidAddress(val)) {
      setEnsState('resolved')
      setResolvedAddress(val)
    } else {
      setEnsState('idle')
    }
  }

  const handleGenerateLink = async () => {
    await onGenerateLink(slot.id)
    setExpandedAction(null)
  }

  const handleInviteOnchain = async () => {
    const address = resolvedAddress || addressInput
    if (!address) return
    await onInviteOnchain(
      slot.id,
      address,
      isEns(addressInput) ? addressInput : undefined
    )
    setExpandedAction(null)
    resetInput()
  }

  const canSubmitOnchain =
    ensState === 'resolved' && (resolvedAddress !== '' || isValidAddress(addressInput))

  const updateRevokePopoverPosition = () => {
    const anchor = revokeBtnRef.current
    if (!anchor) return
    const rect = anchor.getBoundingClientRect()
    const popover = revokePopoverRef.current
    const popoverHeight = popover?.offsetHeight ?? 120
    const gap = 6
    const top = rect.top - gap - popoverHeight
    setRevokePopoverPos({ top, left: rect.right })
  }

  useLayoutEffect(() => {
    if (!revokeConfirmOpen) {
      setRevokePopoverPos(null)
      return
    }
    updateRevokePopoverPosition()
  }, [revokeConfirmOpen])

  useEffect(() => {
    if (!revokeConfirmOpen) return

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setRevokeConfirmOpen(false)
    }

    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as Node
      if (revokeBtnRef.current?.contains(target)) return
      if (revokePopoverRef.current?.contains(target)) return
      setRevokeConfirmOpen(false)
    }

    const onReposition = () => updateRevokePopoverPosition()

    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('pointerdown', onPointerDown)
    window.addEventListener('resize', onReposition)
    window.addEventListener('scroll', onReposition, true)

    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('pointerdown', onPointerDown)
      window.removeEventListener('resize', onReposition)
      window.removeEventListener('scroll', onReposition, true)
    }
  }, [revokeConfirmOpen])

  const handleConfirmRevoke = () => {
    onRevoke(slot.id)
    setRevokeConfirmOpen(false)
  }

  const isExpanded = expandedAction !== null
  const isAvailable = slot.status === 'empty'

  return (
    <div
      className={[
        styles.card,
        isExpanded ? styles.expanded : '',
      ].join(' ')}
    >
      {/* ── Main row ── */}
      <div className={styles.row}>
        {/* Badge */}
        <div className={[styles.badge, isAvailable && styles.badgeAvailable].filter(Boolean).join(' ')}>
          <span className={styles.badgeNumber}>{slot.id}</span>
        </div>

        {/* Empty label */}
        {slot.status === 'empty' && (
          <span className={styles.availableLabel}>Available</span>
        )}

        {/* Right content */}
        <div className={styles.right}>

          {/* Empty — action buttons */}
          {slot.status === 'empty' && (
            <div className={styles.actions}>
              <Button
                variant="secondary"
                size="sm"
                label="Create link"
                showIcon={false}
                onClick={() => toggleExpand('link')}
              />
              <Button
                variant="secondary"
                size="sm"
                label="Invite onchain"
                showIcon={false}
                onClick={() => toggleExpand('onchain')}
              />
            </div>
          )}

          {/* Link active */}
          {slot.status === 'link-active' && slot.link && (
            <div className={styles.linkRow}>
              <div className={styles.linkStack}>
                <span className={styles.linkText}>{truncateLink(slot.link)}</span>
                <div className={styles.linkMeta}>
                  <span className={styles.pendingLabel}>Pending</span>
                  {slot.expiresAt && (
                    <>
                      <span className={styles.dot} aria-hidden="true">·</span>
                      <span className={styles.expiry}>{formatExpiry(slot.expiresAt)}</span>
                    </>
                  )}
                </div>
              </div>
              <div className={styles.linkButtons}>
                <button
                  className={styles.textBtn}
                  onClick={() => onCopy(slot.id, slot.link!)}
                >
                  {copied ? 'Copied' : 'Copy'}
                </button>
                <button
                  ref={revokeBtnRef}
                  type="button"
                  className={[styles.textBtn, styles.textBtnDanger].join(' ')}
                  aria-expanded={revokeConfirmOpen}
                  aria-haspopup="dialog"
                  onClick={() => {
                    if (revokeConfirmOpen) {
                      setRevokeConfirmOpen(false)
                      return
                    }
                    const rect = revokeBtnRef.current?.getBoundingClientRect()
                    if (rect) {
                      setRevokePopoverPos({ top: rect.top - 6, left: rect.right })
                    }
                    setRevokeConfirmOpen(true)
                  }}
                >
                  Revoke
                </button>
              </div>
            </div>
          )}

          {/* Onchain pending */}
          {slot.status === 'onchain-pending' && slot.invitedAddress && (
            <div className={styles.statusRow}>
              <div className={styles.addressStack}>
                <span className={styles.addressPrimary}>
                  {slot.ensName ?? truncateAddress(slot.invitedAddress)}
                </span>
                {slot.ensName && (
                  <span className={styles.addressSecondary}>
                    {truncateAddress(slot.invitedAddress)}
                  </span>
                )}
              </div>
              <Tag label="Invited" dot="lavender" />
            </div>
          )}

          {/* Redeemed */}
          {slot.status === 'redeemed' && (
            <div className={styles.statusRow}>
              <span className={styles.addressPrimary}>
                {slot.redeemedBy
                  ? truncateAddress(slot.redeemedBy)
                  : 'Link redeemed'}
              </span>
              <Tag label="Joined" dot="active" />
            </div>
          )}

        </div>
      </div>

      {/* ── Expanded: create link ── */}
      {slot.status === 'empty' && expandedAction === 'link' && (
        <div className={styles.expandedSection}>
          <p className={styles.hint}>
            Your wallet will sign a message to generate the link. No gas required.
          </p>
          <div className={styles.expandedAction}>
            <Button
              variant="primary"
              size="sm"
              label={loading ? 'Generating…' : 'Generate link'}
              showIcon={false}
              onClick={handleGenerateLink}
              disabled={loading}
            />
          </div>
        </div>
      )}

      {/* ── Expanded: invite onchain ── */}
      {slot.status === 'empty' && expandedAction === 'onchain' && (
        <div className={styles.expandedSection}>
          <div className={styles.inputWrapper}>
            <input
              type="text"
              className={[
                styles.input,
                ensState === 'error' ? styles.inputError : '',
                ensState === 'resolved' ? styles.inputResolved : '',
              ].join(' ')}
              placeholder="0x… or name.eth"
              value={addressInput}
              onChange={e => handleAddressChange(e.target.value)}
              aria-label="Wallet address or ENS name"
              spellCheck={false}
            />
            {ensState === 'resolving' && (
              <span className={styles.spinner} aria-label="Resolving ENS" />
            )}
            {ensState === 'resolved' &&
              resolvedAddress &&
              resolvedAddress !== addressInput && (
                <span className={styles.inlineResolved}>
                  {truncateAddress(resolvedAddress)}
                </span>
              )}
          </div>
          {ensState === 'error' && (
            <span className={styles.errorMsg}>ENS name not found</span>
          )}
          <p className={styles.hint}>
            This sends an onchain transaction. The invitee can then visit
            armada.wtf and commit. Requires gas.
          </p>
          <div className={styles.expandedAction}>
            <Button
              variant="primary"
              size="sm"
              label={loading ? 'Inviting…' : 'Send invite'}
              showIcon={false}
              onClick={handleInviteOnchain}
              disabled={!canSubmitOnchain || loading}
            />
          </div>
        </div>
      )}

      {revokeConfirmOpen &&
        revokePopoverPos &&
        createPortal(
          <div
            ref={revokePopoverRef}
            className={styles.revokePopover}
            role="dialog"
            aria-modal="false"
            aria-labelledby={`revoke-title-${slot.id}`}
            style={{ top: revokePopoverPos.top, left: revokePopoverPos.left }}
          >
            <p id={`revoke-title-${slot.id}`} className={styles.revokeTitle}>
              Revoke invite link?
            </p>
            <p className={styles.revokeBody}>
              This link will stop working. You can generate a new one anytime.
            </p>
            <div className={styles.revokeActions}>
              <Button
                variant="secondary"
                size="sm"
                label="Revoke link"
                showIcon={false}
                className={styles.revokeConfirmBtn}
                onClick={handleConfirmRevoke}
              />
              <Button
                variant="ghost"
                size="sm"
                label="Cancel"
                showIcon={false}
                className={styles.revokeCancelBtn}
                onClick={() => setRevokeConfirmOpen(false)}
              />
            </div>
          </div>,
          document.body,
        )}
    </div>
  )
}
