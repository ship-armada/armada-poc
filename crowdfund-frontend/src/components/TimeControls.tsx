// ABOUTME: Anvil time manipulation controls for local testing.
// ABOUTME: Allows fast-forwarding through the active window phases.
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
  const windowEnd = Number(state.windowEnd)
  const launchTeamInviteEnd = Number(state.launchTeamInviteEnd)

  const blockTs = state.blockTimestamp

  // Seconds from now until the launch team invite period ends (first 7 days)
  const skipPastInvitePeriodSecs = launchTeamInviteEnd > blockTs ? launchTeamInviteEnd - blockTs + 1 : 0

  // Seconds from now until the full window ends (21 days)
  const skipPastWindowSecs = windowEnd > blockTs ? windowEnd - blockTs + 1 : 0

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
          {/* Skip past launch team invite period (first 7 days) */}
          {phase === Phase.Active && launchTeamInviteEnd > 0 && blockTs < launchTeamInviteEnd && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => handleAdvance(skipPastInvitePeriodSecs)}
              disabled={isAdvancing}
              className="gap-1.5"
            >
              <FastForward className="h-3.5 w-3.5" />
              Skip Past Invite Period
            </Button>
          )}

          {/* Skip past full window (21 days) */}
          {phase === Phase.Active && windowEnd > 0 && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => handleAdvance(skipPastWindowSecs)}
              disabled={isAdvancing}
              className="gap-1.5"
            >
              <SkipForward className="h-3.5 w-3.5" />
              Skip Past Window
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
