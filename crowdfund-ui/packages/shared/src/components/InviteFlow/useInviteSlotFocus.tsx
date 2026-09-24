// ABOUTME: State + transitions for hop invite UX (list ↔ picker ↔ in-place action).

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import type { InviteMethod } from '../../lib/inviteUx'
import {
  formatInviteeHop,
  type InviteeHop,
} from '../MyPosition/inviteModel'
import { InviteActionScreen } from './InviteActionScreen'
import { InviteMethodPicker } from './InviteMethodPicker'
import focusStyles from './inviteSlotFocus.module.css'

/** List ↔ action crossfade duration (matches inviteExit / goBack timer). */
export const INVITE_FOCUS_TRANSITION_MS = 240
/** List frame enter duration (matches inviteEnter in CSS). */
export const INVITE_LIST_ENTER_MS = 320
/** Delay after list mounts before hop count starts rolling. */
export const INVITE_COUNT_ROLL_DELAY_MS = 260
/** Hop thumb odometer roll duration. */
export const INVITE_COUNT_ROLL_MS = 480

const TRANSITION_MS = INVITE_FOCUS_TRANSITION_MS

export type InviteFocusView = 'list' | 'action'

export interface InviteHopFocus {
  view: InviteFocusView
  fading: boolean
  /** Target hop while the invite action screen is open. */
  focusHop: InviteeHop | null
  /** Method chosen via picker (set when entering action). */
  focusMethod: InviteMethod | null
  /** Hop whose Invite CTA currently has the method picker open. */
  pickerHop: InviteeHop | null
  pickerAnchor: HTMLElement | null
  openPicker: (hop: InviteeHop, anchor: HTMLElement) => void
  closePicker: () => void
  selectMethod: (method: InviteMethod) => void
  goBack: () => void
  frameClassName: string
  registerInviteButton: (hop: InviteeHop, el: HTMLButtonElement | null) => void
  restoreFocusToInvite: () => void
}

export function useInviteHopFocus(): InviteHopFocus {
  const [renderView, setRenderView] = useState<InviteFocusView>('list')
  const [fading, setFading] = useState(false)
  const [focusHop, setFocusHop] = useState<InviteeHop | null>(null)
  const [focusMethod, setFocusMethod] = useState<InviteMethod | null>(null)
  const [pickerHop, setPickerHop] = useState<InviteeHop | null>(null)
  const [pickerAnchor, setPickerAnchor] = useState<HTMLElement | null>(null)
  const inviteBtnRefs = useRef<Map<InviteeHop, HTMLElement>>(new Map())
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const clearTimer = () => {
    if (timerRef.current) {
      clearTimeout(timerRef.current)
      timerRef.current = null
    }
  }

  const transitionTo = useCallback((next: InviteFocusView) => {
    clearTimer()
    setFading(true)
    timerRef.current = setTimeout(() => {
      setRenderView(next)
      setFading(false)
      timerRef.current = null
    }, TRANSITION_MS)
  }, [])

  const registerInviteButton = useCallback((hop: InviteeHop, el: HTMLButtonElement | null) => {
    if (el) inviteBtnRefs.current.set(hop, el)
    else inviteBtnRefs.current.delete(hop)
  }, [])

  const openPicker = useCallback((hop: InviteeHop, anchor: HTMLElement) => {
    inviteBtnRefs.current.set(hop, anchor)
    setPickerHop(hop)
    setPickerAnchor(anchor)
  }, [])

  const closePicker = useCallback(() => {
    setPickerHop(null)
    setPickerAnchor(null)
  }, [])

  const selectMethod = useCallback(
    (method: InviteMethod) => {
      if (pickerHop == null) return
      const hop = pickerHop
      setFocusHop(hop)
      setFocusMethod(method)
      closePicker()
      transitionTo('action')
    },
    [pickerHop, closePicker, transitionTo],
  )

  const restoreFocusToInvite = useCallback(() => {
    const hop = focusHop
    if (hop == null) return
    requestAnimationFrame(() => {
      inviteBtnRefs.current.get(hop)?.focus()
    })
  }, [focusHop])

  const goBack = useCallback(() => {
    clearTimer()
    setFading(true)
    timerRef.current = setTimeout(() => {
      setRenderView('list')
      setFading(false)
      const hop = focusHop
      setFocusHop(null)
      setFocusMethod(null)
      timerRef.current = null
      if (hop != null) {
        requestAnimationFrame(() => {
          inviteBtnRefs.current.get(hop)?.focus()
        })
      }
    }, TRANSITION_MS)
  }, [focusHop])

  const frameClassName = [
    focusStyles.frame,
    fading ? focusStyles.frameExit : focusStyles.frameEnter,
  ].join(' ')

  return {
    view: renderView,
    fading,
    focusHop,
    focusMethod,
    pickerHop,
    pickerAnchor,
    openPicker,
    closePicker,
    selectMethod,
    goBack,
    frameClassName,
    registerInviteButton,
    restoreFocusToInvite,
  }
}

