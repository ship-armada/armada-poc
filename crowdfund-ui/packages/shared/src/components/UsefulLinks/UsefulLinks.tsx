// ABOUTME: Post-commit / post-claim useful-link icon grid (Governance, X, Blog, Discord).
// ABOUTME: Eyebrow + icon tiles; opens each destination in a new tab.

import type { SVGProps } from 'react'
import { ChatBubbleLeftRightIcon, NewspaperIcon } from '@heroicons/react/24/outline'
import { DISCORD_URL, X_URL } from '../../lib/socials'
import styles from './UsefulLinks.module.css'

export function DiscordIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden {...props}>
      <path d="M20.317 4.37a19.791 19.791 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028 14.09 14.09 0 0 0 1.226-1.994.076.076 0 0 0-.041-.106 13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.292.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.299 12.299 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03zM8.02 15.33c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.956 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.946 2.418-2.157 2.418z" />
    </svg>
  )
}

export function XIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden {...props}>
      <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-4.714-6.231-5.401 6.231H2.744l7.227-8.451L1.5 2.25h7.08l4.263 5.671L18.244 2.25zm-1.161 17.52h1.833L7.084 4.126H5.117L17.083 19.77z" />
    </svg>
  )
}

const RESOURCE_LINKS = [
  {
    label: 'Governance',
    // TODO: replace when the governance forum URL is ready.
    href: 'https://docs.armada.blue/',
    Icon: ChatBubbleLeftRightIcon,
  },
  {
    label: 'Twitter',
    href: X_URL,
    Icon: XIcon,
  },
  {
    label: 'Blog',
    href: 'https://armada.ghost.io',
    Icon: NewspaperIcon,
  },
  {
    label: 'Discord',
    href: DISCORD_URL,
    Icon: DiscordIcon,
  },
] as const

export interface UsefulLinksProps {
  /** Optional id prefix for the eyebrow heading. */
  headingId?: string
}

export function UsefulLinks({ headingId = 'useful-links' }: UsefulLinksProps) {
  return (
    <section className={styles.root} aria-labelledby={headingId}>
      <h3 id={headingId} className={styles.eyebrow}>
        Useful links
      </h3>
      <nav className={styles.nav} aria-label="Useful links">
        <ul className={styles.list}>
          {RESOURCE_LINKS.map(({ label, href, Icon }) => (
            <li key={href} className={styles.item}>
              <a
                className={styles.link}
                href={href}
                target="_blank"
                rel="noopener noreferrer"
              >
                <span className={styles.tile}>
                  <Icon className={styles.icon} aria-hidden />
                  <span className={styles.label}>
                    {label}
                    <span className={styles.visuallyHidden}> (opens in a new tab)</span>
                  </span>
                </span>
              </a>
            </li>
          ))}
        </ul>
      </nav>
    </section>
  )
}
