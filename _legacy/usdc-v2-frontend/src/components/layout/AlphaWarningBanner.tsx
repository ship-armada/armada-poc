import { AlertTriangle } from 'lucide-react'

export function AlphaWarningBanner() {
  return (
    <div className="bg-warning/40 border-b border-warning/80 px-4 py-3">
      <div className="container mx-auto flex items-center gap-3">
        <AlertTriangle className="h-5 w-5 text-foreground flex-shrink-0" />
        <p className="text-sm text-foreground">
          <span className="font-semibold">Warning: Alpha software with potential security risks.</span>{' '}
          Do not use a MetaMask wallet containing real assets. Create a dedicated browser profile and MetaMask instance for testing only.
        </p>
      </div>
    </div>
  )
}
