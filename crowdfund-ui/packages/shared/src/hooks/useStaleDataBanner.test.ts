// ABOUTME: Tests for useStaleDataBanner — verifies state transitions against
// ABOUTME: the react-query cache: initial load, first success, refetch error, offline pause.

// @vitest-environment jsdom

import { describe, it, expect } from 'vitest'
import { createElement, type ReactNode } from 'react'
import { act, renderHook } from '@testing-library/react'
import {
  QueryClient,
  QueryClientProvider,
  onlineManager,
} from '@tanstack/react-query'
import { useStaleDataBanner } from './useStaleDataBanner.js'

function makeSetup() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  const wrapper = ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client }, children)
  return { client, wrapper }
}

describe('useStaleDataBanner', () => {
  it('is not stale when no queries have run', () => {
    const { wrapper } = makeSetup()
    const { result } = renderHook(() => useStaleDataBanner(), { wrapper })
    expect(result.current.isStale).toBe(false)
    expect(result.current.reason).toBeNull()
  })

  it('is not stale while the initial fetch is in flight', async () => {
    const { client, wrapper } = makeSetup()

    // Seed a pending query that has no data yet.
    void client.fetchQuery({
      queryKey: ['demo'],
      queryFn: () => new Promise<string>(() => {}),
    })

    const { result } = renderHook(() => useStaleDataBanner(), { wrapper })
    expect(result.current.isStale).toBe(false)
  })

  it('is not stale after the first successful fetch', async () => {
    const { client, wrapper } = makeSetup()

    await client.fetchQuery({
      queryKey: ['demo'],
      queryFn: async () => 'ok',
    })

    const { result } = renderHook(() => useStaleDataBanner(), { wrapper })
    expect(result.current.isStale).toBe(false)
  })

  it('reports error reason when a refetch fails after a prior success', async () => {
    const { client, wrapper } = makeSetup()
    const queryKey = ['demo']

    // First fetch succeeds — populates `data`.
    let callCount = 0
    const queryFn = async () => {
      callCount += 1
      if (callCount === 1) return 'first'
      throw new Error('RPC down')
    }
    await client.fetchQuery({ queryKey, queryFn })

    const { result, rerender } = renderHook(() => useStaleDataBanner(), {
      wrapper,
    })
    expect(result.current.isStale).toBe(false)

    // Force a refetch — it will fail.
    await act(async () => {
      await client
        .refetchQueries({ queryKey, exact: true })
        .catch(() => undefined)
    })
    rerender()

    expect(result.current.isStale).toBe(true)
    expect(result.current.reason).toBe('error')
  })

  it('reports paused reason when the network goes offline with data present', async () => {
    const { client, wrapper } = makeSetup()
    const queryKey = ['demo']

    await client.fetchQuery({
      queryKey,
      queryFn: async () => 'ok',
    })

    const { result, rerender } = renderHook(() => useStaleDataBanner(), {
      wrapper,
    })
    expect(result.current.isStale).toBe(false)

    // Switch react-query's onlineManager offline + kick a refetch so the
    // fetchStatus transitions to 'paused'.
    try {
      await act(async () => {
        onlineManager.setOnline(false)
        void client.refetchQueries({ queryKey, exact: true })
        await new Promise((r) => setTimeout(r, 0))
      })
      rerender()

      expect(result.current.isStale).toBe(true)
      expect(result.current.reason).toBe('paused')
    } finally {
      onlineManager.setOnline(true)
    }
  })

  it('prefers paused over error when both states coexist', async () => {
    const { client, wrapper } = makeSetup()

    // Failing query with prior data.
    let calls = 0
    await client.fetchQuery({
      queryKey: ['erroring'],
      queryFn: async () => {
        calls += 1
        return 'first'
      },
    })
    await act(async () => {
      await client
        .refetchQueries({
          queryKey: ['erroring'],
          exact: true,
        })
        .catch(() => undefined)
      // Replace the queryFn with an always-throwing one to simulate a
      // failing refetch cycle.
      client.setQueryDefaults(['erroring'], {
        queryFn: async () => {
          throw new Error('boom')
        },
      })
      await client
        .refetchQueries({ queryKey: ['erroring'], exact: true })
        .catch(() => undefined)
    })
    void calls // keep lint happy

    // A second query with prior data whose refetch is paused.
    await client.fetchQuery({
      queryKey: ['paused'],
      queryFn: async () => 'ok',
    })

    const { result, rerender } = renderHook(() => useStaleDataBanner(), {
      wrapper,
    })

    try {
      await act(async () => {
        onlineManager.setOnline(false)
        void client.refetchQueries({ queryKey: ['paused'], exact: true })
        await new Promise((r) => setTimeout(r, 0))
      })
      rerender()

      expect(result.current.isStale).toBe(true)
      expect(result.current.reason).toBe('paused')
    } finally {
      onlineManager.setOnline(true)
    }
  })
})
