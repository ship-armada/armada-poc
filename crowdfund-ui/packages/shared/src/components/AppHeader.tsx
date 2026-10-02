// ABOUTME: Shared app header — fixed 56px bar with ArmadaLogo, logo-adjacent nav, and slotted chrome.
// ABOUTME: Hero mobile: in-flow logo + wallet circle / Connect + nav pills (no sticky burger); Claim stays a modal tab.

import { cloneElement, isValidElement, useState, type ReactNode } from 'react'
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
   * Desktop-only primary navigation (≥md), rendered inline to the right of the
   * logo. On hero mobile (`scrollWithPageOnMobile`), the same node also renders
   * as in-flow nav pills under the header bar.
   */
  headerNav?: ReactNode
  /**
   * Desktop-only inline status indicator (≥sm), rendered between the primary
   * nav and the right-side chrome. Use for compact, contextual info like a
   * campaign-lifecycle stepper.
   */
  headerStatus?: ReactNode
  /**
   * Desktop-only header actions (≥md). Wallet button, secondary controls, etc.
   * Hidden below the md breakpoint — compose anything the user still needs on
   * mobile into `mobileMenu` / `mobileActions` instead.
   */
  headerRight?: ReactNode
  /**
   * Mobile menu contents, rendered full-screen when the hamburger is tapped.
   * Used on non-hero layouts. Omit (or pair with `scrollWithPageOnMobile` +
   * `mobileActions`) to suppress the hamburger entirely.
   * May be a node, or a render function receiving a `close` callback so menu
   * actions can dismiss the Sheet.
   */
  mobileMenu?: ReactNode | ((close: () => void) => ReactNode)
  /**
   * Hero mobile actions (wallet circle / Connect). Shown only when
   * `scrollWithPageOnMobile` is set, in place of the burger menu.
   */
  mobileActions?: ReactNode
  /**
   * Hero / bare pages: on ≤767px the header sits in document flow and scrolls
   * with the page (designer `Header.module.css` `.headerHero`), instead of
   * staying fixed over the stack. Desktop keeps the floating inset bar.
   * Mobile also renders `headerNav` as in-flow pills under the logo row —
   * no sticky frosted bar.
   */
  scrollWithPageOnMobile?: boolean
  className?: string
}

export function AppHeader({
  appName,
  network,
  headerNav,
  headerStatus,
  headerRight,
  mobileMenu,
  mobileActions,
  scrollWithPageOnMobile,
  className,
}: AppHeaderProps) {
  const [menuOpen, setMenuOpen] = useState(false)
  const heroMobile = !!scrollWithPageOnMobile
  const showBurger = !heroMobile && mobileMenu !== undefined
  // Same element can't mount in two places — clone for the mobile strip.
  const mobileHeaderNav =
    headerNav && isValidElement(headerNav) ? cloneElement(headerNav) : headerNav

  return (
    <>
      <header
        className={cn(
          // Inset 24px from top + each side, matching the designer's Hero page
          // (Hero.module.css `.headerOverride`) and the @armada/ui showcase.
          // Transparent — the body's radial gradient and content show through
          // unobstructed. Consumers needing contrast under busy content can add
          // their own bg via className.
          'fixed inset-x-6 top-6 z-40 flex h-14 items-center justify-between',
          // Crowdfund hero mobile — relative transparent bar that scrolls away
          // with content (Header.module.css `.headerHero` — no frosted sticky).
          heroMobile &&
            'max-[767px]:relative max-[767px]:inset-x-0 max-[767px]:top-0 max-[767px]:h-auto max-[767px]:min-h-[calc(2rem+var(--primitives-spacing-5))] max-[767px]:w-full max-[767px]:box-border max-[767px]:px-5 max-[767px]:pt-5 max-[767px]:pb-0 max-[767px]:bg-transparent max-[767px]:backdrop-blur-none',
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

        {/* Right: desktop chrome (≥md) + mobile wallet/burger */}
        <div className="flex shrink-0 items-center gap-3">
          <div className="hidden items-center gap-3 md:flex">
            {headerStatus && <div className="flex h-full items-center">{headerStatus}</div>}
            <Tag label={network} />
            {headerRight}
          </div>

          {heroMobile && mobileActions ? (
            <div className="inline-flex items-center gap-3 md:hidden">{mobileActions}</div>
          ) : null}

          {showBurger ? (
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
          ) : null}
        </div>
      </header>

      {/* Hero mobile: Crowdfund · My position · Claim pills under the logo row
          (in document flow — not sticky). Hidden while a flow modal is open. */}
      {heroMobile && mobileHeaderNav ? (
        <div
          className={cn(
            'flex w-full items-center justify-stretch px-5 pb-3 pt-5 md:hidden',
            '[[data-flow-modal-open]_&]:pointer-events-none [[data-flow-modal-open]_&]:invisible',
          )}
        >
          <div className="flex h-12 w-full max-w-none items-center justify-between gap-1 p-1 [&_button]:h-[calc(var(--primitives-spacing-12)-var(--primitives-spacing-2))] [&_button]:min-w-0 [&_button]:flex-1 [&_button]:px-3 [&_button]:text-[length:calc(var(--primitives-fontSize-base)*1px)]">
            {mobileHeaderNav}
          </div>
        </div>
      ) : null}
    </>
  )
}
