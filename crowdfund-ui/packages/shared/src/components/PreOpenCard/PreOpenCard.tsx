// ABOUTME: Hero card shown before the commit window opens — a live countdown to the opening.
// ABOUTME: Takes the Participate card's slot (same fleet surface) and links Discord / X to follow along.

import { useEffect, useState } from 'react'
import { formatOpensAtDetail, formatOpensCountdown } from '../../lib/format'
import { DISCORD_URL, X_URL } from '../../lib/socials'
import { DiscordIcon, XIcon } from '../UsefulLinks/UsefulLinks'
import styles from './PreOpenCard.module.css'

export interface PreOpenCardProps {
  /** Commit-window opening on the device clock (unix seconds). */
  opensAtUnix: number
  /** Background image (the hero passes the Participate card's fleet image). */
  imageSrc?: string
  className?: string
}

export function PreOpenCard({ opensAtUnix, imageSrc, className }: PreOpenCardProps) {
  const [nowMs, setNowMs] = useState(() => Date.now())
  const remaining = opensAtUnix - Math.floor(nowMs / 1000)
  const opened = remaining <= 0

  // Tick once a second until the opening; stop once it's reached.
  useEffect(() => {
    if (opened) return
    const id = window.setInterval(() => setNowMs(Date.now()), 1000)
    return () => window.clearInterval(id)
  }, [opensAtUnix, opened])

  const countdown = formatOpensCountdown(remaining)
  const opensAt = formatOpensAtDetail(opensAtUnix)

  return (
    <section
      className={[styles.card, className].filter(Boolean).join(' ')}
      aria-label="Sale opens soon"
    >
      {imageSrc && <img src={imageSrc} alt="" className={styles.img} aria-hidden />}
      <div className={styles.overlay} />

      <div className={styles.body}>
        <p className={styles.eyebrow}>The sale opens in</p>
        {/* Once the counter hits zero the page flips to the live sale on the
            next chain poll; until then say so rather than show 00s. */}
        <p className={styles.countdown} role="timer">
          {countdown || 'Opening now'}
        </p>
        {opensAt && <p className={styles.opensAt}>{opensAt}</p>}
      </div>

      <div className={styles.follow}>
        <p className={styles.followLabel}>Follow along</p>
        <div className={styles.links}>
          <a
            className={styles.link}
            href={DISCORD_URL}
            target="_blank"
            rel="noopener noreferrer"
            aria-label="Discord (opens in a new tab)"
          >
            <DiscordIcon className={styles.icon} />
          </a>
          <a
            className={styles.link}
            href={X_URL}
            target="_blank"
            rel="noopener noreferrer"
            aria-label="X (opens in a new tab)"
          >
            <XIcon className={styles.icon} />
          </a>
        </div>
      </div>
    </section>
  )
}
