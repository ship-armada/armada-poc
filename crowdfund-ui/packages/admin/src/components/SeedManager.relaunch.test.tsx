// ABOUTME: Tests SeedManager under the relaunch profile (mocked, 500-seed budget): a single addSeeds call
// ABOUTME: is limited to 180 addresses, since all 500 in one transaction exceed the per-tx gas cap.

import { render, screen, fireEvent } from '@testing-library/react'

vi.mock('@armada/crowdfund-shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@armada/crowdfund-shared')>()
  return { ...actual, CROWDFUND_CONSTANTS: actual.CONSTANTS_BY_PROFILE.relaunch }
})
vi.mock('@/hooks/useTransactionFlow', () => ({
  useTransactionFlow: () => ({
    state: { status: 'idle', txHash: null, receipt: null, error: null },
    execute: vi.fn(),
    reset: vi.fn(),
  }),
}))
vi.mock('./TransactionFlow', () => ({ TransactionFlow: () => null }))

import { SeedManager } from './SeedManager'

const addresses = (n: number) =>
  Array.from({ length: n }, (_, i) => '0x' + (i + 1).toString(16).padStart(40, '0')).join('\n')

describe('SeedManager per-transaction batch limit', () => {
  // WHY: with a 500-seed budget, pasting more than ~180 addresses into one addSeeds call fails gas
  // estimation (the Safe launch tooling batches at 180 for the same reason). Refuse it up front.
  it('refuses more than 180 seeds in one transaction', () => {
    render(<SeedManager signer={null} crowdfundAddress="0x1234" seedCount={0} />)
    fireEvent.change(screen.getByPlaceholderText(/paste addresses/i), { target: { value: addresses(181) } })
    expect(screen.getByText(/At most 180 seeds per transaction/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /add 181 seed/i })).toBeDisabled()
  })

  it('accepts 180 seeds in one transaction', () => {
    render(<SeedManager signer={null} crowdfundAddress="0x1234" seedCount={0} />)
    fireEvent.change(screen.getByPlaceholderText(/paste addresses/i), { target: { value: addresses(180) } })
    expect(screen.queryByText(/At most 180 seeds per transaction/)).toBeNull()
    expect(screen.getByRole('button', { name: /add 180 seed/i })).not.toBeDisabled()
  })
})
