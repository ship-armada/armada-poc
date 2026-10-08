// ABOUTME: Shared page-nav types + component and the dev-only ?mock parser.
// ABOUTME: Left tabs: Crowdfund, Your position, Claim (Your position disabled pre-open; Claim until claim opens),
// ABOUTME: followed by a standalone "About the crowdfund" link to the project site's crowdfund page (AboutLink, hidden below 1000px).

import { cn, useIsMobileLayout } from '@armada/crowdfund-shared'
import { NavBar, type NavBarItem } from '@armada/ui'
import { CROWDFUND_INFO_URL } from '@/config/socials'

export type ActionTab = 'commit' | 'invite'
export type Page = 'network' | 'participate' | 'claim' | 'my-position' | 'observe'

const NAV_ITEMS: ReadonlyArray<{ id: Page; label: string }> = [
  { id: 'network', label: 'Crowdfund' },
  { id: 'my-position', label: 'Your position' },
  { id: 'claim', label: 'Claim' },
]

const ABOUT_LABEL = 'About the crowdfund'

/**
 *  "About the crowdfund" — external link to the project site's crowdfund page,
 *  opening in a new tab. Deliberately styled as a plain text link outside the
 *  page-tab pill strip so it reads as leaving the app rather than as another
 *  page, in brand lavender so it stands out from the muted inactive tabs.
 *  Hidden below a 1000px-wide viewport (`max-[1000px]` is `width < 1000px` in
 *  Tailwind v4), where it crowds the header; the burger menu keeps its own entry.
 */
export function AboutLink({ className }: { className?: string }) {
  return (
    <a
      href={CROWDFUND_INFO_URL}
      target="_blank"
      rel="noopener noreferrer"
      className={cn(
        'inline-flex items-center whitespace-nowrap font-medium transition-opacity hover:opacity-80 max-[1000px]:hidden',
        'text-[length:var(--semantic-component-button-primary-md-font-size)] text-[color:var(--semantic-color-brand-lavender)]',
        className,
      )}
    >
      {ABOUT_LABEL}
    </a>
  )
}

/**
 *  Page navigation — renders as header nav on desktop, stacked list on mobile.
 *
 *  Tabs: Crowdfund · My position · Claim. Claim opens a modal — never treated
 *  as the selected page tab. Claim stays in the strip but is disabled until
 *  the claim phase opens (`claimEnabled`). Your position is disabled before
 *  the commit window opens (`myPositionEnabled`) — there's no position yet.
 *
 *  The horizontal variant follows the pill strip with AboutLink (itself hidden
 *  below 1000px). On the mobile layout (≤767px) PageNav renders the bare
 *  NavBar, keeping the full-width pill strip AppHeader builds from this same
 *  nav unchanged.
 */
export function PageNav({
  current,
  onChange,
  orientation = 'horizontal',
  claimEnabled = false,
  myPositionEnabled = true,
}: {
  current: Page
  onChange: (p: Page) => void
  orientation?: 'horizontal' | 'vertical'
  /** When false, Claim is visible but not navigable. */
  claimEnabled?: boolean
  /** When false, Your position is visible but not navigable. */
  myPositionEnabled?: boolean
}) {
  const isMobileLayout = useIsMobileLayout()
  const isDisabled = (id: Page) =>
    (id === 'claim' && !claimEnabled) || (id === 'my-position' && !myPositionEnabled)

  if (orientation === 'horizontal') {
    const items: NavBarItem[] = NAV_ITEMS.map((item) => {
      const id = item.id
      const disabled = isDisabled(id)
      return {
        label: item.label,
        // Claim opens a modal — never treat it as the selected page tab.
        active: id === 'claim' ? false : !disabled && id === current,
        disabled,
        accent: id === 'claim' && !disabled ? ('brand' as const) : undefined,
        onClick: disabled ? undefined : () => onChange(id),
      }
    })
    if (isMobileLayout) return <NavBar items={items} />
    return (
      <div className="flex items-center gap-6">
        <NavBar items={items} />
        <AboutLink />
      </div>
    )
  }

  return (
    <ul className="flex flex-col items-stretch gap-1">
      {NAV_ITEMS.map((item) => {
        const disabled = isDisabled(item.id)
        // Claim opens a modal — never treat it as the selected page tab.
        const active = item.id === 'claim' ? false : !disabled && item.id === current
        return (
          <li key={item.id}>
            <button
              type="button"
              onClick={() => {
                if (!disabled) onChange(item.id)
              }}
              disabled={disabled}
              aria-current={active ? 'page' : undefined}
              aria-disabled={disabled || undefined}
              className={cn(
                'w-full rounded-md px-3 py-1.5 text-left transition-colors',
                disabled
                  ? 'cursor-not-allowed text-muted-foreground opacity-40'
                  : active
                    ? 'bg-muted/60 text-foreground'
                    : 'text-muted-foreground hover:text-foreground',
              )}
            >
              {item.label}
            </button>
          </li>
        )
      })}
      <li>
        <a
          href={CROWDFUND_INFO_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="block w-full rounded-md px-3 py-1.5 text-left text-muted-foreground transition-colors hover:text-foreground"
        >
          {ABOUT_LABEL}
        </a>
      </li>
    </ul>
  )
}

/**
 * Dev-only stress harness size from `?mock=stressN`. Returns 0 (disabled) in
 * production so a prod origin can never render a synthetic full-looking sale.
 */
export function getMockSizeFromUrl(): number {
  if (!import.meta.env.DEV) return 0
  if (typeof window === 'undefined') return 0
  const p = new URLSearchParams(window.location.search).get('mock')
  if (!p) return 0
  const n = parseInt(p.replace(/^stress/, ''), 10)
  return Number.isFinite(n) && n > 0 ? n : 0
}
