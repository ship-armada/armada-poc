// ABOUTME: UI-only atoms — which modal is open, current page intent. No business data.
// ABOUTME: Page-level modal controllers live here so any component can open a flow.

import { atom } from 'jotai'

export type ModalKind =
  | null
  | 'shield'
  | 'unshield'
  | 'yield-deposit'
  | 'yield-withdraw'
  | 'payment'
  | 'wallet-unlock'
  | 'wallet-reset'

/** Dashboard / action flows that require a connected EVM wallet before opening. */
export type ActionModalKind = Exclude<
  ModalKind,
  null | 'wallet-unlock' | 'wallet-reset'
>

export const openModalAtom = atom<ModalKind>(null)
