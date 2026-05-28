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
    if (!v || !videoReady) return
    void v.play()
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

  return (
    <div
      className={[styles.card, className].filter(Boolean).join(' ')}
      onMouseEnter={play}
      onMouseLeave={stop}
      onFocus={play}
      onBlur={stop}
    >
      {videoSrc && (
        <video
          ref={videoRef}
          className={[styles.video, videoReady ? styles.videoReady : ''].filter(Boolean).join(' ')}
          src={videoSrc}
          muted
          loop
          playsInline
          preload="auto"
          onLoadedData={(e) => {
            const v = e.currentTarget
            v.pause()
            try {
              v.currentTime = 0
            } catch {
              // ignore
            }
            setVideoReady(true)
          }}
          aria-hidden="true"
        />
      )}

      {/* Fallback: if no video, use static/hover image swap */}
      {!videoSrc && imageSrc && (
        <img
          src={hoverImageSrc && isHovered ? hoverImageSrc : imageSrc}
          alt=""
          className={styles.img}
        />
      )}
      <div className={styles.overlay} />

      {onClose && (
        <button className={styles.close} onClick={onClose} aria-label="Close">
          <XMarkIcon width={16} height={16} aria-hidden />
        </button>
      )}

      <p className={styles.eyebrow}>{eyebrow}</p>
      <h2 className={[styles.heading, headingClassName].filter(Boolean).join(' ')}>{heading}</h2>
      <div className={[styles.cta, ctaClassName].filter(Boolean).join(' ')}>
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
