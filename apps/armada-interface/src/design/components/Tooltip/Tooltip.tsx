// ABOUTME: Hover/focus tooltip with centered, rich, and action variants.
// ABOUTME: Ported from the armada-app design mockup.
import { useEffect, useId, useRef, useState } from 'react'
import { useFineHover } from '@/hooks/useFineHover'
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
  const fineHover = useFineHover()

  const show = () => setVisible(true)
  const hide = () => setVisible(false)

  useEffect(() => {
    if (fineHover || !visible) return

    function onPointerDown(event: PointerEvent) {
      const root = triggerRef.current
      if (!root) return
      if (event.target instanceof Node && root.contains(event.target)) return
      setVisible(false)
    }

    document.addEventListener('pointerdown', onPointerDown)
    return () => document.removeEventListener('pointerdown', onPointerDown)
  }, [fineHover, visible])

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      setVisible(false)
      triggerRef.current?.focus()
    }
  }

  return (
    <div
      className={styles.wrapper}
      onMouseEnter={fineHover ? show : undefined}
      onMouseLeave={fineHover ? hide : undefined}
      onClick={fineHover ? undefined : () => setVisible((open) => !open)}
      onFocus={fineHover && !isAction ? show : undefined}
      onBlur={fineHover && !isAction ? hide : undefined}
      onFocusCapture={fineHover && isAction ? show : undefined}
      onBlurCapture={fineHover && isAction ? hide : undefined}
      onKeyDown={isAction ? undefined : handleKeyDown}
      ref={triggerRef}
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
