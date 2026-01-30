import { cn } from '@/lib/utils'

export interface TransactionProgressBarProps {
  progress: number
  maxWidth?: string
  height?: 'sm' | 'md'
}

export function TransactionProgressBar({
  progress,
  maxWidth,
  height = 'md',
}: TransactionProgressBarProps) {
  const barHeight = height === 'sm' ? 'h-1' : 'h-1.5'

  return (
    <div className={maxWidth ? `w-full ${maxWidth}` : 'w-full'} style={{ maxWidth }}>
      <div className={cn('w-full overflow-hidden rounded-md bg-muted', barHeight)}>
        <div
          className="h-full bg-accent transition-all duration-300"
          style={{ width: `${progress}%` }}
        />
      </div>
    </div>
  )
}

