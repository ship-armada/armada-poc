// ABOUTME: Regression guard for RainbowKit's WalletConnect QR view, which renders the moment a user picks WalletConnect.
// ABOUTME: Renders cuer (RainbowKit's QR library) the way RainbowKit does, against whichever `qr` version npm resolved.

import { render } from '@testing-library/react'
import { describe, it, expect } from 'vitest'
import { Cuer } from 'cuer'

// A WalletConnect v2 pairing URI shaped like the one RainbowKit passes to its QR view.
const WC_URI =
  'wc:7f6e504bfad60b485450578e05678ed3e8e8c4751d3c6160be17160d63ec90f9@2?relay-protocol=irn&symKey=587d5484ce2a2a6ee3ba1962fdd7e8588e06200c46823bd18fbd67def96ad303'

describe('WalletConnect QR rendering', () => {
  it('renders the QR without throwing', () => {
    // cuer@0.0.3 calls qr's encodeQR with { border: 0 }, which qr >= 0.6 rejects
    // ("RangeError: invalid border=0"). Because cuer allows any qr 0.x, a fresh
    // install (the Netlify build deletes package-lock.json) resolved the newest
    // qr and crashed the connect modal. The root package.json `overrides` pins
    // cuer's qr; this test fails if that pin stops holding.
    const { container } = render(
      <Cuer.Root errorCorrection="medium" size={200} value={WC_URI}>
        <Cuer.Cells />
        <Cuer.Finder />
      </Cuer.Root>,
    )
    expect(container.querySelector('svg')).not.toBeNull()
  })
})
