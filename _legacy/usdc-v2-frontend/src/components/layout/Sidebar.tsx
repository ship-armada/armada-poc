import { NavLink, useLocation } from 'react-router-dom'
import { motion, AnimatePresence } from 'framer-motion'
import { cn } from '@/lib/utils'
import { useBalance } from '@/hooks/useBalance'
import { useAtomValue } from 'jotai'
import { balanceSyncAtom, balanceErrorAtom } from '@/atoms/balanceAtom'

const links = [
  { to: '/dashboard', label: 'Dashboard', glyph: 1 },
  { to: '/deposit', label: 'Deposit', glyph: 2 },
  { to: '/send', label: 'Send Payment', glyph: 3 },
  { to: '/history', label: 'Transaction History', glyph: 4 },
  { to: '/settings', label: 'Settings', glyph: 5 },
]

interface SidebarProps {
  isCollapsed: boolean
}

export function Sidebar({ isCollapsed }: SidebarProps) {
  const { state: balanceState } = useBalance()
  const balanceSyncState = useAtomValue(balanceSyncAtom)
  const balanceError = useAtomValue(balanceErrorAtom)
  const location = useLocation()
  
  // Check for balance calculation error state
  const hasBalanceError = balanceSyncState.shieldedStatus === 'error' && balanceError
  const shieldedBalance = hasBalanceError ? '--' : balanceState.namada.usdcShielded
  const hasShieldedBalance = shieldedBalance && shieldedBalance !== '--' && parseFloat(shieldedBalance) > 0
  return (
    <motion.aside
      initial={false}
      animate={{
        width: isCollapsed ? 0 : 256,
        opacity: isCollapsed ? 0 : 1,
      }}
      transition={{
        duration: 0.3,
        ease: [0.4, 0, 0.2, 1],
      }}
      className={cn(
        'hidden overflow-hidden bg-sidebar text-sm md:flex',
        !isCollapsed && 'border-r border-border',
      )}
    >
      <AnimatePresence mode="wait">
        {!isCollapsed && (
          <motion.div
            initial={{ opacity: 0, x: -20 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: -20 }}
            transition={{ duration: 0.2, delay: 0.1 }}
            className="flex w-64 flex-col p-6"
          >
            <div className="mb-10 border-b py-2 pb-4">
              <h2 className="text-lg font-medium text-muted-foreground/50">Borderless Private USDC</h2>
            </div>
            <nav className="flex flex-col gap-1">
              {links.map(({ to, label, glyph }) => {
                const isSendPayment = to === '/send'
                const isDisabled = isSendPayment && !hasShieldedBalance
                // Check if this link is active
                const isActive = to === '/dashboard' 
                  ? location.pathname === '/dashboard'
                  : location.pathname.startsWith(to)
                
                return (
                  <NavLink
                    key={to}
                    to={isDisabled ? '#' : to}
                    onClick={(e) => {
                      if (isDisabled) {
                        e.preventDefault()
                      }
                    }}
                    className={({ isActive }) =>
                      cn(
                        'rounded-md px-3 py-2 font-medium transition-colors flex items-center gap-5',
                        isDisabled 
                          ? 'cursor-not-allowed opacity-50 text-muted-foreground'
                          : isActive 
                          ? 'bg-sidebar-primary text-sidebar-primary-foreground' 
                          : 'text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground',
                      )
                    }
                    end={to === '/dashboard'}
                  >
                    <img 
                      src={`/assets/symbols/glyph${glyph}.png`}
                      alt=""
                      className={cn(
                        'h-5 w-5 flex-shrink-0',
                        !isActive && 'dark:invert',
                        isActive && 'invert dark:invert-0'
                      )}
                    />
                    {label}
                  </NavLink>
                )
              })}
            </nav>
            {/* TODO: Add network health, balances summary, and quick links. */}
          </motion.div>
        )}
      </AnimatePresence>
    </motion.aside>
  )
}
