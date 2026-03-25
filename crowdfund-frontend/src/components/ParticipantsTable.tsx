// ABOUTME: Table showing all whitelisted participants and their crowdfund data.
// ABOUTME: Fetches participant list from contract and displays in a sortable table.
import { useEffect } from 'react'
import { useAtomValue } from 'jotai'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { Badge } from '@/components/ui/badge'
import { Users, RefreshCw } from 'lucide-react'
import { participantListAtom, participantListLoadingAtom } from '@/atoms/crowdfund'
import { Phase } from '@/types/crowdfund'
import { formatUsdc, formatArm, truncateAddress, hopLabel } from '@/utils/format'
import type { CrowdfundState } from '@/atoms/crowdfund'
import type { useCrowdfund } from '@/hooks/useCrowdfund'

interface ParticipantsTableProps {
  state: CrowdfundState
  crowdfund: ReturnType<typeof useCrowdfund>
}

export function ParticipantsTable({ state, crowdfund }: ParticipantsTableProps) {
  const participants = useAtomValue(participantListAtom)
  const isLoading = useAtomValue(participantListLoadingAtom)

  // Fetch participant list on mount and when participant count changes
  useEffect(() => {
    crowdfund.refreshParticipantList()
  }, [state.participantCount]) // eslint-disable-line react-hooks/exhaustive-deps

  const isFinalized = state.phase === Phase.Finalized || state.phase === Phase.Canceled
  const isRefundMode = state.refundMode || state.phase === Phase.Canceled

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-base flex items-center gap-2">
            <Users className="h-4 w-4" />
            Participants ({state.participantCount})
          </CardTitle>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => crowdfund.refreshParticipantList()}
            disabled={isLoading}
          >
            <RefreshCw className={`h-3.5 w-3.5 ${isLoading ? 'animate-spin' : ''}`} />
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        {participants.length === 0 ? (
          <p className="text-sm text-muted-foreground text-center py-4">
            {isLoading ? 'Loading participants...' : 'No participants yet'}
          </p>
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Address</TableHead>
                  <TableHead>Hop</TableHead>
                  <TableHead className="text-right">Committed</TableHead>
                  <TableHead className="text-right">Invites Sent</TableHead>
                  {isFinalized && !isRefundMode && (
                    <>
                      <TableHead className="text-right">Allocation</TableHead>
                      <TableHead className="text-right">Refund</TableHead>
                      <TableHead>Claimed</TableHead>
                    </>
                  )}
                  {isFinalized && isRefundMode && (
                    <>
                      <TableHead className="text-right">Refund</TableHead>
                      <TableHead>Refunded</TableHead>
                    </>
                  )}
                </TableRow>
              </TableHeader>
              <TableBody>
                {participants.map((row) => (
                  <TableRow key={`${row.address}-${row.hop}`}>
                    <TableCell className="font-mono text-xs">
                      {truncateAddress(row.address)}
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline" className="text-xs">
                        {hopLabel(row.hop)}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-right">
                      {row.participant.committed > 0n
                        ? formatUsdc(row.participant.committed)
                        : '-'}
                    </TableCell>
                    <TableCell className="text-right">
                      {row.participant.invitesSent}
                    </TableCell>
                    {isFinalized && !isRefundMode && (
                      <>
                        <TableCell className="text-right">
                          {row.participant.allocation > 0n
                            ? formatArm(row.participant.allocation)
                            : '-'}
                        </TableCell>
                        <TableCell className="text-right">
                          {row.participant.refund > 0n
                            ? formatUsdc(row.participant.refund)
                            : '-'}
                        </TableCell>
                        <TableCell>
                          {row.participant.armClaimed ? (
                            <Badge variant="outline" className="border-success text-success text-xs">Yes</Badge>
                          ) : (
                            <span className="text-muted-foreground text-xs">No</span>
                          )}
                        </TableCell>
                      </>
                    )}
                    {isFinalized && isRefundMode && (
                      <>
                        <TableCell className="text-right">
                          {row.participant.committed > 0n
                            ? formatUsdc(row.participant.committed)
                            : '-'}
                        </TableCell>
                        <TableCell>
                          {row.participant.refundClaimed ? (
                            <Badge variant="outline" className="border-success text-success text-xs">Yes</Badge>
                          ) : (
                            <span className="text-muted-foreground text-xs">No</span>
                          )}
                        </TableCell>
                      </>
                    )}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
