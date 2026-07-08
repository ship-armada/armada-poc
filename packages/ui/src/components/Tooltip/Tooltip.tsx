// ABOUTME: Hover/focus tooltip with two variants — centered (single line) and rich (title + description + bullets).
// ABOUTME: Ported byte-identical from the armada-crowdfund mockup; props interfaces promoted to `export` so consumers can import them.

import { useState, useRef, useId } from 'react'
import styles from './Tooltip.module.css'

/** Which side of the trigger the popover opens toward. Defaults to 'top'
 *  (the mockup's only behavior); 'bottom' opens downward, for triggers near a
 *  clipping ancestor's top edge (e.g. a tag inside an `overflow: hidden` card). */
export type TooltipPlacement = 'top' | 'bottom'

export interface TooltipSimpleProps {
  variant: 'centered'
  content: string
  placement?: TooltipPlacement
  children: React.ReactNode
}

export interface TooltipRichProps {
  variant: 'rich'
  title: string
  description?: string
  bullets?: string[]
  placement?: TooltipPlacement
  children: React.ReactNode
}

export type TooltipProps = TooltipSimpleProps | TooltipRichProps

export default function Tooltip(props: TooltipProps) {
  const [visible, setVisible] = useState(false)
  const tooltipId = useId()
  const triggerRef = useRef<HTMLDivElement>(null)

  const show = () => setVisible(true)
  const hide = () => setVisible(false)

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      setVisible(false)
      triggerRef.current?.focus()
    }
  }

  return (
    <div
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
        <div
          id={tooltipId}
          className={[
            styles.tooltip,
            props.variant === 'centered' ? styles.centered : styles.rich,
            props.placement === 'bottom' && styles.below,
          ]
            .filter(Boolean)
            .join(' ')}
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
        </div>
      )}
    </div>
  )
}
