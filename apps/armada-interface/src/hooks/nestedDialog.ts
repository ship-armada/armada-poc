// ABOUTME: Global nested-dialog counter store so parent modals pause their focus trap while a child dialog is open.
// ABOUTME: Ported from the armada-app design mockup.
import { useSyncExternalStore } from 'react'

let nestedDialogCount = 0
const listeners = new Set<() => void>()

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function getSnapshot() {
  return nestedDialogCount
}

function notify() {
  listeners.forEach((listener) => listener())
}

/** Register a nested dialog (e.g. MockMetaMask) so parent modals pause focus trap. */
export function registerNestedDialog() {
  nestedDialogCount += 1
  notify()
  return () => {
    nestedDialogCount = Math.max(0, nestedDialogCount - 1)
    notify()
  }
}

export function useNestedDialogCount() {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}
