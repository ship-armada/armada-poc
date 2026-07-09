// ABOUTME: Conservative mobile-browser detection used to scope mobile-only wallet workarounds.
// ABOUTME: Only true for actual mobile user agents, so desktop never enters those paths.

export function isMobileBrowser(): boolean {
  if (typeof navigator === 'undefined') return false
  return /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent)
}
