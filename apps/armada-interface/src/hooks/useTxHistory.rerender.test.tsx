// ABOUTME: Render-count regression for P1-19 — the App-root useTxHistory hydrator must NOT re-render on tx-list writes, while a list-displaying consumer still updates live.
// ABOUTME: Guards against re-introducing a txListAtom subscription in the hydrator (which re-rendered the whole app shell ~10x per proof).

import { describe, it, expect } from 'vitest'
import { render, act } from '@testing-library/react'
import { Provider, createStore, useAtomValue } from 'jotai'
import { txListAtom, activeTxListAtom, upsertTxAtom } from '@/state/tx'
import { activeRailgunWalletIdAtom } from '@/state/wallet'
import { useTxHistory } from './useTxHistory'
import type { TxRecord } from '@/lib/tx/types'

function record(id: string): TxRecord<'shield'> {
  return {
    id,
    kind: 'shield',
    executionState: 'active',
    stage: 'submit-relayer',
    stagesCompleted: ['build-proof'],
    updatedSeq: 1,
    createdAt: 0,
    updatedAt: 0,
    meta: { amount: 1n, feeCacheId: '', fromChainId: 31337 },
    artifacts: {},
    walletContext: { evmAddress: '0x', railgunWalletId: 'rg-1', sourceChainId: 31337 },
  } as TxRecord<'shield'>
}

describe('useTxHistory re-render isolation (P1-19)', () => {
  it('does not re-render the hydrator host on a tx write, but a list consumer does', () => {
    const store = createStore()
    store.set(activeRailgunWalletIdAtom, 'rg-1')

    let hydratorRenders = 0
    function Hydrator() {
      useTxHistory()
      hydratorRenders++
      return null
    }

    let consumerRenders = 0
    function Consumer() {
      useAtomValue(activeTxListAtom)
      consumerRenders++
      return null
    }

    render(
      <Provider store={store}>
        <Hydrator />
        <Consumer />
      </Provider>,
    )

    const hydratorAtMount = hydratorRenders
    const consumerAtMount = consumerRenders

    act(() => {
      store.set(upsertTxAtom, record('tx-1'))
    })

    // The hydrator doesn't subscribe to txListAtom → no re-render on the write.
    expect(hydratorRenders).toBe(hydratorAtMount)
    // The list consumer DOES subscribe (activeTxListAtom) → it re-renders.
    expect(consumerRenders).toBeGreaterThan(consumerAtMount)
  })
})
