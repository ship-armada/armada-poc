import { atom } from 'jotai'
import type { TrackedTransaction } from '@/types/tx'

export interface TxState {
  activeTransaction?: TrackedTransaction
  history: TrackedTransaction[]
}

export const txAtom = atom<TxState>({
  activeTransaction: undefined,
  history: [],
})

export const txFilterAtom = atom<'all' | 'pending' | 'completed'>('all')
