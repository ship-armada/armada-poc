// ABOUTME: Shared app header — fixed 56px bar with ArmadaLogo, logo-adjacent nav, full-screen mobile menu, and slotted chrome.
// ABOUTME: Visual layout mirrors @armada/ui's Header at designer HEAD; preserves the slot props the committer/observer rely on for dynamic content.

import { useState, type ReactNode } from 'react'
import { Bars3Icon } from '@heroicons/react/24/outline'
import { ArmadaLogo, Tag } from '@armada/ui'
import { Button } from './ui/button.js'
import {
  Sheet,
  SheetTrigger,
  SheetContent,
  SheetTitle,
  SheetDescription,
} from './ui/sheet.js'
import { cn } from '../lib/utils.js'

/** Network identifiers the header recognises for the badge. Other strings render as a plain Tag with the upper-cased label. */
export type AppHeaderNetwork = 'local' | 'sepolia' | (string & {})

export interface AppHeaderProps {
  /** Short label displayed in the mobile sheet header (e.g. "Observer", "Committer"). */
  appName: string
  /** Network label used for the badge text. */
  network: AppHeaderNetwork
  /**
   * Desktop-only primary navigation (≥sm), rendered inline to the right of the
   * logo. Mobile navigation should be composed into `mobileMenu`.
   */
  headerNav?: ReactNode
  /**
   * Desktop-only inline status indicator (≥sm), rendered between the primary
   * nav and the right-side chrome. Use for compact, contextual info like a
   * campaign-lifecycle stepper.
   */
  headerStatus?: ReactNode
  /**
   * Desktop-only header actions (≥sm). Wallet button, secondary controls, etc.
   * Hidden below the sm breakpoint — compose anything the user still needs on
   * mobile into `mobileMenu` instead.
   */
  headerRight?: ReactNode
  /**
   * Mobile menu contents, rendered full-screen when the hamburger is tapped.
   * May be a node, or a render function receiving a `close` callback so menu
   * actions can dismiss the Sheet. Omit to suppress the hamburger entirely.
   */
  mobileMenu?: ReactNode | ((close: () => void) => ReactNode)
  className?: string
}

export function AppHeader({
  appName,
  network,
  headerNav,
  headerStatus,
  headerRight,
  mobileMenu,
  className,
}: AppHeaderProps) {
  const [menuOpen, setMenuOpen] = useState(false)
  return (
    <header
      className={cn(
        // Inset 24px from top + each side, matching the designer's Hero page
        // (Hero.module.css `.headerOverride`) and the @armada/ui showcase.
        // Transparent — the body's radial gradient and content show through
        // unobstructed. Consumers needing contrast under busy content can add
        // their own bg via className.
        'fixed inset-x-6 top-6 z-40 flex h-14 items-center justify-between',
        className,
      )}
    >
      {/* Left: Armada wordmark + primary nav (desktop) */}
      <div className="flex shrink-0 items-center gap-6">
        <ArmadaLogo />

        {/* Desktop nav — grouped with the logo on the left, per the designer's Hero header. */}
        {headerNav && (
          <nav aria-label="Primary" className="hidden items-center md:flex">
            {headerNav}
          </nav>
        )}
      </div>

      {/* Right: desktop chrome (≥md) + mobile burger (right corner, per the designer) */}
      <div className="flex shrink-0 items-center gap-3">
        <div className="hidden items-center gap-3 md:flex">
          {headerStatus && <div className="flex h-full items-center">{headerStatus}</div>}
          <Tag label={network} />
          {headerRight}
        </div>

        {mobileMenu !== undefined && (
          <Sheet open={menuOpen} onOpenChange={setMenuOpen}>
            <SheetTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                // Round translucent burger, matching the designer's `.burgerBtn`
                // and the menu/modal round controls. The className overrides the
                // shadcn ghost/icon defaults via twMerge. Theme-aware: dark keeps
                // the white-translucent treatment byte-identical; light flips to a
                // dark-ink icon + dark-translucent fill so it stays visible on a
                // light header (the `dark:` variant keys off data-theme).
                className="size-12 rounded-full bg-black/10 text-foreground hover:bg-black/20 dark:bg-white/20 dark:text-white dark:hover:bg-white/30 md:hidden"
                aria-label="Open menu"
              >
                <Bars3Icon className="size-5" />
              </Button>
            </SheetTrigger>
            <SheetContent
              side="left"
              showCloseButton={false}
              className="inset-0 h-full w-full max-w-none gap-0 border-0 bg-transparent p-0 shadow-none sm:max-w-none"
            >
              {/* Radix Dialog requires a title + description for a11y; the menu
                  renders its own visible chrome, so these stay sr-only. */}
              <SheetTitle className="sr-only">{appName} menu</SheetTitle>
              <SheetDescription className="sr-only">
                Navigation and wallet actions
              </SheetDescription>
              {typeof mobileMenu === 'function'
                ? mobileMenu(() => setMenuOpen(false))
                : mobileMenu}
            </SheetContent>
          </Sheet>
        )}
      </div>
    </header>
  )
}
