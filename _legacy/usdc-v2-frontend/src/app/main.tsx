import { StrictMode } from 'react'
import { HashRouter } from 'react-router-dom'
import { Provider as JotaiProvider } from 'jotai'
import { jotaiStore } from '@/store/jotaiStore'
import { AppRoutes } from './routes'
import { AppBootstrap } from './AppBootstrap'

export function AppMain() {
  return (
    <StrictMode>
      <JotaiProvider store={jotaiStore}>
        <HashRouter>
          <AppBootstrap>
            <AppRoutes />
          </AppBootstrap>
        </HashRouter>
      </JotaiProvider>
    </StrictMode>
  )
}
