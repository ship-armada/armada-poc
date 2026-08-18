// ABOUTME: Fixed top-edge gradient that fades in once the dashboard is scrolled (desktop only).
// ABOUTME: Ported from the armada-app design mockup.
import { useEffect, useState, type CSSProperties } from 'react'
import { ACTIVITY_LIST_FADE_HEIGHT_PX } from '@/constants/activityList'
import { useMobileLayout } from '@/hooks/useMobileLayout'
import styles from './DashboardScrollTopFade.module.css'

export interface DashboardScrollTopFadeProps {
  enabled: boolean
}

export function DashboardScrollTopFade({ enabled }: DashboardScrollTopFadeProps) {
  const isMobile = useMobileLayout()
  const [visible, setVisible] = useState(false)

  useEffect(() => {
    if (!enabled || isMobile) {
      setVisible(false)
      return
    }

    function update() {
      const canScroll = document.documentElement.scrollHeight > window.innerHeight + 1
      setVisible(canScroll && window.scrollY > 0)
    }

    update()
    window.addEventListener('scroll', update, { passive: true })
    window.addEventListener('resize', update)
    return () => {
      window.removeEventListener('scroll', update)
      window.removeEventListener('resize', update)
    }
  }, [enabled, isMobile])

  if (isMobile) return null

  return (
    <div
      className={[styles.fade, visible && styles.fadeVisible].filter(Boolean).join(' ')}
      style={{ '--dashboard-top-fade-height': `${ACTIVITY_LIST_FADE_HEIGHT_PX}px` } as CSSProperties}
      aria-hidden
    />
  )
}
