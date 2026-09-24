// ABOUTME: In-place invite action screen — method pick + link / onchain form for a target hop.
// ABOUTME: Supports hop-based InvitesCard UX and legacy slotId paths (Participate / InviteSlots).

import { useEffect, useId, useRef, useState } from 'react'
import { EllipsisHorizontalIcon } from '@heroicons/react/24/outline'
import { ZeroAddress } from 'ethers'
import { Button } from '@armada/ui'
import type { InviteMethod } from '../../lib/inviteUx'
import { hopPillDotColor } from '../../lib/graphHopColors'
import {
  ADDRESS_INPUT_MAX_LENGTH,
  isValidEnsName,
  sanitizeAddressInput,
  tryGetChecksumAddress,
} from '../../lib/addressInput'
import {
  formatExpiryDays,
  formatInviteeHop,
  type InviteeHop,
} from '../MyPosition/inviteModel'
import { truncateAddress, type SlotCardEnsResult } from './screens/SlotCard'
import styles from './InviteActionScreen.module.css'

type EnsState = 'idle' | 'resolving' | 'resolved' | 'error'

export type CreatedInviteLink = {
  id: number
  link: string
  expiresAt: Date
}

export type CreatedOnchainInvite = {
  id: number
  address: string
  ensName?: string
}

function isValidAddress(val: string): boolean {
  return tryGetChecksumAddress(val) !== null
}

function isEns(val: string): boolean {
  return val.endsWith('.eth') && val.length > 4
}

function isPasteableAddress(val: string): boolean {
  const trimmed = val.trim()
  return isValidAddress(trimmed) || isEns(trimmed)
}

function inviteLinkPath(url: string): string {
  try {
    const parsed = new URL(url)
    const path = `${parsed.pathname}${parsed.search}${parsed.hash}`
    return path.startsWith('/') ? path : `/${path}`
  } catch {
    return url.startsWith('/') ? url : `/${url}`
  }
}

function hopVariantForInvitee(hop: InviteeHop): 'hop-1' | 'hop-2' {
  return hop === 2 ? 'hop-2' : 'hop-1'
}

export interface InviteActionScreenProps {
  /** Target hop the invitee will join. Prefer over slotId for the hop-based card. */
  hop?: InviteeHop
  /** @deprecated Slot-index demos (InviteSlots / participate modal). */
  slotId?: number
  method: InviteMethod | null
  loading?: boolean
  onBack: () => void
  onSelectMethod?: (method: InviteMethod) => void
  onGenerateLink: (target: InviteeHop | number) => Promise<CreatedInviteLink | void>
  onInviteOnchain: (
    target: InviteeHop | number,
    address: string,
    ensName?: string,
  ) => Promise<CreatedOnchainInvite | void>
  onCopy?: (id: number, link: string) => void
  /** `link` identifies the invite link to revoke — prefer it over `id`, which is
   *  the slot the link was created through and can go stale as rows re-sort. */
  onRevoke?: (id: number, link?: string) => void | Promise<void>
  /** Reveal deferred invite in the sent list (Done / close confirmation). */
  onConfirmCreated?: (id: number) => void
  /** Drop deferred invite revoked from confirmation (never shown in list). */
  onDiscardCreated?: (id: number) => void
  copiedInviteId?: number | null
  /** Real ENS resolver — omit to use the internal mock (showcase only). */
  resolveEns?: (input: string) => Promise<SlotCardEnsResult>
}

