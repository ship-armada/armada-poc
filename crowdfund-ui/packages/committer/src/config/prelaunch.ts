// ABOUTME: Pre-launch mode — publishes the committer as a countdown before the crowdfund contracts exist.
// ABOUTME: Parses VITE_PRELAUNCH_OPENS_AT (ISO 8601 UTC) and decides when open tabs reload to the live app.

/** ISO 8601 UTC with whole seconds and a trailing Z — the same format the
 *  deploy's CROWDFUND_OPEN_TIME takes, so one value is pasted into both. An
 *  explicit Z is required: without it, a browser parses the time as local. */
const ISO_UTC_SECONDS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/

/** How often a pre-launch page past its opening reloads to pick up the live deploy. */
export const PRELAUNCH_RELOAD_CHECK_MS = 60_000

/** Unix seconds for a well-formed value, else null. Mirrors the deploy's
 *  resolveCrowdfundOpenTimestamp: the round-trip rejects calendar overflow
 *  (e.g. month 13, Feb 30) that Date.parse would otherwise normalize. */
function toUnixSeconds(raw: string): number | null {
  const value = raw.trim()
  if (!ISO_UTC_SECONDS.test(value)) return null
  const ms = Date.parse(value)
  if (Number.isNaN(ms) || new Date(ms).toISOString() !== value.replace('Z', '.000Z')) return null
  return ms / 1000
}

export function isValidPrelaunchOpensAt(raw: string): boolean {
  return toUnixSeconds(raw) !== null
}

/**
 * The announced commit-window opening (unix seconds) when pre-launch mode is
 * on, or null for the normal app. A malformed value also returns null —
 * validateEnv reports it and refuses to boot, so it never renders as a time.
 */
export function parsePrelaunchOpensAt(raw: string | undefined): number | null {
  if (raw === undefined || raw.trim() === '') return null
  return toUnixSeconds(raw)
}

/** Pre-launch opening from this build's env. */
export function getPrelaunchOpensAt(): number | null {
  return parsePrelaunchOpensAt(import.meta.env.VITE_PRELAUNCH_OPENS_AT)
}

/**
 * True once the announced opening has passed. The pre-launch build has no
 * chain to poll, so a page left open across the opening reloads to fetch
 * whatever is deployed now — the live committer, once the site is switched.
 */
export function prelaunchShouldReload(opensAtUnix: number, nowMs: number): boolean {
  return nowMs >= opensAtUnix * 1000
}
