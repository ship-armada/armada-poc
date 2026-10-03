// ABOUTME: Tests the pre-paint theme script in index.html — the committer is dark-only.
// ABOUTME: A light preference saved by an older build must not apply, and is cleared.
// @vitest-environment jsdom

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it, expect, beforeEach } from 'vitest'

const html = readFileSync(join(__dirname, '..', 'index.html'), 'utf8')
const themeScript = html.match(/<script>([\s\S]*?)<\/script>/)?.[1] ?? ''

function runThemeScript() {
  new Function(themeScript)()
}

beforeEach(() => {
  document.documentElement.removeAttribute('data-theme')
  localStorage.clear()
})

describe('index.html theme script', () => {
  it('renders dark with no saved preference', () => {
    runThemeScript()
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark')
  })

  it('ignores and clears a light preference saved by an older build', () => {
    localStorage.setItem('armada-theme', 'light')
    runThemeScript()
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark')
    expect(localStorage.getItem('armada-theme')).toBeNull()
  })
})
