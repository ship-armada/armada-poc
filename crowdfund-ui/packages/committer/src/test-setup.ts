// ABOUTME: Test setup for vitest — configures jsdom, testing-library matchers, and fake IndexedDB.
// ABOUTME: Imported automatically via vitest setupFiles config.

import '@testing-library/jest-dom'
import 'fake-indexeddb/auto'

// jsdom does not implement window.matchMedia. Components that branch on
// viewport (Step0Invite's hover-gate, SlotCard's mobile revoke popover) call
// it during render, so provide a minimal always-desktop stub. Tests that need
// a specific viewport can override window.matchMedia per-case.
if (typeof window !== 'undefined' && typeof window.matchMedia !== 'function') {
  window.matchMedia = (query: string): MediaQueryList => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  })
}
