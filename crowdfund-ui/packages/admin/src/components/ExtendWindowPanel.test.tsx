// ABOUTME: Tests for ExtendWindowPanel — deadline display, UTC input, presets, validation, and submission.
// ABOUTME: Verifies the button only enables for a valid new end and calls extendWindow(newEnd).

import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import type { Signer } from 'ethers'
import { ExtendWindowForm, ExtendWindowPanel } from './ExtendWindowPanel'

const mockExecute = vi.fn()
const mockExtendWindow = vi.fn()
let mockMaxWindowDuration: number | null | undefined = 14 * 86400

vi.mock('@/hooks/useTransactionFlow', () => ({
  useTransactionFlow: () => ({
    state: { status: 'idle', txHash: null, receipt: null, error: null },
    execute: mockExecute,
    reset: vi.fn(),
  }),
}))

vi.mock('@/hooks/useMaxWindowDuration', () => ({
  useMaxWindowDuration: () => mockMaxWindowDuration,
}))

vi.mock('./TransactionFlow', () => ({
  TransactionFlow: () => null,
}))

vi.mock('ethers', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ethers')>()
  return {
    ...actual,
    Contract: class MockContract {
      constructor() {
        return { extendWindow: mockExtendWindow }
      }
    },
  }
})

const DAY = 86400
const START = Date.UTC(2026, 11, 1, 16, 0) / 1000 // 2026-12-01 16:00 UTC
const props = {
  signer: null,
  crowdfundAddress: '0xcf',
  provider: null,
  windowStart: START,
  windowEnd: START + 7 * DAY, // 2026-12-08 16:00 UTC
  blockTimestamp: START + 3 * DAY,
}

const input = () => screen.getByLabelText('New end (UTC)') as HTMLInputElement
const extendButton = () => screen.getByRole('button', { name: /^extend/i })

describe('ExtendWindowForm', () => {
  beforeEach(() => {
    mockExecute.mockReset()
    mockExtendWindow.mockReset()
  })

  // WHY: the operator must see the current and maximum deadlines in UTC to choose a new one.
  it('shows the current and maximum end in UTC', () => {
    render(<ExtendWindowForm {...props} maxWindowDuration={14 * DAY} />)
    expect(screen.getByText('2026-12-08 16:00 UTC')).toBeInTheDocument()
    expect(screen.getByText('2026-12-15 16:00 UTC')).toBeInTheDocument()
  })

  it('keeps the button disabled until a valid new end is entered', () => {
    render(<ExtendWindowForm {...props} maxWindowDuration={14 * DAY} />)
    expect(extendButton()).toBeDisabled()

    fireEvent.change(input(), { target: { value: '2026-12-08T16:00' } }) // equal to the current end
    expect(screen.getByText(/later than the current end/)).toBeInTheDocument()
    expect(extendButton()).toBeDisabled()

    fireEvent.change(input(), { target: { value: '2026-12-15T16:01' } }) // one minute past the maximum
    expect(screen.getByText(/past the maximum/)).toBeInTheDocument()
    expect(extendButton()).toBeDisabled()

    fireEvent.change(input(), { target: { value: '2026-12-10T12:30' } })
    expect(extendButton()).not.toBeDisabled()
    expect(extendButton()).toHaveTextContent('Extend to 2026-12-10 12:30 UTC')
  })

  // WHY: presets count from the current end and never exceed the maximum the contract accepts.
  it('fills presets from the current end, capped at the maximum', () => {
    render(<ExtendWindowForm {...props} maxWindowDuration={8 * DAY} />)
    fireEvent.click(screen.getByRole('button', { name: '+1 day' }))
    expect(input().value).toBe('2026-12-09T16:00')
    fireEvent.click(screen.getByRole('button', { name: '+3 days' }))
    expect(input().value).toBe('2026-12-09T16:00') // +3 days would pass the 8-day maximum
    fireEvent.click(screen.getByRole('button', { name: 'Maximum' }))
    expect(input().value).toBe('2026-12-09T16:00')
  })

  // WHY: with under 24h of chain time left the transaction may land too late, which can't be retried.
  it('warns when the current end is less than 24h away', () => {
    render(<ExtendWindowForm {...props} blockTimestamp={props.windowEnd - 3600} maxWindowDuration={14 * DAY} />)
    fireEvent.change(input(), { target: { value: '2026-12-10T16:00' } })
    expect(screen.getByText(/Less than 24h left/)).toBeInTheDocument()
    expect(extendButton()).not.toBeDisabled()
  })

  // WHY: the submitted value must be the exact unix second shown to the operator.
  it('submits extendWindow with the entered end as unix seconds', async () => {
    mockExecute.mockImplementation(async (fn: (s: Signer) => Promise<unknown>) => {
      await fn({} as Signer)
      return true
    })
    render(<ExtendWindowForm {...props} maxWindowDuration={14 * DAY} />)
    fireEvent.change(input(), { target: { value: '2026-12-10T12:30' } })
    fireEvent.click(extendButton())
    await waitFor(() => expect(input().value).toBe('')) // cleared after a successful transaction
    expect(mockExtendWindow).toHaveBeenCalledWith(Date.UTC(2026, 11, 10, 12, 30) / 1000)
  })
})

describe('ExtendWindowPanel', () => {
  // WHY: on a crowdfund without extendWindow (MAX_WINDOW_DURATION unreadable) the panel must not render.
  it('renders nothing while loading or when the contract has no extension', () => {
    mockMaxWindowDuration = undefined
    const { container, rerender } = render(<ExtendWindowPanel {...props} />)
    expect(container).toBeEmptyDOMElement()
    mockMaxWindowDuration = null
    rerender(<ExtendWindowPanel {...props} />)
    expect(container).toBeEmptyDOMElement()
    mockMaxWindowDuration = 14 * DAY
    rerender(<ExtendWindowPanel {...props} />)
    expect(screen.getByText('Extend Window')).toBeInTheDocument()
  })
})
