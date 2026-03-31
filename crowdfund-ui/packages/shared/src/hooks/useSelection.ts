// ABOUTME: Shared selection state for cross-view coordination.
// ABOUTME: Synchronizes selected address and search query between tree and table views.

import { atom, useAtom } from 'jotai'

/** Currently selected address (clicked node or table row) */
export const selectedAddressAtom = atom<string | null>(null)

/** Search query text for filtering both tree and table */
export const searchQueryAtom = atom<string>('')

/** Currently hovered address (tree node hover → table row highlight) */
export const hoveredAddressAtom = atom<string | null>(null)

export interface UseSelectionResult {
  selectedAddress: string | null
  selectAddress: (addr: string | null) => void
  searchQuery: string
  setSearchQuery: (q: string) => void
  hoveredAddress: string | null
  setHoveredAddress: (addr: string | null) => void
}

/** Hook for shared selection state between tree and table views */
export function useSelection(): UseSelectionResult {
  const [selectedAddress, setSelectedAddress] = useAtom(selectedAddressAtom)
  const [searchQuery, setSearchQuery] = useAtom(searchQueryAtom)
  const [hoveredAddress, setHoveredAddress] = useAtom(hoveredAddressAtom)

  return {
    selectedAddress,
    selectAddress: setSelectedAddress,
    searchQuery,
    setSearchQuery,
    hoveredAddress,
    setHoveredAddress,
  }
}
