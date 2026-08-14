// ABOUTME: Hover/focus tooltip with centered, rich, and action variants.
// ABOUTME: Ported from the armada-app design mockup.
import { useState, useRef, useId } from 'react'
import styles from './Tooltip.module.css'

interface TooltipSimpleProps {
  variant: 'centered'
  content: string
  children: React.ReactNode
}

interface TooltipRichProps {
  variant: 'rich'
  title: string
  description?: string
  bullets?: string[]
  children: React.ReactNode
}

interface TooltipActionProps {
  variant: 'action'
  content: string
  children: React.ReactNode
}

type TooltipProps = TooltipSimpleProps | TooltipRichProps | TooltipActionProps

export default function Tooltip(props: TooltipProps) {
  const [visible, setVisible] = useState(false)
  const tooltipId = useId()
  const triggerRef = useRef<HTMLDivElement>(null)
  const isAction = props.variant === 'action'

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
      onFocus={isAction ? undefined : show}
      onBlur={isAction ? undefined : hide}
      onFocusCapture={isAction ? show : undefined}
      onBlurCapture={isAction ? hide : undefined}
      onKeyDown={isAction ? undefined : handleKeyDown}
      ref={triggerRef}
      tabIndex={isAction ? undefined : 0}
      aria-describedby={visible && !isAction ? tooltipId : undefined}
    >
      {props.children}

      {visible && (
        <div
          id={tooltipId}
          className={[
            styles.tooltip,
            props.variant === 'centered' && styles.centered,
            props.variant === 'rich' && styles.rich,
            props.variant === 'action' && styles.action,
          ]
            .filter(Boolean)
            .join(' ')}
          role="tooltip"
        >
          {props.variant === 'centered' && (
            <p className={styles.centeredText}>{props.content}</p>
          )}

          {props.variant === 'action' && (
            <p className={styles.actionText}>{props.content}</p>
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
