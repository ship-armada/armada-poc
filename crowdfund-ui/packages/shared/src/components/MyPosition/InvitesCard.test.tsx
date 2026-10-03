// ABOUTME: Tests for InvitesCard's inactive-panel flush — pending invites flush once per deactivation.
// ABOUTME: Guards against a render loop when the parent passes a fresh onFlushPending each render.
// @vitest-environment jsdom

import { useState } from 'react'
import { render } from '@testing-library/react'
import { describe, it, expect, vi, beforeAll } from 'vitest'
import { InvitesCard } from './InvitesCard'
import type { InviteAllowance } from './inviteModel'

const allowance: InviteAllowance = { hop1: 3, hop2: 0 }

// Bounds the re-render chain so a regression fails fast instead of hanging.
const MAX_PARENT_RENDERS = 50

beforeAll(() => {
  // jsdom lacks matchMedia; InvitesCard reads it for the short-viewport layout.
  window.matchMedia ??= ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  })) as typeof window.matchMedia
})

/** Mirrors CrowdfundExperience: a new onFlushPending closure every render that bumps parent state. */
function UnstableFlushParent({
  panelActive,
  onFlushCall,
}: {
  panelActive: boolean
  onFlushCall: () => void
}) {
  const [, setEpoch] = useState(0)
  const onFlushPending = () => {
    onFlushCall()
    setEpoch((n) => (n < MAX_PARENT_RENDERS ? n + 1 : n))
  }
  return (
    <InvitesCard
      slots={[]}
      allowance={allowance}
      onGenerateLink={vi.fn().mockResolvedValue(undefined)}
      onCopy={vi.fn()}
      onRevoke={vi.fn()}
      onInviteOnchain={vi.fn().mockResolvedValue(undefined)}
      onFlushPending={onFlushPending}
      panelActive={panelActive}
    />
  )
}

describe('InvitesCard inactive-panel flush', () => {
  it('flushes once while inactive even when the parent passes a fresh callback each render', () => {
    const onFlushCall = vi.fn()
    render(<UnstableFlushParent panelActive={false} onFlushCall={onFlushCall} />)
    expect(onFlushCall).toHaveBeenCalledTimes(1)
  })

  it('does not flush while the panel is active', () => {
    const onFlushCall = vi.fn()
    render(<UnstableFlushParent panelActive onFlushCall={onFlushCall} />)
    expect(onFlushCall).not.toHaveBeenCalled()
  })

  it('flushes again each time the panel becomes inactive', () => {
    const onFlushCall = vi.fn()
    const { rerender } = render(
      <UnstableFlushParent panelActive onFlushCall={onFlushCall} />,
    )
    rerender(<UnstableFlushParent panelActive={false} onFlushCall={onFlushCall} />)
    expect(onFlushCall).toHaveBeenCalledTimes(1)
    rerender(<UnstableFlushParent panelActive onFlushCall={onFlushCall} />)
    rerender(<UnstableFlushParent panelActive={false} onFlushCall={onFlushCall} />)
    expect(onFlushCall).toHaveBeenCalledTimes(2)
  })
})
