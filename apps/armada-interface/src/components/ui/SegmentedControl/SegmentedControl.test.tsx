// ABOUTME: Render/interaction tests for SegmentedControl — equal + scroll layouts, surface variants, keyboard nav.

import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { SegmentedControl } from './SegmentedControl'

const OPTIONS = [
  { id: 'a', label: 'Alpha' },
  { id: 'b', label: 'Beta' },
  { id: 'c', label: 'Gamma' },
] as const

describe('SegmentedControl', () => {
  it('renders every option as a tab (equal layout default)', () => {
    render(<SegmentedControl options={OPTIONS} value="a" onChange={() => {}} aria-label="Test" />)
    for (const label of ['Alpha', 'Beta', 'Gamma']) {
      expect(screen.getByRole('tab', { name: label })).toBeInTheDocument()
    }
  })

  it('marks the active tab as selected', () => {
    render(<SegmentedControl options={OPTIONS} value="b" onChange={() => {}} aria-label="Test" />)
    expect(screen.getByRole('tab', { name: 'Beta' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('tab', { name: 'Alpha' })).toHaveAttribute('aria-selected', 'false')
  })

  it('fires onChange with the option id when clicked', () => {
    const onChange = vi.fn()
    render(<SegmentedControl options={OPTIONS} value="a" onChange={onChange} aria-label="Test" />)
    fireEvent.click(screen.getByRole('tab', { name: 'Gamma' }))
    expect(onChange).toHaveBeenCalledWith('c')
  })

  it('advances selection with ArrowRight (roving-tabindex nav)', () => {
    const onChange = vi.fn()
    render(<SegmentedControl options={OPTIONS} value="a" onChange={onChange} aria-label="Test" />)
    fireEvent.keyDown(screen.getByRole('tablist'), { key: 'ArrowRight' })
    expect(onChange).toHaveBeenCalledWith('b')
  })

  describe('scroll layout', () => {
    it('renders every option as a tab', () => {
      render(
        <SegmentedControl
          options={OPTIONS}
          value="a"
          onChange={() => {}}
          layout="scroll"
          surface="raised"
          aria-label="Test"
        />,
      )
      for (const label of ['Alpha', 'Beta', 'Gamma']) {
        expect(screen.getByRole('tab', { name: label })).toBeInTheDocument()
      }
    })

    it('fires onChange on click', () => {
      const onChange = vi.fn()
      render(
        <SegmentedControl
          options={OPTIONS}
          value="a"
          onChange={onChange}
          layout="scroll"
          surface="raised"
          aria-label="Test"
        />,
      )
      fireEvent.click(screen.getByRole('tab', { name: 'Beta' }))
      expect(onChange).toHaveBeenCalledWith('b')
    })

    it('is keyboard-navigable (ArrowLeft wraps to the last option)', () => {
      const onChange = vi.fn()
      render(
        <SegmentedControl
          options={OPTIONS}
          value="a"
          onChange={onChange}
          layout="scroll"
          surface="raised"
          aria-label="Test"
        />,
      )
      fireEvent.keyDown(screen.getByRole('tablist'), { key: 'ArrowLeft' })
      expect(onChange).toHaveBeenCalledWith('c')
    })
  })
})
