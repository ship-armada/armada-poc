// ABOUTME: Root React error boundary — catches render errors anywhere in the tree and shows a recoverable "Something went wrong" card instead of a blank white screen.
// ABOUTME: A class component (the only way to catch render errors) with no new dependency; reports to telemetry via trackError('app', err).

import { Component, type ErrorInfo, type ReactNode } from 'react'
import { Button } from '@armada/ui'
import { Card } from '@/components/ui'
import { trackError } from '@/lib/telemetry'

interface Props {
  children: ReactNode
}

interface State {
  hasError: boolean
}

export class AppErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false }

  static getDerivedStateFromError(): State {
    return { hasError: true }
  }

  componentDidCatch(error: Error, _info: ErrorInfo): void {
    // Telemetry carries only the (downstream-truncated) message — the component stack stays local.
    trackError('app', error)
  }

  private readonly handleReload = (): void => {
    if (typeof window !== 'undefined') window.location.reload()
  }

  render(): ReactNode {
    if (!this.state.hasError) return this.props.children
    return (
      <div className="flex min-h-screen items-center justify-center p-6">
        <Card variant="raised" className="flex max-w-md flex-col items-center gap-4">
          <h2>Something went wrong</h2>
          <p>
            An unexpected error interrupted the app. Reloading usually fixes it — your wallet and
            funds are safe.
          </p>
          <Button
            variant="primary"
            size="md"
            label="Reload"
            showIcon={false}
            onClick={this.handleReload}
          />
        </Card>
      </div>
    )
  }
}
