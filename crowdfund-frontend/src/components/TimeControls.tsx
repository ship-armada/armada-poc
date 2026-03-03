// ABOUTME: Anvil time manipulation controls for local testing.
// ABOUTME: Allows fast-forwarding through invitation and commitment windows.
import { useState } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Clock, FastForward, SkipForward } from 'lucide-react'
import { Phase } from '@/types/crowdfund'
import type { CrowdfundState } from '@/atoms/crowdfund'
import type { useCrowdfund } from '@/hooks/useCrowdfund'

interface TimeControlsProps {
  state: CrowdfundState
  crowdfund: ReturnType<typeof useCrowdfund>
}

export function TimeControls({ state, crowdfund }: TimeControlsProps) {
  const [customSeconds, setCustomSeconds] = useState('')
  const [isAdvancing, setIsAdvancing] = useState(false)

  const handleAdvance = async (seconds: number) => {
    setIsAdvancing(true)
    await crowdfund.advanceTime(seconds)
    setIsAdvancing(false)
  }

  const handleCustomAdvance = async () => {
    const secs = parseInt(customSeconds)
    if (isNaN(secs) || secs <= 0) return
    await handleAdvance(secs)
    setCustomSeconds('')
  }

  const phase = state.phase
  const invEnd = Number(state.invitationEnd)
  const commitEnd = Number(state.commitmentEnd)

  const blockTs = state.blockTimestamp

  // Seconds from now until the invitation window ends (commitment starts)
  const skipToCommitmentSecs = invEnd > blockTs ? invEnd - blockTs + 1 : 0

  // Seconds from now until the commitment window ends
  const skipPastCommitmentSecs = commitEnd > blockTs ? commitEnd - blockTs + 1 : 0

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2">
          <Clock className="h-4 w-4" />
          Time Controls
          <span className="text-xs font-normal text-muted-foreground">(local only)</span>
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="flex flex-wrap gap-2">
          {/* Skip to Commitment Window */}
          {phase === Phase.Invitation && invEnd > 0 && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => handleAdvance(skipToCommitmentSecs)}
              disabled={isAdvancing}
              className="gap-1.5"
            >
              <FastForward className="h-3.5 w-3.5" />
              Skip to Commitment
            </Button>
          )}

          {/* Skip Past Commitment */}
          {phase === Phase.Invitation && commitEnd > 0 && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => handleAdvance(skipPastCommitmentSecs)}
              disabled={isAdvancing}
              className="gap-1.5"
            >
              <SkipForward className="h-3.5 w-3.5" />
              Skip Past Commitment
            </Button>
          )}

          {/* Custom time advance */}
          <div className="flex gap-1.5 items-center">
            <Input
              type="number"
              placeholder="Seconds"
              value={customSeconds}
              onChange={(e) => setCustomSeconds(e.target.value)}
              className="w-28 h-9"
              min="1"
            />
            <Button
              variant="outline"
              size="sm"
              onClick={handleCustomAdvance}
              disabled={isAdvancing || !customSeconds}
            >
              Advance
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  )
}
