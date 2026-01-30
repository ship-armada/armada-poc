import { useState } from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'

export interface CollapsibleChainSectionProps {
  title: string
  chainCount: number
  children: React.ReactNode
  defaultOpen?: boolean
}

export function CollapsibleChainSection({
  title,
  chainCount,
  children,
  defaultOpen = false,
}: CollapsibleChainSectionProps) {
  const [isOpen, setIsOpen] = useState(defaultOpen)

  return (
    <section className="card card-no-padding card-shadow-none">
      <button
        type="button"
        onClick={() => setIsOpen(!isOpen)}
        className="flex w-full items-center justify-between p-4 text-left transition-colors hover:bg-muted/50"
      >
        <div className="flex items-center gap-3">
          {isOpen ? (
            <ChevronDown className="h-5 w-5 text-muted-foreground" />
          ) : (
            <ChevronRight className="h-5 w-5 text-muted-foreground" />
          )}
          <h2 className="text-md font-semibold">{title}</h2>
          <span className="inline-flex items-center justify-center rounded-full bg-primary/10 px-2.5 py-0.5 text-xs font-medium text-primary">
            {chainCount}
          </span>
        </div>
      </button>
      
      {isOpen && (
        <div className="border-t border-border p-4">
          <div className="space-y-4">{children}</div>
        </div>
      )}
    </section>
  )
}

