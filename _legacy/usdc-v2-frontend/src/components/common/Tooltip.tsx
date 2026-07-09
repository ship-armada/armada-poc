import { useState, useRef, useEffect } from 'react'
import { createPortal } from 'react-dom'
import { cn } from '@/lib/utils'

interface TooltipProps {
  children: React.ReactNode
  content: React.ReactNode
  side?: 'top' | 'bottom' | 'left' | 'right'
  className?: string
}

export function Tooltip({ children, content, side = 'top', className }: TooltipProps) {
  const [isVisible, setIsVisible] = useState(false)
  const [position, setPosition] = useState({ top: 0, left: 0 })
  const triggerRef = useRef<HTMLDivElement>(null)
  const tooltipRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (isVisible && triggerRef.current && tooltipRef.current) {
      const trigger = triggerRef.current
      const tooltip = tooltipRef.current
      const triggerRect = trigger.getBoundingClientRect()
      const tooltipRect = tooltip.getBoundingClientRect()
      
      let top = 0
      let left = 0
      
      switch (side) {
        case 'top':
          top = triggerRect.top - tooltipRect.height - 8
          left = triggerRect.left + triggerRect.width / 2 - tooltipRect.width / 2
          break
        case 'bottom':
          top = triggerRect.bottom + 8
          left = triggerRect.left + triggerRect.width / 2 - tooltipRect.width / 2
          break
        case 'left':
          top = triggerRect.top + triggerRect.height / 2 - tooltipRect.height / 2
          left = triggerRect.left - tooltipRect.width - 8
          break
        case 'right':
          top = triggerRect.top + triggerRect.height / 2 - tooltipRect.height / 2
          left = triggerRect.right + 8
          break
      }
      
      // Adjust if tooltip would go off screen
      const padding = 8
      if (top < padding) {
        // Switch to bottom if not enough space on top
        top = triggerRect.bottom + 8
      }
      if (top + tooltipRect.height > window.innerHeight - padding) {
        // Switch to top if not enough space on bottom
        top = triggerRect.top - tooltipRect.height - 8
      }
      if (left < padding) {
        left = padding
      }
      if (left + tooltipRect.width > window.innerWidth - padding) {
        left = window.innerWidth - tooltipRect.width - padding
      }
      
      setPosition({ top, left })
    }
  }, [isVisible, side])

  return (
    <>
      <div
        ref={triggerRef}
        className="inline-block"
        onMouseEnter={() => setIsVisible(true)}
        onMouseLeave={() => setIsVisible(false)}
      >
        {children}
      </div>
      {isVisible &&
        createPortal(
          <div
            ref={tooltipRef}
            className={cn(
              'fixed z-[9999] px-3 py-2 text-xs bg-card text-card-foreground rounded-md shadow-lg border border-border/20',
              'whitespace-nowrap pointer-events-none',
              className
            )}
            style={{
              top: `${position.top}px`,
              left: `${position.left}px`,
            }}
          >
            {content}
            {/* Arrow */}
            <div
              className={cn(
                'absolute w-2 h-2 bg-card border border-border/20 rotate-45',
                side === 'top' && 'top-full left-1/2 -translate-x-1/2 -translate-y-1/2',
                side === 'bottom' && 'bottom-full left-1/2 -translate-x-1/2 translate-y-1/2',
                side === 'left' && 'left-full top-1/2 -translate-x-1/2 -translate-y-1/2',
                side === 'right' && 'right-full top-1/2 translate-x-1/2 -translate-y-1/2'
              )}
            />
          </div>,
          document.body
        )}
    </>
  )
}