export interface InviteHopFocusChromeProps {
  focusApi: InviteHopFocus
  loadingHop?: InviteeHop | null
  onGenerateLink: (
    hop: InviteeHop,
  ) => Promise<{ id: number; link: string; expiresAt: Date } | void>
  onInviteOnchain: (
    hop: InviteeHop,
    address: string,
    ensName?: string,
  ) => Promise<{ id: number; address: string; ensName?: string } | void>
  onCopy?: (id: number, link: string) => void
  onRevoke?: (id: number, link?: string) => void | Promise<void>
  onConfirmCreated?: (id: number) => void
  onDiscardCreated?: (id: number) => void
  copiedInviteId?: number | null
  resolveEns?: (
    input: string,
  ) => Promise<import('./screens/SlotCard').SlotCardEnsResult>
  list: ReactNode
}

/** Renders hop list or in-place invite action + method picker portal. */
export function InviteHopFocusChrome({
  focusApi,
  loadingHop = null,
  onGenerateLink,
  onInviteOnchain,
  onCopy,
  onRevoke,
  onConfirmCreated,
  onDiscardCreated,
  copiedInviteId = null,
  resolveEns,
  list,
}: InviteHopFocusChromeProps) {
  const {
    view,
    fading,
    focusHop,
    focusMethod,
    pickerHop,
    pickerAnchor,
    closePicker,
    selectMethod,
    goBack,
    frameClassName,
  } = focusApi
  const shellRef = useRef<HTMLDivElement>(null)
  const [lockedMinHeight, setLockedMinHeight] = useState<number | undefined>()

  const handleSelect = useCallback(
    (method: InviteMethod) => {
      const surface = shellRef.current?.closest('[data-invite-surface]')
      if (surface instanceof HTMLElement) {
        surface.style.minHeight = `${surface.offsetHeight}px`
      } else if (shellRef.current) {
        setLockedMinHeight(shellRef.current.offsetHeight)
      }
      selectMethod(method)
    },
    [selectMethod],
  )

  useEffect(() => {
    if (view !== 'list' || fading) return
    setLockedMinHeight(undefined)
    const surface = shellRef.current?.closest('[data-invite-surface]')
    if (surface instanceof HTMLElement) {
      surface.style.minHeight = ''
    }
  }, [view, fading])

  const pickerTitle =
    pickerHop != null ? `Invite to ${formatInviteeHop(pickerHop)}` : 'Whitelist a friend'

  return (
    <div
      ref={shellRef}
      className={focusStyles.shell}
      style={lockedMinHeight != null ? { minHeight: lockedMinHeight } : undefined}
    >
      <div key={view} className={frameClassName}>
        {view === 'list' && list}
        {view === 'action' && focusHop != null && focusMethod != null && (
          <InviteActionScreen
            hop={focusHop}
            method={focusMethod}
            loading={loadingHop === focusHop}
            onBack={goBack}
            onGenerateLink={async (target) => onGenerateLink(target as InviteeHop)}
            onInviteOnchain={async (target, address, ensName) =>
              onInviteOnchain(target as InviteeHop, address, ensName)
            }
            onCopy={onCopy}
            onRevoke={onRevoke}
            onConfirmCreated={onConfirmCreated}
            onDiscardCreated={onDiscardCreated}
            copiedInviteId={copiedInviteId}
            resolveEns={resolveEns}
          />
        )}
      </div>
      <InviteMethodPicker
        open={pickerHop != null}
        anchorEl={pickerAnchor}
        slotId={pickerHop ?? 0}
        title={pickerTitle}
        onSelect={handleSelect}
        onClose={closePicker}
      />
    </div>
  )
}

/** @deprecated Prefer useInviteHopFocus — kept for InviteSlots / ParticipateFlowInviteSlots. */
export {
  useInviteSlotFocus,
  InviteFocusChrome,
  type InviteSlotFocus,
  type InviteFocusChromeProps,
} from './useInviteSlotFocusLegacy'
