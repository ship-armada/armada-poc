// ABOUTME: Tests useOpenActionModal — connect prompt when disconnected, deferred open after connect.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { Provider, createStore } from 'jotai'
import { useOpenActionModal } from './useOpenActionModal'
import { openModalAtom } from '@/state/ui'

const openConnectModal = vi.fn()

let isConnected = false

vi.mock('wagmi', () => ({
  useAccount: () => ({ isConnected }),
}))

vi.mock('@rainbow-me/rainbowkit', () => ({
  useConnectModal: () => ({ openConnectModal }),
}))

describe('useOpenActionModal', () => {
  beforeEach(() => {
    isConnected = false
    openConnectModal.mockClear()
  })

  it('calls openConnectModal and does not open the flow when disconnected', () => {
    const store = createStore()
    const { result } = renderHook(() => useOpenActionModal(), {
      wrapper: ({ children }) => <Provider store={store}>{children}</Provider>,
    })

    act(() => {
      result.current('shield')
    })

    expect(openConnectModal).toHaveBeenCalled()
    expect(store.get(openModalAtom)).toBeNull()
  })

  it('opens the pending flow after the wallet connects', () => {
    const store = createStore()
    const { result, rerender } = renderHook(() => useOpenActionModal(), {
      wrapper: ({ children }) => <Provider store={store}>{children}</Provider>,
    })

    act(() => {
      result.current('unshield')
    })
    expect(store.get(openModalAtom)).toBeNull()

    isConnected = true
    rerender()

    expect(store.get(openModalAtom)).toBe('unshield')
  })

  it('opens the flow immediately when already connected', () => {
    isConnected = true
    const store = createStore()
    const { result } = renderHook(() => useOpenActionModal(), {
      wrapper: ({ children }) => <Provider store={store}>{children}</Provider>,
    })

    act(() => {
      result.current('payment')
    })

    expect(openConnectModal).not.toHaveBeenCalled()
    expect(store.get(openModalAtom)).toBe('payment')
  })
})