export function InviteActionScreen({
  hop,
  slotId,
  method,
  loading = false,
  onBack,
  onSelectMethod,
  onGenerateLink,
  onInviteOnchain,
  onCopy,
  onRevoke,
  onConfirmCreated,
  onDiscardCreated,
  copiedInviteId = null,
  resolveEns,
}: InviteActionScreenProps) {
  const [addressInput, setAddressInput] = useState('')
  const addressInputRef = useRef(addressInput)
  addressInputRef.current = addressInput
  const [ensState, setEnsState] = useState<EnsState>('idle')
  const [resolvedAddress, setResolvedAddress] = useState('')
  const [createdLink, setCreatedLink] = useState<CreatedInviteLink | null>(null)
  const [createdOnchain, setCreatedOnchain] = useState<CreatedOnchainInvite | null>(
    null,
  )
  const [clipboardPaste, setClipboardPaste] = useState<string | null>(null)
  const [revoking, setRevoking] = useState(false)
  const [linkMenuOpen, setLinkMenuOpen] = useState(false)
  const addressInputElRef = useRef<HTMLInputElement>(null)
  const linkMenuRef = useRef<HTMLDivElement>(null)
  const linkMenuId = useId()
  const pendingConfirmIdRef = useRef<number | null>(null)
  const createGenerationRef = useRef(0)

  const target = hop ?? slotId
  if (target == null) {
    throw new Error('InviteActionScreen requires hop or slotId')
  }

  const hopLabel = hop != null ? formatInviteeHop(hop) : `Slot ${slotId}`
  const hopColor =
    hop != null ? hopPillDotColor(hopVariantForInvitee(hop)) : null
  const title = createdLink
    ? 'Link ready to share'
    : createdOnchain
      ? 'Invite sent on-chain'
      : method === 'link'
        ? 'Create and share an invite link'
        : method === 'onchain'
          ? 'Whitelist new address'
          : `Invite to ${hopLabel}`

  const hasAddressInput = addressInput.trim().length > 0
  const showPasteBtn =
    method === 'onchain' &&
    !createdOnchain &&
    !hasAddressInput &&
    clipboardPaste != null
  const canSubmitOnchain =
    ensState === 'resolved' && (resolvedAddress !== '' || isValidAddress(addressInput))

  const primaryLabel =
    method === 'link'
      ? loading
        ? 'Creating…'
        : 'Create link'
      : method === 'onchain'
        ? loading
          ? 'Inviting…'
          : hasAddressInput
            ? 'Send invite'
            : 'Insert address'
        : 'Continue'

  const primaryBlocked =
    method == null
      ? true
      : method === 'onchain'
        ? !canSubmitOnchain || loading
        : loading

  useEffect(() => {
    if (method !== 'onchain' || createdLink || createdOnchain) return
    const id = window.requestAnimationFrame(() => {
      addressInputElRef.current?.focus()
    })
    return () => window.cancelAnimationFrame(id)
  }, [method, createdLink, createdOnchain])

  useEffect(() => {
    if (method !== 'onchain' || createdOnchain || hasAddressInput) {
      setClipboardPaste(null)
      return
    }

    let cancelled = false

    const syncClipboard = async () => {
      try {
        const text = await navigator.clipboard.readText()
        if (cancelled) return
        setClipboardPaste(isPasteableAddress(text) ? text.trim() : null)
      } catch {
        if (!cancelled) setClipboardPaste(null)
      }
    }

    void syncClipboard()

    const onFocus = () => {
      void syncClipboard()
    }
    window.addEventListener('focus', onFocus)
    document.addEventListener('visibilitychange', onFocus)
    const intervalId = window.setInterval(() => {
      void syncClipboard()
    }, 1500)

    return () => {
      cancelled = true
      window.removeEventListener('focus', onFocus)
      document.removeEventListener('visibilitychange', onFocus)
      window.clearInterval(intervalId)
    }
  }, [method, createdOnchain, hasAddressInput])

  useEffect(() => {
    if (!linkMenuOpen) return
    const onPointerDown = (e: PointerEvent) => {
      if (linkMenuRef.current?.contains(e.target as Node)) return
      setLinkMenuOpen(false)
    }
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setLinkMenuOpen(false)
    }
    window.addEventListener('pointerdown', onPointerDown)
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('pointerdown', onPointerDown)
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [linkMenuOpen])

  const handleAddressChange = async (rawVal: string) => {
    const val = sanitizeAddressInput(rawVal)
    setAddressInput(val)
    setResolvedAddress('')
    if (isEns(val)) {
      if (!isValidEnsName(val)) {
        setEnsState('idle')
        return
      }
      setEnsState('resolving')
      if (resolveEns) {
        const result = await resolveEns(val)
        if (addressInputRef.current !== val) return
        if ('address' in result) {
          setResolvedAddress(result.address)
          setEnsState('resolved')
        } else {
          setEnsState('error')
        }
      } else {
        await new Promise((r) => setTimeout(r, 900))
        if (addressInputRef.current !== val) return
        if (val === 'invalid.eth') {
          setEnsState('error')
        } else {
          const mock = '0x' + Math.random().toString(16).slice(2, 42)
          setResolvedAddress(mock)
          setEnsState('resolved')
        }
      }
    } else {
      const checksum = tryGetChecksumAddress(val)
      if (checksum && checksum !== ZeroAddress) {
        setEnsState('resolved')
        setResolvedAddress(checksum)
      } else if (checksum === ZeroAddress) {
        setEnsState('error')
      } else {
        setEnsState('idle')
      }
    }
  }

  const handlePaste = async () => {
    const fromState = clipboardPaste
    if (fromState) {
      setClipboardPaste(null)
      await handleAddressChange(fromState)
      return
    }
    try {
      const text = await navigator.clipboard.readText()
      const trimmed = text.trim()
      if (isPasteableAddress(trimmed)) {
        setClipboardPaste(null)
        await handleAddressChange(trimmed)
      }
    } catch {
      addressInputElRef.current?.focus()
    }
  }

  const handleGenerateLink = async () => {
    if (loading) return
    const generation = ++createGenerationRef.current
    try {
      const created = await onGenerateLink(target)
      if (generation !== createGenerationRef.current) {
        if (created) onDiscardCreated?.(created.id)
        return
      }
      if (created) {
        pendingConfirmIdRef.current = created.id
        setCreatedLink(created)
        return
      }
      // Legacy slot handlers return void — close after create.
      onBack()
    } catch {
      // Keep the create screen open so the user can retry.
    }
  }

  const handleInviteOnchain = async () => {
    if (loading) return
    if (!canSubmitOnchain) {
      addressInputElRef.current?.focus()
      return
    }
    const address = resolvedAddress || addressInput
    const ensName = isEns(addressInput) ? addressInput : undefined
    const generation = ++createGenerationRef.current
    try {
      const created = await onInviteOnchain(target, address, ensName)
      if (generation !== createGenerationRef.current) {
        if (created) onDiscardCreated?.(created.id)
        return
      }
      if (created) {
        pendingConfirmIdRef.current = created.id
        setCreatedOnchain(created)
        return
      }
      // Legacy slot handlers return void — close after send.
      onBack()
    } catch {
      // Keep the form open so the user can retry.
    }
  }

  const finishConfirmation = (discard: boolean) => {
    const id = pendingConfirmIdRef.current ?? createdLink?.id ?? createdOnchain?.id
    pendingConfirmIdRef.current = null
    if (id != null && id >= 0) {
      if (discard) onDiscardCreated?.(id)
      else onConfirmCreated?.(id)
    }
    onBack()
  }

  const handleCancel = () => {
    createGenerationRef.current += 1
    const id = pendingConfirmIdRef.current
    pendingConfirmIdRef.current = null
    if (id != null && id >= 0) onDiscardCreated?.(id)
    onBack()
  }

  const handleRevokeCreated = () => {
    if (revoking) return
    setRevoking(true)
    try {
      finishConfirmation(true)
    } finally {
      setRevoking(false)
    }
  }

  const hopTag =
    hop != null && hopColor != null ? (
      <span className={styles.hopLabelRow}>
        <span
          className={styles.hopDot}
          style={{ background: hopColor }}
          aria-hidden
        />
        <span className={styles.hopLabel}>Invite to {hopLabel}</span>
      </span>
    ) : (
      <p className={styles.slotLabel}>Slot {slotId}</p>
    )

  if (createdLink) {
    const copied = copiedInviteId === createdLink.id
    const path = inviteLinkPath(createdLink.link)
    return (
      <div className={styles.root}>
        <div className={styles.topRow}>
          <div className={styles.titleBlock}>
            {hopTag}
            <h3 className={styles.title}>{title}</h3>
          </div>
        </div>
        <div className={styles.body}>
          <div className={styles.createdLinkBox}>
            <div className={styles.createdLinkMain}>
              <p className={styles.createdLinkPath} title={createdLink.link}>
                {path}
              </p>
              <p className={styles.createdLinkMeta}>
                {formatExpiryDays(createdLink.expiresAt)}
              </p>
            </div>
            <div className={styles.createdLinkMenu} ref={linkMenuRef}>
              <button
                type="button"
                className={styles.moreBtn}
                aria-label="More link actions"
                aria-haspopup="menu"
                aria-expanded={linkMenuOpen}
                aria-controls={linkMenuOpen ? linkMenuId : undefined}
                onClick={() => setLinkMenuOpen((open) => !open)}
              >
                <EllipsisHorizontalIcon className={styles.moreIcon} aria-hidden />
              </button>
              {linkMenuOpen && (
                <ul id={linkMenuId} className={styles.moreMenu} role="menu">
                  <li role="none">
                    <button
                      type="button"
                      role="menuitem"
                      className={[styles.moreMenuItem, styles.moreMenuItemDanger].join(' ')}
                      disabled={revoking || !onRevoke}
                      onClick={() => {
                        setLinkMenuOpen(false)
                        if (!onRevoke) {
                          handleRevokeCreated()
                          return
                        }
                        void (async () => {
                          setRevoking(true)
                          try {
                            await onRevoke(createdLink.id, createdLink.link)
                            // Already revoked — close without onDiscardCreated,
                            // which live wiring maps to a second revoke.
                            pendingConfirmIdRef.current = null
                            onBack()
                          } finally {
                            setRevoking(false)
                          }
                        })()
                      }}
                    >
                      {revoking ? 'Revoking…' : 'Revoke link'}
                    </button>
                  </li>
                </ul>
              )}
            </div>
          </div>
        </div>
        <div className={styles.ctaRow}>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            showIcon={false}
            label="Done"
            onClick={() => finishConfirmation(false)}
          />
          <Button
            type="button"
            variant="primary"
            size="sm"
            showIcon={false}
            label={copied ? 'Copied' : 'Copy link'}
            onClick={() => {
              onCopy?.(createdLink.id, createdLink.link)
            }}
          />
        </div>
      </div>
    )
  }

  if (createdOnchain) {
    const display =
      createdOnchain.ensName ?? truncateAddress(createdOnchain.address)
    return (
      <div className={styles.root}>
        <div className={styles.topRow}>
          <div className={styles.titleBlock}>
            {hopTag}
            <h3 className={styles.title}>{title}</h3>
          </div>
        </div>
        <div className={styles.body}>
          <p className={styles.hint}>
            On-chain invites cannot be revoked. The invitee can commit when ready.
          </p>
          <div className={styles.createdLinkBox}>
            <div className={styles.createdLinkMain}>
              <p
                className={
                  createdOnchain.ensName ? styles.createdLinkPath : styles.createdAddressMono
                }
                title={createdOnchain.address}
              >
                {display}
              </p>
            </div>
          </div>
        </div>
        <div className={styles.ctaRow}>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            showIcon={false}
            label="Done"
            onClick={() => finishConfirmation(false)}
          />
        </div>
      </div>
    )
  }

  return (
    <div className={styles.root}>
      <div className={styles.topRow}>
        <div className={styles.titleBlock}>
          {hopTag}
          <h3 className={styles.title}>{title}</h3>
        </div>
      </div>
      <div className={styles.body}>
        {method == null && onSelectMethod && (
          <div className={styles.methodPick} role="group" aria-label="Invite method">
            <Button
              type="button"
              variant="secondary"
              size="sm"
              showIcon={false}
              label="Whitelist new address"
              onClick={() => onSelectMethod('onchain')}
            />
            <Button
              type="button"
              variant="secondary"
              size="sm"
              showIcon={false}
              label="Share link"
              onClick={() => onSelectMethod('link')}
            />
          </div>
        )}

        {method === 'onchain' && (
          <div className={styles.field}>
            <label className={styles.fieldLabel} htmlFor="invite-action-address">
              Wallet address or ENS
            </label>
            <div className={styles.inputWrapper}>
              <input
                ref={addressInputElRef}
                id="invite-action-address"
                className={[styles.input, showPasteBtn && styles.inputWithPaste]
                  .filter(Boolean)
                  .join(' ')}
                value={addressInput}
                onChange={(e) => {
                  void handleAddressChange(e.target.value)
                }}
                placeholder="0x… or name.eth"
                autoComplete="off"
                spellCheck={false}
                maxLength={ADDRESS_INPUT_MAX_LENGTH}
                aria-invalid={ensState === 'error'}
              />
              {showPasteBtn && (
                <div className={styles.inputTrailing}>
                  <button
                    type="button"
                    className={styles.pasteBtn}
                    aria-label="Paste address from clipboard"
                    onClick={() => {
                      void handlePaste()
                    }}
                  >
                    Paste
                  </button>
                </div>
              )}
            </div>
            {ensState === 'resolving' && (
              <p className={styles.hint} role="status">
                Resolving ENS…
              </p>
            )}
            {ensState === 'resolved' && resolvedAddress && (
              <p className={styles.hint} role="status">
                {truncateAddress(resolvedAddress)}
              </p>
            )}
            {ensState === 'error' && (
              <span className={styles.errorMsg} role="alert">
                Could not resolve address
              </span>
            )}
          </div>
        )}

        {method === 'link' && (
          <p className={styles.hint}>
            Anyone with the link can join at {hopLabel}. You can revoke unused links
            later.
          </p>
        )}
      </div>

      {method != null && (
        <div className={styles.ctaRow}>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            showIcon={false}
            label="Cancel"
            // A submitted tx / pending signature can't be cancelled from
            // here — the wallet prompt is the place to reject it.
            disabled={loading}
            onClick={handleCancel}
          />
          <Button
            type="button"
            variant="primary"
            size="sm"
            showIcon={false}
            label={primaryLabel}
            disabled={primaryBlocked}
            loading={loading}
            onClick={() => {
              if (method === 'link') void handleGenerateLink()
              else void handleInviteOnchain()
            }}
          />
        </div>
      )}
    </div>
  )
}
