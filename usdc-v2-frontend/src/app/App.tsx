import { Suspense, useMemo } from 'react'
import { useLocation, useOutlet } from 'react-router-dom'
import { motion, AnimatePresence, type Variants } from 'framer-motion'
import { Navbar } from '@/components/layout/Navbar'
import { AlphaWarningBanner } from '@/components/layout/AlphaWarningBanner'
// import { Sidebar } from '@/components/layout/Sidebar'
import { Footer } from '@/components/layout/Footer'
import { ToastContainer } from '@/components/layout/ToastContainer'
import { Spinner } from '@/components/common/Spinner'
import { useTxTracker } from '@/hooks/useTxTracker'
import { useTransactionStateCleanup } from '@/hooks/useTransactionStateCleanup'
// import { useSidebarState } from '@/hooks/useSidebarState'

const slideFromLeft: Variants = {
  initial: { x: '-16%', opacity: 0 },
  animate: { x: 0, opacity: 1 },
  exit: { x: '12%', opacity: 0 },
}

const slideFromRight: Variants = {
  initial: { x: '16%', opacity: 0 },
  animate: { x: 0, opacity: 1 },
  exit: { x: '-12%', opacity: 0 },
}

const fadeIn: Variants = {
  initial: { opacity: 0 },
  animate: { opacity: 1 },
  exit: { opacity: 0 },
}

function resolveVariants(pathname: string): Variants {
  if (pathname.startsWith('/deposit')) return slideFromLeft
  if (pathname.startsWith('/send')) return slideFromRight
  if (pathname.startsWith('/history')) return fadeIn
  return fadeIn
}

export function App() {
  const location = useLocation()
  const outlet = useOutlet()
  const variants = useMemo(() => resolveVariants(location.pathname), [location.pathname])
  // Sidebar state disabled but kept for potential restoration
  // const { isCollapsed: isSidebarCollapsed, toggleSidebar } = useSidebarState()

  // Initialize global transaction tracking and polling
  // This runs on app startup and handles hydration from localStorage + polling for in-progress transactions
  const { state: _txState } = useTxTracker({ enablePolling: true })

  // Clean up transaction state when navigating to non-transaction pages
  useTransactionStateCleanup()

  return (
    <div className="flex min-h-screen bg-background text-foreground">
      <ToastContainer />
      {/* Sidebar disabled but kept for potential restoration */}
      {/* <Sidebar isCollapsed={isSidebarCollapsed} /> */}
      <div className="flex flex-1 flex-col">
        <AlphaWarningBanner />
        <Navbar />
        {/* <Navbar onToggleSidebar={toggleSidebar} isSidebarCollapsed={isSidebarCollapsed} /> */}
        <main className="relative flex-1 overflow-hidden p-6">
          <AnimatePresence mode="wait" initial={false}>
            <motion.div
              key={location.pathname}
              variants={variants}
              initial="initial"
              animate="animate"
              exit="exit"
              transition={{ duration: 0.35, ease: 'easeInOut' }}
              className="absolute inset-0 overflow-y-auto flex justify-center transform-none"
            >
              <Suspense fallback={<div className="flex justify-center mt-48"><Spinner label="Loading view" /></div>}>
                {outlet || <div className="h-full" />}
              </Suspense>
            </motion.div>
          </AnimatePresence>
        </main>
        <Footer />
      </div>
    </div>
  )
}
