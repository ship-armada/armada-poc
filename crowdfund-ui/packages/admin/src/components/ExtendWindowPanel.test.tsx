// ABOUTME: Tests for ExtendWindowPanel — deadline display, UTC input, the +5-day preset, validation, and submission.
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

  // WHY: the operational rule is +5 days per extension, so that is the only preset; other steps
  // need the date input and draw a warning.
  it('offers a single +5 days preset counted from the current end', () => {
    render(<ExtendWindowForm {...props} maxWindowDuration={14 * DAY} />)
    expect(screen.queryByRole('button', { name: '+1 day' })).toBeNull()
    expect(screen.queryByRole('button', { name: '+3 days' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Maximum' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '+5 days' }))
    expect(input().value).toBe('2026-12-13T16:00')
    expect(screen.queryByText(/operational rule/)).toBeNull()
  })

  // WHY: a current end with seconds can't be matched exactly by the minute-precision input; the
  // preset must still count as the +5-day step rather than warn.
  it('shows no step warning for the +5 days preset when the current end has seconds', () => {
    render(<ExtendWindowForm {...props} windowEnd={props.windowEnd + 23} maxWindowDuration={14 * DAY} />)
    fireEvent.click(screen.getByRole('button', { name: '+5 days' }))
    expect(input().value).toBe('2026-12-13T16:00')
    expect(screen.queryByText(/operational rule/)).toBeNull()
  })

  // WHY: the preset must never fill an end the contract would reject.
  it('caps the +5 days preset at the maximum end', () => {
    render(<ExtendWindowForm {...props} maxWindowDuration={8 * DAY} />)
    fireEvent.click(screen.getByRole('button', { name: '+5 days' }))
    expect(input().value).toBe('2026-12-09T16:00')
  })

  // WHY: the contract allows any step up to the maximum, so an off-rule end stays submittable, but
  // the operator is told it breaks the +5-day rule, as cf-safe-extend does on the Safe path.
  it('warns, without blocking, when the new end is not a +5-day step', () => {
    render(<ExtendWindowForm {...props} maxWindowDuration={14 * DAY} />)
    fireEvent.change(input(), { target: { value: '2026-12-10T16:00' } })
    expect(screen.getByText(/2 days after the current end; the operational rule is \+5 days/)).toBeInTheDocument()
    expect(extendButton()).not.toBeDisabled()
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
