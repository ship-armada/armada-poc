// ABOUTME: Hook that closes the topmost registered handler on Escape (supports nested dialogs).
// ABOUTME: Ported from the armada-app design mockup.
import { useEffect, useRef } from 'react'

const escapeHandlers: Array<() => void> = []
let listenerAttached = false

function onDocumentKeyDown(event: KeyboardEvent) {
  if (event.key !== 'Escape') return
  const top = escapeHandlers[escapeHandlers.length - 1]
  if (!top) return
  event.preventDefault()
  top()
}

function attachListener() {
  if (listenerAttached) return
  listenerAttached = true
  document.addEventListener('keydown', onDocumentKeyDown)
}

function detachListenerIfEmpty() {
  if (escapeHandlers.length === 0 && listenerAttached) {
    document.removeEventListener('keydown', onDocumentKeyDown)
    listenerAttached = false
  }
}

/** Escape closes the topmost registered handler (supports nested dialogs). */
export function useEscapeKey(onClose: () => void, enabled = true) {
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose

  useEffect(() => {
    if (!enabled) return

    const handler = () => onCloseRef.current()
    escapeHandlers.push(handler)
    attachListener()

    return () => {
      const index = escapeHandlers.indexOf(handler)
      if (index >= 0) escapeHandlers.splice(index, 1)
      detachListenerIfEmpty()
    }
  }, [enabled])
}
