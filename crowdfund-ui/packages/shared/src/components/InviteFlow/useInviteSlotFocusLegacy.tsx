// ABOUTME: State + transitions for Invite method-picker UX (list ↔ action screen + picker).

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import type { InviteMethod } from '../../lib/inviteUx'
import { InviteActionScreen } from './InviteActionScreen'
import { InviteMethodPicker } from './InviteMethodPicker'
import focusStyles from './inviteSlotFocus.module.css'

const TRANSITION_MS = 240

export type InviteFocusView = 'list' | 'action'

export interface InviteSlotFocus {
  view: InviteFocusView
  fading: boolean
  focus: { slotId: number; method: InviteMethod } | null
  pickerSlotId: number | null
  pickerAnchor: HTMLElement | null
  openPicker: (slotId: number, anchor: HTMLElement) => void
  registerInviteButton: (slotId: number, el: HTMLButtonElement | null) => void
  closePicker: () => void
  selectMethod: (method: InviteMethod) => void
  goBack: () => void
  frameClassName: string
  restoreFocusToInvite: () => void
}

export function useInviteSlotFocus(): InviteSlotFocus {
  const [renderView, setRenderView] = useState<InviteFocusView>('list')
  const [fading, setFading] = useState(false)
  const [focus, setFocus] = useState<{ slotId: number; method: InviteMethod } | null>(null)
  const [pickerSlotId, setPickerSlotId] = useState<number | null>(null)
  const [pickerAnchor, setPickerAnchor] = useState<HTMLElement | null>(null)
  const inviteBtnRefs = useRef<Map<number, HTMLElement>>(new Map())
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

  const openPicker = useCallback((slotId: number, anchor: HTMLElement) => {
    inviteBtnRefs.current.set(slotId, anchor)
    setPickerSlotId(slotId)
    setPickerAnchor(anchor)
  }, [])

  const registerInviteButton = useCallback((slotId: number, el: HTMLButtonElement | null) => {
    if (el) inviteBtnRefs.current.set(slotId, el)
    else inviteBtnRefs.current.delete(slotId)
  }, [])

  const closePicker = useCallback(() => {
    setPickerSlotId(null)
    setPickerAnchor(null)
  }, [])

  const selectMethod = useCallback(
    (method: InviteMethod) => {
      if (pickerSlotId == null) return
      const slotId = pickerSlotId
      setFocus({ slotId, method })
      closePicker()
      transitionTo('action')
    },
    [pickerSlotId, closePicker, transitionTo],
  )

  const restoreFocusToInvite = useCallback(() => {
    const id = focus?.slotId
    if (id == null) return
    requestAnimationFrame(() => {
      inviteBtnRefs.current.get(id)?.focus()
    })
  }, [focus?.slotId])

  const goBack = useCallback(() => {
    clearTimer()
    setFading(true)
    timerRef.current = setTimeout(() => {
      setRenderView('list')
      setFading(false)
      const id = focus?.slotId
      setFocus(null)
      timerRef.current = null
      if (id != null) {
        requestAnimationFrame(() => {
          inviteBtnRefs.current.get(id)?.focus()
        })
      }
    }, TRANSITION_MS)
  }, [focus?.slotId])

  const frameClassName = [
    focusStyles.frame,
    fading ? focusStyles.frameExit : focusStyles.frameEnter,
  ].join(' ')

  return {
    view: renderView,
    fading,
    focus,
    pickerSlotId,
    pickerAnchor,
    openPicker,
    registerInviteButton,
    closePicker,
    selectMethod,
    goBack,
    frameClassName,
    restoreFocusToInvite,
  }
}

export interface InviteFocusChromeProps {
  focusApi: InviteSlotFocus
  loadingSlotId?: number | null
  onGenerateLink: (
    slotId: number,
  ) => Promise<void | { id: number; link: string; expiresAt: Date; nonce?: number }>
  onInviteOnchain: (slotId: number, address: string, ensName?: string) => Promise<void>
  resolveEns?: (
    input: string,
  ) => Promise<import('./screens/SlotCard').SlotCardEnsResult>
  list: ReactNode
}

/** Renders list or action frame + method picker portal. */
export function InviteFocusChrome({
  focusApi,
  loadingSlotId = null,
  onGenerateLink,
  onInviteOnchain,
  resolveEns,
  list,
}: InviteFocusChromeProps) {
  const {
    view,
    fading,
    focus,
    pickerSlotId,
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

  return (
    <div
      ref={shellRef}
      className={focusStyles.shell}
      style={lockedMinHeight != null ? { minHeight: lockedMinHeight } : undefined}
    >
      <div key={view} className={frameClassName}>
        {view === 'list' && list}
        {view === 'action' && focus && (
          <InviteActionScreen
            slotId={focus.slotId}
            method={focus.method}
            loading={loadingSlotId === focus.slotId}
            onBack={goBack}
            onGenerateLink={onGenerateLink}
            onInviteOnchain={onInviteOnchain}
            resolveEns={resolveEns}
          />
        )}
      </div>
      <InviteMethodPicker
        open={pickerSlotId != null}
        anchorEl={pickerAnchor}
        slotId={pickerSlotId ?? 0}
        onSelect={handleSelect}
        onClose={closePicker}
      />
    </div>
  )
}
