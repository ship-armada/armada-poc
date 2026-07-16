// ABOUTME: Minimal global footer — a centered row of social/homepage icon links (Discord, X, website).
// ABOUTME: Each link renders only when its URL is set in SOCIAL_LINKS, so an unconfigured link never shows.

import { Globe } from 'lucide-react'
import type { ComponentType } from 'react'
import styles from './AppFooter.module.css'

/** Discord mark (inline — lucide dropped brand glyphs). currentColor fill, sized by the parent. */
function DiscordIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M20.317 4.369A19.79 19.79 0 0 0 15.432 3a.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.249a18.27 18.27 0 0 0-5.487 0 12.6 12.6 0 0 0-.617-1.25.077.077 0 0 0-.079-.036A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028c.462-.63.874-1.295 1.226-1.994a.076.076 0 0 0-.041-.106 13.1 13.1 0 0 1-1.872-.892.077.077 0 0 1-.008-.128c.126-.094.252-.192.371-.291a.074.074 0 0 1 .078-.01c3.927 1.793 8.18 1.793 12.061 0a.074.074 0 0 1 .079.009c.12.099.245.198.372.292a.077.077 0 0 1-.006.127 12.3 12.3 0 0 1-1.873.891.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.84 19.84 0 0 0 6.002-3.03.077.077 0 0 0 .032-.055c.5-5.177-.838-9.674-3.549-13.66a.06.06 0 0 0-.031-.028ZM8.02 15.331c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.956 2.418-2.157 2.418Zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.946 2.418-2.157 2.418Z" />
    </svg>
  )
}

/** X (formerly Twitter) mark (inline). currentColor fill. */
function XIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231Zm-1.161 17.52h1.833L7.084 4.126H5.117Z" />
    </svg>
  )
}

interface SocialLink {
  readonly label: string
  readonly href: string
  readonly Icon: ComponentType
}

/**
 * Footer link targets. Leave a `href` as '' to hide that link (the footer only renders links with
 * a non-empty URL). Homepage uses lucide's `Globe`; the brand marks are inline SVGs.
 */
const SOCIAL_LINKS: ReadonlyArray<SocialLink> = [
  { label: 'Discord', href: 'https://discord.gg/NxDyA2EDm', Icon: DiscordIcon },
  { label: 'X (Twitter)', href: 'https://x.com/ship_armada', Icon: XIcon },
  { label: 'Website', href: 'https://armada.wtf', Icon: Globe },
]

export function AppFooter() {
  const links = SOCIAL_LINKS.filter((l) => l.href)
  if (links.length === 0) return null

  return (
    <footer className={styles.footer}>
      <nav className={styles.links} aria-label="Social and homepage links">
        {links.map(({ label, href, Icon }) => (
          <a
            key={label}
            href={href}
            target="_blank"
            rel="noopener noreferrer"
            aria-label={label}
            title={label}
            className={styles.link}
          >
            <Icon />
          </a>
        ))}
      </nav>
    </footer>
  )
}
