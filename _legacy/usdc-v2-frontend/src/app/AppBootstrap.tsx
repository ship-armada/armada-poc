import type { PropsWithChildren } from 'react'
import { useSetAtom } from 'jotai'
import { useAppInitialization } from '@/hooks/useAppInitialization'
import { appInitAtom } from '@/atoms/appAtom'
import { Spinner } from '@/components/common/Spinner'
import { Button } from '@/components/common/Button'
import { useTheme } from '@/hooks/useTheme'

export function AppBootstrap({ children }: PropsWithChildren) {
  // Initialize theme early to prevent flash of wrong theme
  useTheme()
  
  const initState = useAppInitialization()
  const setInitState = useSetAtom(appInitAtom)

  if (initState.status === 'loading' || initState.status === 'idle') {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background">
        <Spinner label="Preparing application" />
      </div>
    )
  }

  if (initState.status === 'error') {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-4 bg-background p-6 text-center">
        <div className="space-y-2">
          <h2 className="text-lg font-semibold">Initialization failed</h2>
          <p className="text-sm text-muted-foreground">
            {initState.error ?? 'Our bootstrap sequence encountered an unexpected error.'}
          </p>
        </div>
        <Button onClick={() => setInitState({ status: 'idle' })} variant="primary">
          Retry initialization
        </Button>
      </div>
    )
  }

  return children
}
