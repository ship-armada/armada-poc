// ABOUTME: Coarse "now" timestamp atom (ms since epoch) — ticked once a minute so relative-time labels ("3m ago") refresh without user navigation.
// ABOUTME: useNowTicker() (hooks/) drives the tick exactly once at App root; consumers read with useAtomValue.

import { atom } from 'jotai'

export const nowAtom = atom<number>(Date.now())
