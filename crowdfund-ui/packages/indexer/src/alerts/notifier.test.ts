// ABOUTME: Unit tests for the Discord webhook notifier.
// ABOUTME: Stubs fetch to verify routing per severity and payload shape.

import { describe, expect, it } from 'vitest'
import { createDiscordNotifier, NoWebhookConfiguredError } from './notifier.js'
import type { AlertEvent } from './types.js'

function buildEvent(severity: AlertEvent['severity']): AlertEvent {
  return {
    id: 'A11',
    severity,
    dedupeKey: 'A11',
    title: 'Cancelled',
    body: 'Crowdfund cancelled by SC',
    runbook: 'OPERATIONS.md §7',
    context: { something: 'detail' },
  }
}

describe('Discord notifier', () => {
  it('routes severity to its webhook and posts JSON', async () => {
    const calls: Array<{ url: string; body: string }> = []
    const fetchImpl = async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), body: String(init?.body) })
      return new Response(null, { status: 204 })
    }
    const notifier = createDiscordNotifier({
      webhooks: { P0: 'https://discord.test/p0', P3: 'https://discord.test/p3' },
      mentions: { P0: '<@&123>' },
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })

    await notifier.send(buildEvent('P0'))
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe('https://discord.test/p0')
    const payload = JSON.parse(calls[0].body) as { content: string }
    expect(payload.content).toContain('<@&123>')
    expect(payload.content).toContain('[P0 A11] Cancelled')
    expect(payload.content).toContain('OPERATIONS.md §7')
  })

  it('passes an abort signal so a hung webhook cannot stall forever', async () => {
    let seenSignal: AbortSignal | null | undefined
    const fetchImpl = async (_url: string | URL | Request, init?: RequestInit) => {
      seenSignal = init?.signal
      return new Response(null, { status: 204 })
    }
    const notifier = createDiscordNotifier({
      webhooks: { P0: 'https://discord.test/p0' },
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })
    await notifier.send(buildEvent('P0'))
    expect(seenSignal).toBeInstanceOf(AbortSignal)
  })

  it('throws NoWebhookConfiguredError (does not silently drop) when severity has no webhook', async () => {
    let called = false
    const notifier = createDiscordNotifier({
      webhooks: { P0: 'https://discord.test/p0' },
      fetchImpl: (async () => { called = true; return new Response() }) as unknown as typeof fetch,
    })
    await expect(notifier.send(buildEvent('P2'))).rejects.toBeInstanceOf(NoWebhookConfiguredError)
    expect(called).toBe(false)
  })

  it('throws when Discord returns non-2xx', async () => {
    const notifier = createDiscordNotifier({
      webhooks: { P0: 'https://discord.test/p0' },
      fetchImpl: (async () => new Response('rate limited', { status: 429 })) as unknown as typeof fetch,
    })
    await expect(notifier.send(buildEvent('P0'))).rejects.toThrow(/429/)
  })
})
