// ABOUTME: Tests for ThemeToggle — renders, reflects the applied theme via aria-label, and flips the theme on click.
// ABOUTME: Drives the real `useTheme`/`setTheme` path against the jsdom `data-theme` attribute.

import { afterEach, beforeEach, describe, it, expect } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { ThemeToggle } from './ThemeToggle'

describe('<ThemeToggle>', () => {
  beforeEach(() => {
    document.documentElement.setAttribute('data-theme', 'light')
    localStorage.clear()
  })

  afterEach(() => {
    document.documentElement.removeAttribute('data-theme')
  })

  it('renders a button', () => {
    render(<ThemeToggle />)
    expect(screen.getByRole('button')).toBeInTheDocument()
  })

  it('reflects the current theme in its aria-label (light → offers dark)', () => {
    render(<ThemeToggle />)
    expect(screen.getByRole('button')).toHaveAttribute('aria-label', 'Switch to dark theme')
  })

  it('toggles the applied theme on click', () => {
    render(<ThemeToggle />)
    const button = screen.getByRole('button')

    fireEvent.click(button)
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark')
    expect(localStorage.getItem('armada-theme')).toBe('dark')
    expect(button).toHaveAttribute('aria-label', 'Switch to light theme')

    fireEvent.click(button)
    expect(document.documentElement.getAttribute('data-theme')).toBe('light')
    expect(button).toHaveAttribute('aria-label', 'Switch to dark theme')
  })
})
