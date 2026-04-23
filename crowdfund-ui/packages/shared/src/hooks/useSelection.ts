// ABOUTME: Shared selection state for cross-view coordination.
// ABOUTME: Synchronizes selected address and search query between tree and table views.

import { atom, useAtom } from 'jotai'
import { useCallback } from 'react'

/** Currently selected address (clicked node or table row) */
export const selectedAddressAtom = atom<string | null>(null)

/** Search query text for filtering both tree and table */
export const searchQueryAtom = atom<string>('')

/** Currently hovered address (tree node hover → table row highlight) */
export const hoveredAddressAtom = atom<string | null>(null)

/**
 * Explicit request to bring an address into view (e.g. scroll the table row).
 * Distinct from selection so that clicking a tree node selects without yanking
 * the table scroll position — only opt-in actions like the "View in table"
 * button should trigger this. The tick ensures repeated requests for the same
 * address still re-fire the effect.
 */
export const focusRequestAtom = atom<{ address: string; tick: number } | null>(null)

export interface UseSelectionResult {
  selectedAddress: string | null
  selectAddress: (addr: string | null) => void
  searchQuery: string
  setSearchQuery: (q: string) => void
  hoveredAddress: string | null
  setHoveredAddress: (addr: string | null) => void
  focusRequest: { address: string; tick: number } | null
  requestFocus: (addr: string) => void
}

/** Hook for shared selection state between tree and table views */
export function useSelection(): UseSelectionResult {
  const [selectedAddress, setSelectedAddress] = useAtom(selectedAddressAtom)
  const [searchQuery, setSearchQuery] = useAtom(searchQueryAtom)
  const [hoveredAddress, setHoveredAddress] = useAtom(hoveredAddressAtom)
  const [focusRequest, setFocusRequest] = useAtom(focusRequestAtom)

  const requestFocus = useCallback(
    (addr: string) => {
      setFocusRequest({ address: addr, tick: Date.now() })
    },
    [setFocusRequest],
  )

  return {
    selectedAddress,
    selectAddress: setSelectedAddress,
    searchQuery,
    setSearchQuery,
    hoveredAddress,
    setHoveredAddress,
    focusRequest,
    requestFocus,
  }
}
