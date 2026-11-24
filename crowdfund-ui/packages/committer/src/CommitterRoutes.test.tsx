// ABOUTME: Tests the committer's route table: /refund is served in both pre-launch and live builds.
// ABOUTME: Page components are stubbed, so only the routing decision is under test.
// @vitest-environment jsdom

import { describe, expect, it, vi } from 'vitest'
import { Suspense } from 'react'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

vi.mock('@/App', () => ({ App: () => <div>live app</div> }))
vi.mock('@/PreLaunchApp', () => ({ PreLaunchApp: () => <div>countdown</div> }))
vi.mock('@/components/RefundPage', () => ({ RefundPage: () => <div>refund page</div> }))
vi.mock('@/components/InviteLandingPage', () => ({ InviteLandingPage: () => <div>invite page</div> }))
vi.mock('@/MockCommitterApp', () => ({ default: () => <div>mock app</div> }))
vi.mock('@/lib/sentry', () => ({ SentryErrorBoundary: ({ children }: { children: React.ReactNode }) => <>{children}</> }))

import { CommitterRoutes } from './CommitterRoutes'

const OPENS_AT = 1_800_000_000

function renderAt(path: string, prelaunchOpensAt: number | null) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Suspense fallback={<div>loading</div>}>
        <CommitterRoutes prelaunchOpensAt={prelaunchOpensAt} mockSize={0} inviteFallback={() => <div>crash</div>} />
      </Suspense>
    </MemoryRouter>,
  )
}

describe('CommitterRoutes', () => {
  // WHY: the old frontend comes down at switch-over, so first-sale refunds must be claimable
  // before the relaunch opens, from the pre-launch build.
  it('serves /refund in a pre-launch build', async () => {
    renderAt('/refund', OPENS_AT)
    expect(await screen.findByText('refund page')).toBeTruthy()
  })

  // WHY: the countdown stays on every other path, as before.
  it('keeps the countdown on every other path in a pre-launch build', async () => {
    renderAt('/', OPENS_AT)
    expect(await screen.findByText('countdown')).toBeTruthy()
    renderAt('/invite', OPENS_AT)
    expect((await screen.findAllByText('countdown')).length).toBe(2)
  })

  it('serves /refund in a live build', async () => {
    renderAt('/refund', null)
    expect(await screen.findByText('refund page')).toBeTruthy()
  })

  it('keeps the live app and invite routes in a live build', async () => {
    renderAt('/', null)
    expect(await screen.findByText('live app')).toBeTruthy()
    renderAt('/invite', null)
    expect(await screen.findByText('invite page')).toBeTruthy()
  })
})
