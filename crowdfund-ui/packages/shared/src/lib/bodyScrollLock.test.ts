// ABOUTME: Tests for the shared, counted page scroll lock used by modals and sheets.
// ABOUTME: Stacked overlays must restore the original page styles only when the last one unlocks.
// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { lockBodyScroll } from './bodyScrollLock'

const html = document.documentElement
const body = document.body

beforeEach(() => {
  vi.spyOn(window, 'scrollTo').mockImplementation(() => {})
  html.removeAttribute('style')
  body.removeAttribute('style')
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('lockBodyScroll', () => {
  it('pins the page while locked and restores it on release', () => {
    body.style.overflow = 'auto'
    const release = lockBodyScroll()
    expect(body.style.position).toBe('fixed')
    expect(html.style.overflow).toBe('hidden')

    release()
    expect(body.style.position).toBe('')
    expect(body.style.overflow).toBe('auto')
    expect(html.style.overflow).toBe('')
    expect(window.scrollTo).toHaveBeenCalledOnce()
  })

  it('stays locked until the last of several stacked locks is released', () => {
    // A modal locks, then a sheet opens over it. The modal closes first.
    const releaseModal = lockBodyScroll()
    const releaseSheet = lockBodyScroll()

    releaseModal()
    expect(body.style.position).toBe('fixed')

    releaseSheet()
    expect(body.style.position).toBe('')
    expect(html.style.overflow).toBe('')
  })

  it('ignores a second release of the same lock', () => {
    const releaseA = lockBodyScroll()
    const releaseB = lockBodyScroll()
    releaseA()
    releaseA()
    expect(body.style.position).toBe('fixed')
    releaseB()
    expect(body.style.position).toBe('')
  })
})
