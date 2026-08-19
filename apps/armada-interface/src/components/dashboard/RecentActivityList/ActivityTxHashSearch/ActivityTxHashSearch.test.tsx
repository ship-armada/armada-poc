// ABOUTME: Render/interaction test for the activity tx-hash search input — typing fires onChange.

import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { ActivityTxHashSearch } from './ActivityTxHashSearch'

describe('ActivityTxHashSearch', () => {
  it('renders the current value', () => {
    render(<ActivityTxHashSearch value="0xabc" onChange={() => {}} />)
    expect(screen.getByLabelText('Search by transaction hash')).toHaveValue('0xabc')
  })

  it('fires onChange with the typed value', () => {
    const onChange = vi.fn()
    render(<ActivityTxHashSearch value="" onChange={onChange} />)
    fireEvent.change(screen.getByLabelText('Search by transaction hash'), {
      target: { value: '0xdeadbeef' },
    })
    expect(onChange).toHaveBeenCalledWith('0xdeadbeef')
  })
})
