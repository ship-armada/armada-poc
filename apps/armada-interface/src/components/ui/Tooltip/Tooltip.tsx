// ABOUTME: Hover/focus tooltip — centered (short copy) or rich (title, description, bullets). Matches armada-crowdfund.
// ABOUTME: Wrap the trigger (e.g. info icon button); popover is positioned above the trigger.

import { useState, useRef, useId, type ReactNode, type KeyboardEvent } from 'react'
import styles from './Tooltip.module.css'

interface TooltipSimpleProps {
  variant: 'centered'
  content: string
  children: ReactNode
}

interface TooltipRichProps {
  variant: 'rich'
  title: string
  description?: string
  bullets?: string[]
  children: ReactNode
}

export type TooltipProps = TooltipSimpleProps | TooltipRichProps

export function Tooltip(props: TooltipProps) {
  const [visible, setVisible] = useState(false)
  const tooltipId = useId()
  const triggerRef = useRef<HTMLSpanElement>(null)

  const show = () => setVisible(true)
  const hide = () => setVisible(false)

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      setVisible(false)
      triggerRef.current?.focus()
    }
  }

  return (
    <span
      className={styles.wrapper}
      onMouseEnter={show}
      onMouseLeave={hide}
      onFocus={show}
      onBlur={hide}
      onKeyDown={handleKeyDown}
      ref={triggerRef}
      tabIndex={0}
      aria-describedby={visible ? tooltipId : undefined}
    >
      {props.children}

      {visible && (
        <span
          id={tooltipId}
          className={[
            styles.tooltip,
            props.variant === 'centered' ? styles.centered : styles.rich,
          ].join(' ')}
          role="tooltip"
        >
          {props.variant === 'centered' && (
            <p className={styles.centeredText}>{props.content}</p>
          )}

          {props.variant === 'rich' && (
            <>
              <p className={styles.title}>{props.title}</p>
              {props.description && (
                <p className={styles.description}>{props.description}</p>
              )}
              {props.bullets && props.bullets.length > 0 && (
                <ul className={styles.bulletList}>
                  {props.bullets.map((b, i) => (
                    <li key={i} className={styles.bulletItem}>
                      <span className={styles.bulletDot} aria-hidden="true" />
                      <span className={styles.bulletText}>{b}</span>
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
        </span>
      )}
    </span>
  )
}
