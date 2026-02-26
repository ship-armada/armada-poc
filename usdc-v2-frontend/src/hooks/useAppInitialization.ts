import { useEffect, useRef } from 'react'
import { useAtom } from 'jotai'
import { appInitAtom, chainConfigAtom } from '@/atoms/appAtom'
import { initializeApplication } from '@/services/bootstrap/initService'
import { resumePendingCrossChainShields } from '@/services/tx/shieldTxTracker'
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

        // Resume polling for in-progress cross-chain shields after chain config is available
        // (fire-and-forget — getEvmProvider needs chainConfigAtom to be set first)
        const resumedCount = resumePendingCrossChainShields()
        if (resumedCount > 0) {
          console.log(`[init] Resumed ${resumedCount} pending cross-chain shield(s)`)
        }
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
