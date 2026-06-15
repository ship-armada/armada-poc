// ABOUTME: Tests NodeSphere's graceful degradation when WebGL is unavailable.
// ABOUTME: jsdom provides no WebGL context, so THREE.WebGLRenderer throws — the component must fall back to a static background rather than crash the app.
// @vitest-environment jsdom

import { render } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import { NodeSphere } from './NodeSphere'

/** True when any element in the tree carries a `background-image: url(...)`.
 *  Structure-robust so the fallback's layered markup can change without
 *  breaking the assertion. */
function hasBackgroundImage(container: HTMLElement): boolean {
  return Array.from(container.querySelectorAll<HTMLElement>('*')).some((el) =>
    el.style.backgroundImage.includes('url('),
  )
}

describe('NodeSphere WebGL fallback', () => {
  it('renders a static background (not a thrown error) when WebGL is unavailable', () => {
    // Force `getContext` to return null (cleanly, without jsdom's "Not
    // implemented" warning) so the WebGLRenderer constructor throws — the same
    // failure a WebGL-disabled / blocklisted-GPU browser hits. three.js logs
    // that to console.error before throwing; capture it so the expected noise
    // stays out of the test output and we can assert the failure path was hit.
    const getContextSpy = vi
      .spyOn(HTMLCanvasElement.prototype, 'getContext')
      .mockReturnValue(null)
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    const { container } = render(<NodeSphere />)

    // The WebGL init error was raised (and caught) — confirms we hit the
    // fallback path rather than the live-graph path.
    expect(errorSpy).toHaveBeenCalled()
    errorSpy.mockRestore()
    getContextSpy.mockRestore()

    // Fallback renders a background-image layer; the live graph would instead
    // mount a host div with an appended <canvas>.
    expect(hasBackgroundImage(container)).toBe(true)
    expect(container.querySelector('canvas')).toBeNull()
  })

  it('honors the ?nowebgl override and never attempts WebGL', () => {
    const originalUrl = window.location.pathname + window.location.search
    window.history.replaceState({}, '', '/?nowebgl')
    const getContextSpy = vi.spyOn(HTMLCanvasElement.prototype, 'getContext')
    try {
      const { container } = render(<NodeSphere />)
      // The override seeds the fallback state, so the effect short-circuits
      // before constructing a WebGLRenderer — getContext is never called.
      expect(getContextSpy).not.toHaveBeenCalled()
      expect(hasBackgroundImage(container)).toBe(true)
    } finally {
      getContextSpy.mockRestore()
      window.history.replaceState({}, '', originalUrl)
    }
  })
})
