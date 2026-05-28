// ABOUTME: Shared app header — fixed 56px bar with ArmadaLogo, logo-adjacent nav, mobile sheet, and slotted chrome.
// ABOUTME: Visual layout mirrors @armada/ui's Header at designer HEAD; preserves the slot props the committer/observer rely on for dynamic content.

import { type ReactNode } from 'react'
import { Menu } from 'lucide-react'
import { ArmadaLogo, Tag } from '@armada/ui'
import { Button } from './ui/button.js'
import { Separator } from './ui/separator.js'
import {
  Sheet,
  SheetTrigger,
  SheetContent,
  SheetHeader,
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
   * Mobile Sheet contents, rendered when the hamburger is tapped. Omit to
   * suppress the hamburger trigger entirely.
   */
  mobileMenu?: ReactNode
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
      {/* Left: hamburger (mobile) + Armada wordmark + primary nav (desktop) */}
      <div className="flex shrink-0 items-center gap-6">
        <div className="flex items-center gap-2.5">
          {mobileMenu !== undefined && (
            <Sheet>
              <SheetTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="sm:hidden"
                  aria-label="Open menu"
                >
                  <Menu className="size-5" />
                </Button>
              </SheetTrigger>
              <SheetContent side="left" className="w-80 sm:max-w-sm">
                <SheetHeader>
                  <SheetTitle>ARMADA</SheetTitle>
                  <SheetDescription>{appName}</SheetDescription>
                </SheetHeader>
                <div className="flex flex-col gap-3 px-4 pb-4">
                  <div className="flex items-center gap-2">
                    <span className="text-muted-foreground">Network</span>
                    <Tag label={network} />
                  </div>
                  <Separator />
                  {mobileMenu}
                </div>
              </SheetContent>
            </Sheet>
          )}
          <ArmadaLogo />
        </div>

        {/* Desktop nav — grouped with the logo on the left, per the designer's Hero header. */}
        {headerNav && (
          <nav aria-label="Primary" className="hidden items-center sm:flex">
            {headerNav}
          </nav>
        )}
      </div>

      {/* Right: status slot + network badge + app-specific actions (desktop only) */}
      <div className="hidden shrink-0 items-center gap-3 sm:flex">
        {headerStatus && <div className="flex h-full items-center">{headerStatus}</div>}
        <Tag label={network} />
        {headerRight}
      </div>
    </header>
  )
}
