// ABOUTME: Tests for AppErrorBoundary (P0-6) — a render error surfaces the recoverable fallback card + a telemetry report instead of a white screen.
// ABOUTME: Healthy children render untouched.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { AppErrorBoundary } from './AppErrorBoundary'

const trackErrorMock = vi.hoisted(() => vi.fn())
vi.mock('@/lib/telemetry', () => ({ trackError: trackErrorMock }))

function Boom(): never {
  throw new Error('kaboom')
}

describe('AppErrorBoundary', () => {
  beforeEach(() => trackErrorMock.mockReset())

  it('renders the fallback card and reports to telemetry when a child throws', () => {
    // React logs the caught render error to console.error — silence it so test output stays pristine.
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    render(
      <AppErrorBoundary>
        <Boom />
      </AppErrorBoundary>,
    )
    expect(screen.getByText('Something went wrong')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /reload/i })).toBeInTheDocument()
    expect(trackErrorMock).toHaveBeenCalledWith('app', expect.any(Error))
    consoleSpy.mockRestore()
  })

  it('renders children untouched when nothing throws', () => {
    render(
      <AppErrorBoundary>
        <div>healthy content</div>
      </AppErrorBoundary>,
    )
    expect(screen.getByText('healthy content')).toBeInTheDocument()
    expect(trackErrorMock).not.toHaveBeenCalled()
  })
})
