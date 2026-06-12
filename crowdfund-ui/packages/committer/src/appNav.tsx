// ABOUTME: Shared page-nav types + component and the dev-only ?mock parser.
// ABOUTME: Extracted from App so the lazy-loaded MockCommitterApp can reuse them without a circular import.

import { cn } from '@armada/crowdfund-shared'
import { NavBar, type NavBarItem } from '@armada/ui'
import { DiscordIcon, XIcon } from '@/components/SocialIcons'
import { DISCORD_URL, X_URL } from '@/config/socials'

export type ActionTab = 'commit' | 'invite'
export type Page = 'network' | 'participate' | 'claim' | 'my-position'

const PROJECT_URL = 'https://armada.wtf'

const HORIZONTAL_NAV_ITEMS: ReadonlyArray<{ id: Page | 'project'; label: string }> = [
  { id: 'project', label: 'The project' },
  { id: 'network', label: 'Crowdfund' },
]

const MOBILE_NAV_ITEMS: ReadonlyArray<{ id: Page; label: string }> = [
  { id: 'network', label: 'Crowdfund' },
  { id: 'my-position', label: 'My position' },
  { id: 'claim', label: 'Claim' },
]

/**
 *  Page navigation — renders as header nav on desktop, stacked list on mobile.
 *
 *  Horizontal variant: pill nav from @armada/ui (NavBar + NavItem) matching
 *  the armada-crowdfund mockup's Hero layout (Project + Crowdfund only).
 *  Vertical variant (mobile sheet) shows every destination since the desktop
 *  right-side action buttons are hidden below sm.
 */
export function PageNav({
  current,
  onChange,
  orientation = 'horizontal',
}: {
  current: Page
  onChange: (p: Page) => void
  orientation?: 'horizontal' | 'vertical'
}) {
  if (orientation === 'horizontal') {
    const items: NavBarItem[] = HORIZONTAL_NAV_ITEMS.map((item) => {
      // Extract `id` to a local so the narrowed type carries through the
      // closure passed to NavBar — narrowing inside `.map` doesn't propagate
      // into onClick otherwise (TS sees the wider `Page | 'project'`).
      const id = item.id
      if (id === 'project') {
        return {
          label: item.label,
          onClick: () => window.open(PROJECT_URL, '_blank', 'noopener,noreferrer'),
        }
      }
      return {
        label: item.label,
        active: id === current,
        onClick: () => onChange(id),
      }
    })
    return (
      <div className="flex items-center gap-4">
        <NavBar items={items} />
        {/* Socials, to the right of the Crowdfund nav. */}
        <div className="flex items-center gap-3">
          <a
            href={DISCORD_URL}
            target="_blank"
            rel="noopener noreferrer"
            aria-label="Armada on Discord"
            className="text-muted-foreground transition-colors hover:text-foreground"
          >
            <DiscordIcon className="size-[18px]" />
          </a>
          <a
            href={X_URL}
            target="_blank"
            rel="noopener noreferrer"
            aria-label="Armada on X"
            className="text-muted-foreground transition-colors hover:text-foreground"
          >
            <XIcon className="size-[18px]" />
          </a>
        </div>
      </div>
    )
  }

  return (
    <ul className="flex flex-col items-stretch gap-1">
      <li>
        <a
          href={PROJECT_URL}
          target="_blank"
          rel="noopener noreferrer"
          className={cn(
            'block w-full rounded-md px-3 py-1.5 text-left text-muted-foreground transition-colors hover:text-foreground',
          )}
        >
          The project
        </a>
      </li>
      {MOBILE_NAV_ITEMS.map((item) => {
        const active = item.id === current
        return (
          <li key={item.id}>
            <button
              type="button"
              onClick={() => onChange(item.id)}
              aria-current={active ? 'page' : undefined}
              className={cn(
                'w-full rounded-md px-3 py-1.5 text-left transition-colors hover:text-foreground',
                active ? 'bg-muted/60 text-foreground' : 'text-muted-foreground',
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
