// ABOUTME: Vitest setup — registers @testing-library/jest-dom matchers and the fake IndexedDB shim.
// ABOUTME: Loaded automatically via vitest.config.ts → test.setupFiles. Also polyfills jsdom gaps (matchMedia, ResizeObserver).

import '@testing-library/jest-dom'
import 'fake-indexeddb/auto'

// jsdom implements neither matchMedia nor ResizeObserver; motion-aware components (BalanceCard,
// BalanceScrambleValue, RecentActivityList) read them. Provide inert stubs so they render under test.
if (typeof window !== 'undefined' && typeof window.matchMedia !== 'function') {
  window.matchMedia = (query: string) =>
    ({
      // Report reduced motion under test so motion helpers (useFlowExit exit delay, odometer rolls,
      // step-switch exits) resolve synchronously instead of scheduling real timers — deterministic
      // renders, no waiting on animation windows. Other queries stay non-matching.
      matches: query.includes('prefers-reduced-motion'),
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }) as MediaQueryList
}

if (typeof globalThis.ResizeObserver === 'undefined') {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver
}
