import { useEffect, useRef } from 'react'
import { useAtom } from 'jotai'
import { appInitAtom, chainConfigAtom } from '@/atoms/appAtom'
import { initializeApplication } from '@/services/bootstrap/initService'
import { useToast } from '@/hooks/useToast'

export function useAppInitialization() {
  const [initState, setInitState] = useAtom(appInitAtom)
  const [, setChainConfig] = useAtom(chainConfigAtom)
  const { notify } = useToast()
  const hasStarted = useRef(false)

  useEffect(() => {
    if (hasStarted.current) {
      return
    }
    hasStarted.current = true

    async function runInitialization() {
      setInitState({ status: 'loading' })
      try {
        const result = await initializeApplication()
        setChainConfig(result.chains)
        setInitState({ status: 'ready' })
      } catch (error) {
        console.error('App initialization failed', error)
        setInitState({ status: 'error', error: error instanceof Error ? error.message : 'Unknown error' })
        notify({
          level: 'error',
          title: 'Initialization failed',
          description: 'Unable to load initial configuration. Please refresh and try again.',
        })
      }
    }

    runInitialization()
  }, [notify, setChainConfig, setInitState])

  return initState
}
