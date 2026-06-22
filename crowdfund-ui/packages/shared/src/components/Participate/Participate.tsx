// ABOUTME: Ported byte-identical from the armada-crowdfund mockup (components/Participate/Participate.tsx).
// ABOUTME: Internal paths rewritten — @armada/ui primitives via package barrel; cross-folder refs use crowdfund-shared relative paths.

import { XMarkIcon } from '@heroicons/react/24/outline'
import { Button } from '@armada/ui'
import { useEffect, useRef, useState } from 'react'
import styles from './Participate.module.css'

export interface ParticipateProps {
  eyebrow?: string
  heading?: string
  ctaLabel?: string
  imageSrc?: string
  hoverImageSrc?: string
  videoSrc?: string
  onCtaClick?: () => void
  onClose?: () => void
  className?: string
  headingClassName?: string
  ctaClassName?: string
  /** Defaults to true to match the original card design. */
  buttonFullWidth?: boolean
}

export function Participate({
  eyebrow = 'Participate now',
  heading = 'Join the fleet',
  ctaLabel = 'Participate',
  imageSrc,
  hoverImageSrc,
  videoSrc,
  onCtaClick,
  onClose,
  className,
  headingClassName,
  ctaClassName,
  buttonFullWidth = true,
}: ParticipateProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const [videoReady, setVideoReady] = useState(false)
  const [isHovered, setIsHovered] = useState(false)

  useEffect(() => {
    // Ensure stopped by default on mount / src changes.
    const v = videoRef.current
    if (!v) return
    v.pause()
    try {
      v.currentTime = 0
    } catch {
      // ignore
    }
  }, [videoSrc])

  const play = () => {
    setIsHovered(true)
    const v = videoRef.current
    if (!v) return
    // preload="none": the media isn't fetched until first interaction. Kick off
    // loading on hover; onLoadedData plays it once buffered (if still hovered).
    if (videoReady) {
      void v.play()
    } else {
      v.load()
    }
  }

  const stop = () => {
    setIsHovered(false)
    const v = videoRef.current
    if (!v) return
    v.pause()
    try {
      v.currentTime = 0
    } catch {
      // ignore
    }
  }

  const handleCardKey = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      onCtaClick?.()
    }
  }

  return (
    <div
      className={[styles.card, className].filter(Boolean).join(' ')}
      onMouseEnter={play}
      onMouseLeave={stop}
      onFocus={play}
      onBlur={stop}
      role={onCtaClick ? 'button' : undefined}
      tabIndex={onCtaClick ? 0 : undefined}
      aria-label={onCtaClick ? `${ctaLabel}: ${heading}` : undefined}
      onClick={onCtaClick}
      onKeyDown={onCtaClick ? handleCardKey : undefined}
    >
      {/* Static image base layer — always rendered when provided. It's the
          card background before the video lazy-loads on hover (preload="none"),
          and shows through whenever the video isn't playing (the video sits on
          top at opacity 0 until ready). */}
      {imageSrc && (
        <img
          src={hoverImageSrc && isHovered ? hoverImageSrc : imageSrc}
          alt=""
          className={styles.img}
          aria-hidden
        />
      )}

      {videoSrc && (
        <video
          ref={videoRef}
          className={[styles.video, videoReady ? styles.videoReady : ''].filter(Boolean).join(' ')}
          src={videoSrc}
          poster={imageSrc}
          muted
          loop
          playsInline
          preload="none"
          onLoadedData={(e) => {
            const v = e.currentTarget
            setVideoReady(true)
            // If the user is still hovering when buffering finishes, start
            // playing; otherwise leave it reset at the first frame.
            if (isHovered) {
              void v.play()
            } else {
              v.pause()
              try {
                v.currentTime = 0
              } catch {
                // ignore
              }
            }
          }}
          aria-hidden="true"
        />
      )}

      <div className={styles.overlay} />

      {onClose && (
        <button
          className={styles.close}
          // Stop propagation so closing the card doesn't also trigger the
          // outer card's `onCtaClick` via bubbling.
          onClick={(e) => {
            e.stopPropagation()
            onClose()
          }}
          aria-label="Close"
        >
          <XMarkIcon width={16} height={16} aria-hidden />
        </button>
      )}

      <p className={styles.eyebrow}>{eyebrow}</p>
      <h2 className={[styles.heading, headingClassName].filter(Boolean).join(' ')}>{heading}</h2>
      {/* Wrap the visible Button so a click on it doesn't fire `onCtaClick`
       *  twice (once for the Button, once for the card via bubbling). The
       *  Button still handles its own click; this just stops the bubble. */}
      <div
        className={[styles.cta, ctaClassName].filter(Boolean).join(' ')}
        onClick={(e) => e.stopPropagation()}
      >
        <Button
          variant="gradient"
          size="md"
          label={ctaLabel}
          showIcon
          icon="arrow-right-micro"
          onClick={onCtaClick}
          style={buttonFullWidth ? { width: '100%' } : undefined}
        />
      </div>
    </div>
  )
}
