// ABOUTME: Shared application shell — delegates the header to AppHeader, owns body wrap + default footer.
// ABOUTME: Consumed by observer and committer apps. Admin keeps its own layout (out of scope).

import { type ReactNode } from 'react'
import { Diamond } from 'lucide-react'
import { Separator } from './ui/separator.js'
import { AppHeader } from './AppHeader.js'

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
  /**
   * Full-bleed layout for Hero-style pages. Skips the `pt-20` clearance on
   * `<main>` (the slotted page handles its own layout against the floating
   * header) and omits the footer entirely. Use when wrapping CrowdfundExperience
   * or any other component that positions its own internal full-viewport shell.
   */
  bare?: boolean
  children: ReactNode
}

// Shared is a library package without a vite-env.d.ts, so `import.meta.env` is not typed.
// Consuming apps (observer, committer) inject `VITE_APP_VERSION` via Vite's `define` block at build time.
const viteEnv = (import.meta as unknown as { env?: Record<string, string | undefined> }).env

// Currently unrendered — page-level footer is hidden across all apps (see
// the commented-out call site in `AppShell` below). Kept in source so
// flipping the footer back on is a one-line revert. Marked `export` purely
// so `noUnusedLocals` doesn't flag the dormant helper; it isn't re-exported
// from the package barrel and shouldn't be consumed externally.
export function DefaultFooter({
  network,
  appName,
}: {
  network: AppShellNetwork
  appName: string
}) {
  const version = viteEnv?.VITE_APP_VERSION ?? 'dev'
return (
<footer className="mt-12 border-t border-border/60">
<div className="container mx-auto flex flex-col items-center justify-between gap-2 px-4 py-5 text-muted-foreground sm:flex-row">
<div className="flex items-center gap-2.5">
<Diamond className="size-3 text-primary/70" aria-hidden="true" />
<span className="text-foreground/70">
ARMADA
</span>
<Separator orientation="vertical" className="h-3" />
<span className="">{appName}</span>
<Separator orientation="vertical" className="h-3" />
<span className="">{network}</span>
<Separator orientation="vertical" className="h-3" />
<span className="">v{version}</span>
</div>
<a
href="https://github.com/ship-armada/taipei"
target="_blank"
rel="noopener noreferrer"
className="transition-colors hover:text-foreground"
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
bare,
children,
}: AppShellProps) {
  return (
    <div className="flex min-h-screen flex-col text-foreground">
      <AppHeader
        appName={appName}
        network={network}
        headerNav={headerNav}
        headerStatus={headerStatus}
        headerRight={headerRight}
        mobileMenu={mobileMenu}
      />

      {/* pt-20 clears the inset AppHeader (top-6 + h-14 = 24 + 56 = 80px). Bare
          mode (Hero / CrowdfundExperience-style pages) drops the padding because
          the child handles its own positioning relative to the floating header. */}
      <main className={bare ? 'flex-1' : 'flex-1 pt-20'}>{children}</main>

      {/*
        Page-level footer is currently hidden across all apps. The
        `DefaultFooter` helper is preserved below in this file (and the
        consumer-provided `footer` slot still flows through `AppShellProps`),
        so flipping this back on is a one-line revert. Restore by replacing
        this block with:

          {bare ? null : footer === undefined ? (
            <DefaultFooter network={network} appName={appName} />
          ) : (
            footer
          )}
      */}
      {/* eslint-disable-next-line @typescript-eslint/no-unused-expressions */}
      {bare || footer === undefined ? null : footer}
    </div>
  )
}
