// ABOUTME: Demo invite share URLs — local /invite landing until a production domain exists.
// ABOUTME: Avoids hardcoding armada.wtf; works without Vite import.meta (shared is source-exported).

/**
 * Absolute URL to the crowdfund invite landing with invite + hop query params.
 * Uses the current origin when available (browser); falls back to a relative path.
 */
export function createDemoInviteLink(hopSegment: string): string {
  const invite = Math.random().toString(36).slice(2, 10)
  return demoInviteLink(invite, hopSegment)
}

/** Build a deterministic demo invite URL (static showcase / fixture data). */
export function demoInviteLink(invite: string, hopSegment: string): string {
  if (typeof window !== 'undefined' && window.location?.origin) {
    const url = new URL('/invite', window.location.origin)
    url.searchParams.set('invite', invite)
    url.searchParams.set('hop', hopSegment)
    return url.href
  }
  const params = new URLSearchParams({ invite, hop: hopSegment })
  return `/invite?${params.toString()}`
}
