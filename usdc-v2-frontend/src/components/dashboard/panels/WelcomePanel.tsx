import { Shield } from 'lucide-react'

export function WelcomePanel() {
  return (
    <div className="card bg-card p-6">
      <div className="flex items-center gap-3 mb-6">
        <Shield className="h-5 w-5 text-primary" />
        <h2 className="text-lg font-semibold">Welcome to Borderless Private USDC</h2>
      </div>

      <div className="space-y-4">
        <p className="text-sm text-muted-foreground">
          Your gateway to private USDC transactions. Shield your funds and
          transact with complete privacy using zero-knowledge proofs.
        </p>

        <div className="space-y-3">
          <div className="flex items-start gap-3">
            <div className="flex items-center justify-center w-6 h-6 rounded-full bg-primary/10 text-primary text-xs font-semibold flex-shrink-0 mt-0.5">
              1
            </div>
            <div>
              <p className="text-sm font-medium">Deposit</p>
              <p className="text-xs text-muted-foreground">
                Shield USDC from your public wallet into your private balance.
              </p>
            </div>
          </div>

          <div className="flex items-start gap-3">
            <div className="flex items-center justify-center w-6 h-6 rounded-full bg-primary/10 text-primary text-xs font-semibold flex-shrink-0 mt-0.5">
              2
            </div>
            <div>
              <p className="text-sm font-medium">Send</p>
              <p className="text-xs text-muted-foreground">
                Send USDC privately to other Railgun addresses, or unshield back
                to public addresses.
              </p>
            </div>
          </div>

          <div className="flex items-start gap-3">
            <div className="flex items-center justify-center w-6 h-6 rounded-full bg-primary/10 text-primary text-xs font-semibold flex-shrink-0 mt-0.5">
              3
            </div>
            <div>
              <p className="text-sm font-medium">Earn</p>
              <p className="text-xs text-muted-foreground">
                Put your shielded USDC to work earning yield while maintaining
                privacy.
              </p>
            </div>
          </div>
        </div>

        <div className="p-3 bg-info/10 border border-info/20 rounded-lg">
          <p className="text-xs text-info-foreground">
            Get started by unlocking your shielded wallet, then click one of the
            action buttons to begin.
          </p>
        </div>
      </div>
    </div>
  )
}
