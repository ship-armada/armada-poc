// ABOUTME: Notifier abstraction — receives an AlertEvent and posts it to a delivery channel.
// ABOUTME: Discord webhook implementation; test-time fake captures sent events in-memory.

import type { AlertEvent, Severity } from './types.js'

export interface Notifier {
  send(event: AlertEvent): Promise<void>
}

export interface DiscordWebhookConfig {
  /**
   * Severity → webhook URL. P0 and P1 should point at a paged channel; P2/P3
   * a silent log channel. Unmapped severities are dropped (with a console warn).
   */
  webhooks: Partial<Record<Severity, string>>
  /** Optional override for fetch (test seam). */
  fetchImpl?: typeof fetch
  /** Optional severity → role mention. */
  mentions?: Partial<Record<Severity, string>>
}

function formatPayload(event: AlertEvent, mention: string | undefined): unknown {
  const lines = [
    `**[${event.severity} ${event.id}] ${event.title}**`,
    event.body,
    `Runbook: ${event.runbook}`,
  ]
  if (event.context && Object.keys(event.context).length > 0) {
    lines.push('```json\n' + JSON.stringify(event.context, null, 2) + '\n```')
  }
  const content = mention ? `${mention} ${lines.join('\n')}` : lines.join('\n')
  return { content, allowed_mentions: { parse: ['roles', 'users'] } }
}

export function createDiscordNotifier(config: DiscordWebhookConfig): Notifier {
  const doFetch: typeof fetch = config.fetchImpl ?? fetch
  return {
    async send(event) {
      const url = config.webhooks[event.severity]
      if (!url) {
        process.stderr.write(`[alerts] no webhook configured for severity ${event.severity}; skipping ${event.id}\n`)
        return
      }
      const mention = config.mentions?.[event.severity]
      const res = await doFetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(formatPayload(event, mention)),
        // Bound the request so one hung webhook cannot stall the whole evaluation tick.
        signal: AbortSignal.timeout(10_000),
      })
      if (!res.ok) {
        const text = await res.text().catch(() => '')
        throw new Error(`Discord webhook ${event.severity} returned ${res.status}: ${text}`)
      }
    },
  }
}

export interface InMemoryNotifierLog {
  events: AlertEvent[]
}

export function createInMemoryNotifier(): Notifier & InMemoryNotifierLog {
  const events: AlertEvent[] = []
  return {
    events,
    async send(event) {
      events.push(event)
    },
  }
}
