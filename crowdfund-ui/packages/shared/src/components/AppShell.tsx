// ABOUTME: Shared application shell — sticky header with brand + network badge + slots, plus default footer.
// ABOUTME: Consumed by observer and committer apps. Admin keeps its own layout (out of scope).

import { type ReactNode } from 'react'
import { Diamond, Menu } from 'lucide-react'
import { Badge } from './ui/badge.js'
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

/** Network identifiers the shell can render a styled badge for. Other strings fall back to a neutral badge. */
export type AppShellNetwork = 'local' | 'sepolia' | (string & {})

export interface AppShellProps {
  /** Short label displayed beside the brand (e.g. "Observer", "Committer"). */
  appName: string
  /** Network label used for the badge text and variant. */
  network: AppShellNetwork
  /**
   * Desktop-only primary navigation (≥sm), rendered between the brand and the
   * right-side chrome. Mobile navigation should be composed into `mobileMenu`.
   */
  headerNav?: ReactNode
  /**
   * Desktop-only inline status indicator (≥sm), rendered between the centered
   * primary nav and the right-side chrome. Use for compact, contextual info
   * like a campaign-lifecycle stepper. Hidden below the sm breakpoint.
   */
  headerStatus?: ReactNode
  /**
   * Desktop-only header actions (≥sm). Hidden below the sm breakpoint — compose
   * anything the user still needs on mobile into `mobileMenu` instead.
   */
  headerRight?: ReactNode
  /**
   * Mobile Sheet contents, rendered when the hamburger is tapped. Omit to
   * suppress the hamburger trigger entirely.
   */
  mobileMenu?: ReactNode
  /** Override the default footer. Pass `null` to hide the footer altogether. */
  footer?: ReactNode
  children: ReactNode
}

function NetworkBadge({ network }: { network: AppShellNetwork }) {
  const label = network.toUpperCase()
  const variant: 'secondary' | 'outline' = network === 'sepolia' ? 'outline' : 'secondary'
  return (
    <Badge
      variant={variant}
      className="h-5 rounded-md border-border/60 bg-muted/45 px-2 font-heading text-[10px] font-semibold uppercase tracking-[0.12em] text-foreground/85"
    >
      {label}
    </Badge>
  )
}

// Shared is a library package without a vite-env.d.ts, so `import.meta.env` is not typed.
// Consuming apps (observer, committer) inject `VITE_APP_VERSION` via Vite's `define` block at build time.
const viteEnv = (import.meta as unknown as { env?: Record<string, string | undefined> }).env

function DefaultFooter({
  network,
  appName,
}: {
  network: AppShellNetwork
  appName: string
}) {
  const version = viteEnv?.VITE_APP_VERSION ?? 'dev'
  return (
    <footer className="mt-12 border-t border-border/60">
      <div className="container mx-auto flex flex-col items-center justify-between gap-2 px-4 py-5 text-[11px] text-muted-foreground sm:flex-row">
        <div className="flex items-center gap-2.5">
          <Diamond className="size-3 text-primary/70" aria-hidden="true" />
          <span className="font-heading uppercase tracking-[0.22em] text-foreground/70">
            ARMADA
          </span>
          <Separator orientation="vertical" className="h-3" />
          <span className="uppercase tracking-wider">{appName}</span>
          <Separator orientation="vertical" className="h-3" />
          <span className="uppercase tracking-wider">{network}</span>
          <Separator orientation="vertical" className="h-3" />
          <span className="tabular-nums">v{version}</span>
        </div>
        <a
          href="https://github.com/ship-armada/taipei"
          target="_blank"
          rel="noopener noreferrer"
          className="uppercase tracking-wider transition-colors hover:text-foreground"
        >
          GitHub
        </a>
      </div>
    </footer>
  )
}

export function AppShell({
  appName,
  network,
  headerNav,
  headerStatus,
  headerRight,
  mobileMenu,
  footer,
  children,
}: AppShellProps) {
  return (
    <div className="flex min-h-screen flex-col text-foreground">
      <header
        className={cn(
          'sticky top-0 z-40 w-full border-b border-border/70',
          'bg-background/88 backdrop-blur supports-[backdrop-filter]:bg-background/72',
        )}
      >
        <div
          className={cn(
            'container mx-auto flex h-12 items-center gap-3 px-4',
          )}
        >
          {/* Left: hamburger (mobile) + brand */}
          <div className="flex h-full min-w-0 items-center gap-2">
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
                    <SheetTitle className="font-heading uppercase tracking-[0.22em]">ARMADA</SheetTitle>
                    <SheetDescription>{appName}</SheetDescription>
                  </SheetHeader>
                  <div className="flex flex-col gap-3 px-4 pb-4">
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-muted-foreground">Network</span>
                      <NetworkBadge network={network} />
                    </div>
                    <Separator />
                    {mobileMenu}
                  </div>
                </SheetContent>
              </Sheet>
            )}
            <div className="flex min-w-0 items-center gap-2.5">
              <span
                className="flex size-6 shrink-0 items-center justify-center rounded-full border border-primary/30 bg-primary/15 shadow-[0_0_16px_rgba(83,224,224,0.12)]"
                aria-hidden="true"
              >
                <Diamond className="size-3.5 text-primary" />
              </span>
              <span className="truncate font-heading text-[13px] font-semibold uppercase tracking-[0.14em] text-foreground/95">
                ARMADA
              </span>
            </div>
          </div>

          {/* Center: desktop-only primary nav */}
          {headerNav && (
            <nav
              aria-label="Primary"
              className="hidden h-full flex-1 justify-center sm:flex"
            >
              {headerNav}
            </nav>
          )}

          {/* Inline status indicator (desktop). Sits between the centered nav
              and the right-side chrome. Auto-width so the centered nav stays
              roughly centered (the slot adds asymmetry, but typical content
              here is narrow — a compact lifecycle stepper or similar). */}
          {headerStatus && (
            <div className="hidden h-full items-center sm:flex">{headerStatus}</div>
          )}

          {/* Right: network badge + app-specific actions (desktop only) */}
          <div className={cn('hidden items-center gap-2 sm:flex', !headerNav && 'ml-auto')}>
            <NetworkBadge network={network} />
            {headerRight}
          </div>
        </div>
      </header>

      <main className="flex-1">{children}</main>

      {footer === undefined ? <DefaultFooter network={network} appName={appName} /> : footer}
    </div>
  )
}

export { NetworkBadge }
