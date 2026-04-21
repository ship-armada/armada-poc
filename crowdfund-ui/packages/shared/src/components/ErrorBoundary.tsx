// ABOUTME: React error boundary + default dark-themed fallback card for app and panel wrapping.
// ABOUTME: Isolates thrown render errors so one failed panel does not blank the entire app.

import * as React from 'react'
import { AlertTriangle, RefreshCw } from 'lucide-react'

import { Alert, AlertDescription, AlertTitle } from './ui/alert.js'
import { Button } from './ui/button.js'

export interface ErrorBoundaryProps {
  children: React.ReactNode
  /** Custom fallback. If omitted, a `<DefaultErrorFallback>` is used. */
  fallback?: React.ReactNode | ((error: Error, reset: () => void) => React.ReactNode)
  /** Called once when the boundary catches; useful for external logging. */
  onError?: (error: Error, info: React.ErrorInfo) => void
}

interface ErrorBoundaryState {
  error: Error | null
}

export class ErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error }
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    // Log so the exception survives the boundary for devtools + monitoring.
    // eslint-disable-next-line no-console
    console.error('[ErrorBoundary]', error, info)
    this.props.onError?.(error, info)
  }

  reset = () => {
    this.setState({ error: null })
  }

  render() {
    const { error } = this.state
    const { children, fallback } = this.props
    if (!error) return children

    if (typeof fallback === 'function') {
      return fallback(error, this.reset)
    }
    if (fallback !== undefined) {
      return fallback
    }
    return <DefaultErrorFallback error={error} onReset={this.reset} />
  }
}

export interface DefaultErrorFallbackProps {
  error: Error
  /** Clears the boundary's error state. Call this from a retry control. */
  onReset?: () => void
}

export function DefaultErrorFallback({ error, onReset }: DefaultErrorFallbackProps) {
  return (
    <Alert variant="destructive" className="flex-col items-start gap-3">
      <AlertTriangle />
      <AlertTitle>Something went wrong</AlertTitle>
      <AlertDescription>
        <div className="text-sm">{error.message || 'An unexpected error occurred.'}</div>
      </AlertDescription>
      <div className="col-start-2 flex gap-2">
        {onReset ? (
          <Button variant="outline" size="sm" onClick={onReset}>
            <RefreshCw className="size-3" /> Try again
          </Button>
        ) : null}
        <Button
          variant="outline"
          size="sm"
          onClick={() => window.location.reload()}
        >
          Reload page
        </Button>
      </div>
    </Alert>
  )
}
