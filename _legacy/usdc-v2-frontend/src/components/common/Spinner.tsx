interface SpinnerProps {
  label?: string
}

export function Spinner({ label }: SpinnerProps) {
  return (
    <div className="flex flex-col items-center gap-2 text-sm text-muted-foreground">
      <span className="inline-flex h-6 w-6 animate-spin rounded-full border-2 border-primary border-r-transparent" />
      {label ? <span>{label}</span> : null}
    </div>
  )
}
