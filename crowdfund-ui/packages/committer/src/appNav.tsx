// ABOUTME: Shared page-nav types + component and the dev-only ?mock parser.
// ABOUTME: Left tabs: Crowdfund, Your position, Claim (Your position disabled pre-open; Claim until claim opens).

import { cn } from '@armada/crowdfund-shared'
import { NavBar, type NavBarItem } from '@armada/ui'

export type ActionTab = 'commit' | 'invite'
export type Page = 'network' | 'participate' | 'claim' | 'my-position' | 'observe'

const NAV_ITEMS: ReadonlyArray<{ id: Page; label: string }> = [
  { id: 'network', label: 'Crowdfund' },
  { id: 'my-position', label: 'Your position' },
  { id: 'claim', label: 'Claim' },
]

/**
 *  Page navigation — renders as header nav on desktop, stacked list on mobile.
 *
 *  Tabs: Crowdfund · My position · Claim. Claim opens a modal — never treated
 *  as the selected page tab. Claim stays in the strip but is disabled until
 *  the claim phase opens (`claimEnabled`). Your position is disabled before
 *  the commit window opens (`myPositionEnabled`) — there's no position yet.
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
    return <NavBar items={items} />
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
