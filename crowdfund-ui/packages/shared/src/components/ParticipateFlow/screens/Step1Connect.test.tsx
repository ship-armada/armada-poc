// ABOUTME: Regression tests for the Option A connect + switch-network screens.
// ABOUTME: Each renders a single CTA that fires its callback (open picker / open chain switcher).
// @vitest-environment jsdom

import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import Step1Connect from './Step1Connect.js'
import Step1SwitchNetwork from './Step1SwitchNetwork.js'

describe('Step1Connect', () => {
  it('fires onConnect when the CTA is clicked', () => {
    const onConnect = vi.fn()
    render(<Step1Connect onConnect={onConnect} showSteps={false} />)
    fireEvent.click(screen.getByRole('button', { name: 'Connect wallet' }))
    expect(onConnect).toHaveBeenCalledOnce()
  })
})

describe('Step1SwitchNetwork', () => {
  it('shows the network label and fires onSwitch', () => {
    const onSwitch = vi.fn()
    render(<Step1SwitchNetwork networkLabel="Sepolia" onSwitch={onSwitch} showSteps={false} />)
    expect(screen.getByText(/Switch to Sepolia to continue/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Switch network' }))
    expect(onSwitch).toHaveBeenCalledOnce()
  })
})
