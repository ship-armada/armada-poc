import { atom } from 'jotai'

export type TxAnimationPhase = 
  | 'inProgress'
  | 'exitingInProgress'
  | 'enteringHistory'
  | 'inHistory'

export interface TxAnimationState {
  phase: TxAnimationPhase
  phaseStartedAt: number // Timestamp when phase started
}

// Map of transaction ID -> animation state
type TxAnimationMap = Map<string, TxAnimationState>

export const txAnimationAtom = atom<TxAnimationMap>(new Map())

