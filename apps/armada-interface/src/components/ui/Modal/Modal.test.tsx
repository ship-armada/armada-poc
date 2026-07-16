// ABOUTME: Tests for Modal — open/closed states, portal mount, ESC and backdrop dismissal, dismissible=false guard, body scroll lock.
// ABOUTME: Focus restoration is verified by checking that the trigger button regains focus on close.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'
import { OVERLAY_EXIT_MS } from '@/constants/overlayMotion'
import { Modal } from './Modal'

describe('<Modal>', () => {
  beforeEach(() => {
    document.body.style.overflow = ''
  })

  it('renders nothing when open=false', () => {
    render(
      <Modal open={false} onClose={() => {}}>
        <div>hidden</div>
      </Modal>,
    )
    expect(screen.queryByText('hidden')).toBeNull()
  })

  it('renders into a portal mounted on document.body', () => {
    render(
      <Modal open onClose={() => {}}>
        <div>shown</div>
      </Modal>,
    )
    const node = screen.getByText('shown')
    expect(node).toBeInTheDocument()
    // Walk up the parent chain; we expect to reach document.body.
    let cur: HTMLElement | null = node
    let foundBody = false
    while (cur) {
      if (cur === document.body) {
        foundBody = true
        break
      }
      cur = cur.parentElement
    }
    expect(foundBody).toBe(true)
  })

  it('exposes role="dialog" and aria-modal', () => {
    render(
      <Modal open onClose={() => {}} title="Hello">
        <div>body</div>
      </Modal>,
    )
    const dialog = screen.getByRole('dialog', { name: 'Hello' })
    expect(dialog).toHaveAttribute('aria-modal', 'true')
  })

  it('calls onClose when ESC is pressed', () => {
    const onClose = vi.fn()
    render(
      <Modal open onClose={onClose}>
        <div>body</div>
      </Modal>,
    )
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('ignores ESC when dismissible=false', () => {
    const onClose = vi.fn()
    render(
      <Modal open onClose={onClose} dismissible={false}>
        <div>body</div>
      </Modal>,
    )
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).not.toHaveBeenCalled()
  })

  it('calls onClose when backdrop is clicked', () => {
    const onClose = vi.fn()
    render(
      <Modal open onClose={onClose} title="t">
        <div>body</div>
      </Modal>,
    )
    const dialog = screen.getByRole('dialog')
    const backdrop = dialog.parentElement?.parentElement as HTMLElement
    fireEvent.mouseDown(backdrop)
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('does not call onClose when clicking inside the dialog', () => {
    const onClose = vi.fn()
    render(
      <Modal open onClose={onClose} title="t">
        <div>body</div>
      </Modal>,
    )
    fireEvent.mouseDown(screen.getByText('body'))
    expect(onClose).not.toHaveBeenCalled()
  })

  it('renders close button when dismissible and title is set', () => {
    render(
      <Modal open onClose={() => {}} title="Hello">
        <div>body</div>
      </Modal>,
    )
    expect(screen.getByRole('button', { name: 'Close' })).toBeInTheDocument()
  })

  it('hides close button when dismissible=false (default)', () => {
    render(
      <Modal open onClose={() => {}} title="Hello" dismissible={false}>
        <div>body</div>
      </Modal>,
    )
    expect(screen.queryByRole('button', { name: 'Close' })).toBeNull()
  })

  it('still shows close button when showCloseButton=true even if not dismissible', () => {
    render(
      <Modal open onClose={() => {}} title="Hello" dismissible={false} showCloseButton>
        <div>body</div>
      </Modal>,
    )
    expect(screen.getByRole('button', { name: 'Close' })).toBeInTheDocument()
  })

  it('sets data-exiting on close and unmounts after exit duration', () => {
    vi.useFakeTimers()
    const { rerender } = render(
      <Modal open onClose={() => {}} title="Hello">
        <div>body</div>
      </Modal>,
    )
    const dialog = screen.getByRole('dialog', { name: 'Hello' })
    expect(dialog).not.toHaveAttribute('data-exiting')

    rerender(
      <Modal open={false} onClose={() => {}} title="Hello">
        <div>body</div>
      </Modal>,
    )
    expect(screen.getByRole('dialog', { name: 'Hello' })).toHaveAttribute('data-exiting', 'true')

    act(() => {
      vi.advanceTimersByTime(OVERLAY_EXIT_MS)
    })
    expect(screen.queryByRole('dialog')).toBeNull()
    vi.useRealTimers()
  })

  it('locks body scroll while open and restores on close', () => {
    vi.useFakeTimers()
    document.body.style.overflow = 'auto'
    const { rerender } = render(
      <Modal open onClose={() => {}}>
        <div>body</div>
      </Modal>,
    )
    expect(document.body.style.overflow).toBe('hidden')
    rerender(
      <Modal open={false} onClose={() => {}}>
        <div>body</div>
      </Modal>,
    )
    expect(document.body.style.overflow).toBe('hidden')
    act(() => {
      vi.advanceTimersByTime(OVERLAY_EXIT_MS)
    })
    expect(document.body.style.overflow).toBe('auto')
    vi.useRealTimers()
  })

  it('restores focus to the previously focused element on close', () => {
    const trigger = document.createElement('button')
    trigger.textContent = 'open'
    document.body.appendChild(trigger)
    trigger.focus()
    expect(document.activeElement).toBe(trigger)

    const { rerender } = render(
      <Modal open onClose={() => {}} title="t">
        <div>body</div>
      </Modal>,
    )
    // Focus has moved into the dialog.
    expect(document.activeElement).not.toBe(trigger)

    act(() => {
      rerender(
        <Modal open={false} onClose={() => {}} title="t">
          <div>body</div>
        </Modal>,
      )
    })
    expect(document.activeElement).toBe(trigger)
    document.body.removeChild(trigger)
  })

  it('uses ariaLabel when no title is provided', () => {
    render(
      <Modal open onClose={() => {}} ariaLabel="Untitled flow">
        <div>body</div>
      </Modal>,
    )
    expect(screen.getByRole('dialog', { name: 'Untitled flow' })).toBeInTheDocument()
  })
})
