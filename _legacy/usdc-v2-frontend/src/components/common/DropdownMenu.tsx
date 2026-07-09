import { useState, useRef, useEffect, createContext, useContext } from 'react'
import { cn } from '@/lib/utils'

interface DropdownContextType {
  close: () => void
}

const DropdownContext = createContext<DropdownContextType | null>(null)

interface DropdownMenuProps {
  trigger: React.ReactNode
  children: React.ReactNode
  align?: 'left' | 'right'
  className?: string
}

export function DropdownMenu({ trigger, children, align = 'right', className }: DropdownMenuProps) {
  const [isOpen, setIsOpen] = useState(false)
  const dropdownRef = useRef<HTMLDivElement>(null)

  const close = () => setIsOpen(false)

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setIsOpen(false)
      }
    }

    if (isOpen) {
      document.addEventListener('mousedown', handleClickOutside)
      return () => {
        document.removeEventListener('mousedown', handleClickOutside)
      }
    }
  }, [isOpen])

  const handleTriggerClick = (e: React.MouseEvent) => {
    e.stopPropagation() // Prevent parent click handlers
    setIsOpen(!isOpen)
  }

  return (
    <DropdownContext.Provider value={{ close }}>
    <div className="relative" ref={dropdownRef}>
        <div onClick={handleTriggerClick}>{trigger}</div>
      {isOpen && (
        <div
          className={cn(
            'absolute z-50 mt-2 min-w-[200px] rounded-lg border border-border bg-background shadow-lg',
            align === 'right' ? 'right-0' : 'left-0',
            className
          )}
            onClick={(e) => e.stopPropagation()}
        >
          {children}
        </div>
      )}
    </div>
    </DropdownContext.Provider>
  )
}

interface DropdownMenuItemProps {
  children: React.ReactNode
  onClick?: () => void
  className?: string
  stopPropagation?: boolean
}

export function DropdownMenuItem({ children, onClick, className, stopPropagation = false }: DropdownMenuItemProps) {
  const context = useContext(DropdownContext)

  const handleClick = (e: React.MouseEvent) => {
    if (stopPropagation) {
      e.stopPropagation()
    }
    onClick?.()
    // Close dropdown after item click
    context?.close()
  }

  return (
    <div
      onClick={handleClick}
      className={cn(
        'px-4 py-3 hover:bg-accent transition-colors',
        onClick && 'cursor-pointer',
        className
      )}
    >
      {children}
    </div>
  )
}

