// ABOUTME: Container that renders the correct action panels based on phase and role.
// ABOUTME: Gates write operations by connected wallet role and current contract phase.

import type { Signer } from 'ethers'
import type { AdminRole } from '@/hooks/useRole'
import type { AdminState } from '@/hooks/useAdminState'
import type { TreasuryBalances } from '@/hooks/useTreasuryBalances'
import { ArmLoadPanel } from './ArmLoadPanel'
import { SeedManager } from './SeedManager'
import { LaunchTeamInvites } from './LaunchTeamInvites'
import { FinalizePanel } from './FinalizePanel'
import { SettlementSummary } from './SettlementSummary'
import { TreasuryMonitor } from './TreasuryMonitor'
import { ArmSweepPanel } from './ArmSweepPanel'
import { CancelPanel } from './CancelPanel'

export interface AdminActionsProps {
  state: AdminState
  role: AdminRole
  signer: Signer | null
  crowdfundAddress: string
  treasury: TreasuryBalances
}

export function AdminActions({ state, role, signer, crowdfundAddress, treasury }: AdminActionsProps) {
  const isActive = state.phase === 0
  const isFinalized = state.phase === 1
  const isCanceled = state.phase === 2
  const isLT = role === 'launch_team'
  const isSC = role === 'security_council'
  const ltWindowOpen = state.blockTimestamp >= state.windowStart && state.blockTimestamp <= state.launchTeamInviteEnd

  return (
    <div className="space-y-4">
      <h2 className="text-sm font-medium">Admin Actions</h2>

      {/* Pre-finalization actions */}
      {isActive && (
        <div className="space-y-3">
          {/* ARM loading — permissionless */}
          {!state.armLoaded && (
            <ArmLoadPanel signer={signer} crowdfundAddress={crowdfundAddress} />
          )}

          {/* Seed management — LT only */}
          {isLT && (
            <SeedManager
              signer={signer}
              crowdfundAddress={crowdfundAddress}
              seedCount={state.seedCount}
            />
          )}

          {/* LT invites — LT only, week-1 window */}
          {isLT && ltWindowOpen && (
            <LaunchTeamInvites
              signer={signer}
              crowdfundAddress={crowdfundAddress}
              hop1Remaining={state.ltBudgetHop1Remaining}
              hop2Remaining={state.ltBudgetHop2Remaining}
              blockTimestamp={state.blockTimestamp}
              launchTeamInviteEnd={state.launchTeamInviteEnd}
            />
          )}

          {/* Finalize — permissionless, post-window */}
          {state.blockTimestamp > state.windowEnd && state.windowEnd > 0 && (
            <FinalizePanel
              signer={signer}
              crowdfundAddress={crowdfundAddress}
              totalCommitted={state.totalCommitted}
              saleSize={state.saleSize}
            />
          )}
        </div>
      )}

      {/* Post-finalization */}
      {isFinalized && (
        <div className="space-y-3">
          <SettlementSummary state={state} />
          <TreasuryMonitor treasury={treasury} />
          <ArmSweepPanel
            signer={signer}
            crowdfundAddress={crowdfundAddress}
            contractArmBalance={treasury.contractArmBalance}
            totalAllocatedArm={state.totalAllocatedArm}
            totalArmTransferred={state.totalArmTransferred}
          />
        </div>
      )}

      {/* Canceled */}
      {isCanceled && (
        <div className="space-y-3">
          <div className="rounded border border-destructive/50 bg-destructive/10 p-3 text-sm text-destructive">
            Crowdfund has been canceled. All commitments are refundable.
          </div>
          <TreasuryMonitor treasury={treasury} />
          <ArmSweepPanel
            signer={signer}
            crowdfundAddress={crowdfundAddress}
            contractArmBalance={treasury.contractArmBalance}
            totalAllocatedArm={0n}
            totalArmTransferred={0n}
          />
        </div>
      )}

      {/* Cancel button — SC only, active phase */}
      {isSC && isActive && (
        <CancelPanel signer={signer} crowdfundAddress={crowdfundAddress} />
      )}

      {/* Observer role message */}
      {role === 'observer' && (
        <div className="text-xs text-muted-foreground text-center py-2">
          Connect as launch team or security council to access admin actions.
        </div>
      )}
    </div>
  )
}
