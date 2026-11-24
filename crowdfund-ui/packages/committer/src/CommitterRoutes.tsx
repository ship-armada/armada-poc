// ABOUTME: The committer's route table, lazy-loading each page into its own chunk.
// ABOUTME: Pre-launch builds serve the countdown on every path except /refund (first-sale refunds); live builds add /refund too.

import { lazy, type ReactElement } from 'react'
import { Routes, Route } from 'react-router-dom'
import { SentryErrorBoundary } from '@/lib/sentry'

// Lazy-load the routes so each lands in its own chunk: the /invite landing page
// and the dev-only MockCommitterApp (TreeView/TableView → d3 + react-table) stay
// out of the main bundle.
const App = lazy(() => import('@/App').then((m) => ({ default: m.App })))
const InviteLandingPage = lazy(() =>
  import('@/components/InviteLandingPage').then((m) => ({ default: m.InviteLandingPage })),
)
const MockCommitterApp = lazy(() => import('@/MockCommitterApp'))
const PreLaunchApp = lazy(() =>
  import('@/PreLaunchApp').then((m) => ({ default: m.PreLaunchApp })),
)
const RefundPage = lazy(() =>
  import('@/components/RefundPage').then((m) => ({ default: m.RefundPage })),
)

export function CommitterRoutes({
  prelaunchOpensAt,
  mockSize,
  inviteFallback,
}: {
  /** Pre-launch build (VITE_PRELAUNCH_OPENS_AT): the countdown hero, published before the
   *  contracts exist. Null for the live app. */
  prelaunchOpensAt: number | null
  /** Dev-only stress harness selection (0 in production). */
  mockSize: number
  /** Error fallback for the /invite landing page's own boundary. */
  inviteFallback: (props: { eventId: string }) => ReactElement
}) {
  if (prelaunchOpensAt !== null) {
    // The countdown on every path, except the first-sale refund page: the old frontend is gone by
    // then, so this is where refunds stay claimable until the sale opens.
    return (
      <Routes>
        <Route path="/refund" element={<RefundPage />} />
        <Route path="*" element={<PreLaunchApp opensAtUnix={prelaunchOpensAt} />} />
      </Routes>
    )
  }
  if (mockSize > 0) return <MockCommitterApp size={mockSize} />
  return (
    <Routes>
      <Route path="/" element={<App />} />
      {/* `/observe` renders the same App; it resolves to the
          Observe page via the pathname (App also accepts
          `/?view=observe`). */}
      <Route path="/observe" element={<App />} />
      <Route
        path="/invite"
        element={
          <SentryErrorBoundary fallback={inviteFallback}>
            <InviteLandingPage />
          </SentryErrorBoundary>
        }
      />
      <Route path="/refund" element={<RefundPage />} />
    </Routes>
  )
}
