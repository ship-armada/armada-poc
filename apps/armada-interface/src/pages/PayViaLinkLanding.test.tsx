// ABOUTME: Tests for PayViaLinkLanding — renders per parse state + hands off a valid link to the Send flow.
// ABOUTME: Uses MemoryRouter so useLocation() sees the link query; a '/' stub stands in for the dashboard.

import { afterEach, describe, expect, it } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { PayViaLinkLanding } from './PayViaLinkLanding'

const VALID_0ZK = '0zk1testrecipientaddress0000000000000000000000'
const FUTURE = Date.now() + 7 * 86_400_000

function renderAt(url: string) {
  return render(
    <MemoryRouter initialEntries={[url]}>
      <Routes>
        <Route path="/pay-via-link" element={<PayViaLinkLanding />} />
        <Route path="/" element={<div>DASHBOARD</div>} />
      </Routes>
    </MemoryRouter>,
  )
}

afterEach(() => {
  window.sessionStorage.clear()
})

describe('PayViaLinkLanding', () => {
  it('renders the request details for a valid link', () => {
    renderAt(`/pay-via-link?to=${VALID_0ZK}&id=req_a&expires=${FUTURE}&amount=25&note=Invoice+7`)
    expect(screen.getByRole('heading', { name: 'USDC payment request' })).toBeInTheDocument()
    expect(screen.getByText('25.00')).toBeInTheDocument()
    expect(screen.getByText('Invoice 7')).toBeInTheDocument()
    expect(screen.getByRole('img', { name: 'Scan to open payment request' })).toBeInTheDocument()
  })

  it('shows the invalid state for a non-shielded recipient', () => {
    renderAt(`/pay-via-link?to=0xabc&id=req_a&expires=${FUTURE}`)
    expect(screen.getByRole('heading', { name: 'This payment link is invalid' })).toBeInTheDocument()
  })

  it('shows the expired state for a past timestamp', () => {
    renderAt(`/pay-via-link?to=${VALID_0ZK}&id=req_a&expires=1`)
    expect(screen.getByRole('heading', { name: 'This payment link expired' })).toBeInTheDocument()
  })

  it('shows the revoked state when the id is in the revoked set', () => {
    window.sessionStorage.setItem('armada-revoked-payment-links', JSON.stringify(['req_a']))
    renderAt(`/pay-via-link?to=${VALID_0ZK}&id=req_a&expires=${FUTURE}`)
    expect(screen.getByRole('heading', { name: 'This payment link was revoked' })).toBeInTheDocument()
  })

  it('Continue to pay writes the pending hand-off + navigates to the dashboard', async () => {
    renderAt(`/pay-via-link?to=${VALID_0ZK}&id=req_a&expires=${FUTURE}&amount=25`)

    fireEvent.click(screen.getByRole('button', { name: 'Continue to pay' }))

    await waitFor(() => expect(screen.getByText('DASHBOARD')).toBeInTheDocument())
    const pending = JSON.parse(window.sessionStorage.getItem('armada-pending-pay-via-link') ?? 'null')
    expect(pending).toMatchObject({ recipient: VALID_0ZK, requestId: 'req_a', amount: '25' })
  })
})
