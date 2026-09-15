// ABOUTME: Crowdfund Details modal — blurred backdrop over the hero with observe status/table/log cards.
// ABOUTME: Replaces the former full-page Observe route opened from the Progress "Details" control.

import { useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { XMarkIcon } from '@heroicons/react/24/outline'
import type { JsonRpcProvider } from 'ethers'
import type { ContractState, CrowdfundEvent } from '@armada/crowdfund-shared'
import { ObserveStatusCard } from '@/components/ObserveStatusCard'
import { ObserveParticipantsTable } from '@/components/ObserveParticipantsTable'
import { ObserveEventLog } from '@/components/ObserveEventLog'
import styles from './ObserveDetailsModal.module.css'

const EXIT_MS = 280

export interface ObserveDetailsModalProps {
  open: boolean
  onClose: () => void
  state: ContractState
  events: CrowdfundEvent[]
  eventsLoading: boolean
  provider: JsonRpcProvider | null
}

export function ObserveDetailsModal({
  open,
  onClose,
  state,
  events,
  eventsLoading,
  provider,
}: ObserveDetailsModalProps) {
  const closeRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const titleId = useId()
  const [mounted, setMounted] = useState(open)
  const [exiting, setExiting] = useState(false)
  const onCloseRef = useRef(onClose)

  useEffect(() => {
    onCloseRef.current = onClose
  }, [onClose])

  useEffect(() => {
    if (open) {
      setMounted(true)
      setExiting(false)
      return
    }
    if (!mounted) return
    setExiting(true)
    const timer = window.setTimeout(() => {
      setMounted(false)
      setExiting(false)
    }, EXIT_MS)
    return () => window.clearTimeout(timer)
  }, [open, mounted])

  useEffect(() => {
    if (!mounted || exiting) return

    const prevOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    closeRef.current?.focus()

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCloseRef.current()
    }
    window.addEventListener('keydown', onKeyDown)

    return () => {
      document.body.style.overflow = prevOverflow
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [mounted, exiting])

  if (!mounted) return null

  return createPortal(
    <div
      className={[styles.backdrop, exiting && styles.backdropExit].filter(Boolean).join(' ')}
      role="presentation"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div
        ref={panelRef}
        className={[styles.panel, exiting && styles.panelExit].filter(Boolean).join(' ')}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
      >
        <div className={styles.header}>
          <h2 id={titleId} className={styles.title}>
            Crowdfund details
          </h2>
          <button
            ref={closeRef}
            type="button"
            className={styles.close}
            onClick={onClose}
            aria-label="Close crowdfund details"
          >
            <XMarkIcon width={20} height={20} aria-hidden />
          </button>
        </div>

        <div className={styles.body}>
          <ObserveStatusCard state={state} />
          <ObserveParticipantsTable events={events} phase={state.phase} provider={provider} />
          <ObserveEventLog events={events} loading={eventsLoading} provider={provider} />
        </div>
      </div>
    </div>,
    document.body,
  )
}
