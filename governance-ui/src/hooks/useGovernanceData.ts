// ABOUTME: Polls all governance state on a 10-second interval and exposes it via React state.
// ABOUTME: Reads proposals, token balances, treasury info, and steward data from contracts.

import { useState, useEffect, useCallback, useRef } from 'react'
import { ethers } from 'ethers'
import type { GovernanceContracts } from './useGovernanceContracts'
import type { ProposalData, ClaimData, StewardActionData } from '../governance-types'
import { ProposalState, ProposalType } from '../governance-types'

const POLL_INTERVAL_MS = 10_000

export interface GovernanceData {
  // Token / locker
  armBalance: bigint
  armAllowance: bigint
  lockedBalance: bigint
  totalLocked: bigint
  totalSupply: bigint
  proposalThreshold: bigint

  // Proposals
  proposalCount: number
  proposals: ProposalData[]

  // Treasury
  treasuryArmBalance: bigint
  treasuryUsdcBalance: bigint
  treasuryOwner: string
  treasurySteward: string
  claimCount: number
  claims: ClaimData[]
  stewardBudget: { budget: bigint; spent: bigint; remaining: bigint } | null

  // Steward
  currentSteward: string
  isStewardActive: boolean
  termEnd: bigint
  actionDelay: bigint
  stewardActionCount: number
  stewardActions: StewardActionData[]

  // Block info
  blockTimestamp: bigint
  blockNumber: bigint

  // Meta
  isLoading: boolean
  error: string | null
  refresh: () => Promise<void>
}

const EMPTY_DATA: GovernanceData = {
  armBalance: 0n,
  armAllowance: 0n,
  lockedBalance: 0n,
  totalLocked: 0n,
  totalSupply: 0n,
  proposalThreshold: 0n,
  proposalCount: 0,
  proposals: [],
  treasuryArmBalance: 0n,
  treasuryUsdcBalance: 0n,
  treasuryOwner: '',
  treasurySteward: '',
  claimCount: 0,
  claims: [],
  stewardBudget: null,
  currentSteward: '',
  isStewardActive: false,
  termEnd: 0n,
  actionDelay: 0n,
  stewardActionCount: 0,
  stewardActions: [],
  blockTimestamp: 0n,
  blockNumber: 0n,
  isLoading: true,
  error: null,
  refresh: async () => {},
}

export function useGovernanceData(
  contracts: GovernanceContracts,
  userAccount: string | null,
): GovernanceData {
  const [data, setData] = useState<GovernanceData>(EMPTY_DATA)
  const isFetchingRef = useRef(false)

  const fetchData = useCallback(async () => {
    const { provider, armToken, votingLocker, governor, treasury, steward, usdc, deployment } = contracts
    if (!provider || !armToken || !votingLocker || !governor || !treasury || !steward || !deployment) {
      return
    }
    if (isFetchingRef.current) return
    isFetchingRef.current = true

    try {
      const block = await provider.getBlock('latest')
      const blockTimestamp = BigInt(block?.timestamp ?? 0)
      const blockNumber = BigInt(block?.number ?? 0)

      // Fetch basic token/locker data
      const [totalSupply, totalLocked, proposalThreshold, proposalCountRaw] = await Promise.all([
        armToken.totalSupply(),
        votingLocker.totalLocked(),
        governor.proposalThreshold(),
        governor.proposalCount(),
      ])
      const proposalCount = Number(proposalCountRaw)

      // User-specific data
      let armBalance = 0n
      let armAllowance = 0n
      let lockedBalance = 0n
      if (userAccount) {
        ;[armBalance, armAllowance, lockedBalance] = await Promise.all([
          armToken.balanceOf(userAccount),
          armToken.allowance(userAccount, deployment.contracts.votingLocker),
          votingLocker.getLockedBalance(userAccount),
        ])
      }

      // Fetch proposals (most recent first, limit to last 20 for performance)
      const startId = Math.max(1, proposalCount - 19)
      const proposalPromises: Promise<ProposalData>[] = []
      for (let i = proposalCount; i >= startId; i--) {
        proposalPromises.push(fetchProposal(governor, i, userAccount))
      }
      const proposals = await Promise.all(proposalPromises)

      // Fetch proposal descriptions from events
      try {
        const events = await governor.queryFilter(
          governor.filters.ProposalCreated(),
          0,
          'latest',
        )
        const descriptionMap = new Map<number, string>()
        for (const event of events) {
          const parsed = governor.interface.parseLog({
            topics: [...event.topics],
            data: event.data,
          })
          if (parsed) {
            descriptionMap.set(Number(parsed.args[0]), parsed.args[5] as string)
          }
        }
        for (const p of proposals) {
          const desc = descriptionMap.get(p.id)
          if (desc) p.description = desc
        }
      } catch {
        // Event query may fail on some providers — descriptions will be empty
      }

      // Treasury data
      let treasuryArmBalance = 0n
      let treasuryUsdcBalance = 0n
      let treasuryOwner = ''
      let treasurySteward = ''
      let claimCount = 0
      let stewardBudget: { budget: bigint; spent: bigint; remaining: bigint } | null = null

      try {
        ;[treasuryArmBalance, treasuryOwner, treasurySteward] = await Promise.all([
          treasury.getBalance(deployment.contracts.armToken),
          treasury.owner(),
          treasury.steward(),
        ])

        if (usdc) {
          treasuryUsdcBalance = await treasury.getBalance(await usdc.getAddress())
        }

        const claimCountRaw = await treasury.claimCount()
        claimCount = Number(claimCountRaw)

        if (usdc && contracts.usdcAddress) {
          try {
            const budgetResult = await treasury.getStewardBudget(contracts.usdcAddress)
            stewardBudget = {
              budget: budgetResult[0] as bigint,
              spent: budgetResult[1] as bigint,
              remaining: budgetResult[2] as bigint,
            }
          } catch {
            // May fail if no steward set
          }
        }
      } catch {
        // Treasury queries may fail
      }

      // Fetch claims
      const claims: ClaimData[] = []
      for (let i = 1; i <= claimCount; i++) {
        try {
          const [claimData, remaining] = await Promise.all([
            treasury.claims(i),
            treasury.getClaimRemaining(i),
          ])
          claims.push({
            id: i,
            token: claimData[0] as string,
            beneficiary: claimData[1] as string,
            amount: claimData[2] as bigint,
            exercised: claimData[3] as bigint,
            remaining: remaining as bigint,
            createdAt: claimData[4] as bigint,
          })
        } catch {
          // Claim may not exist
        }
      }

      // Steward data
      let currentSteward = ''
      let isStewardActive = false
      let termEnd = 0n
      let actionDelay = 0n
      let stewardActionCount = 0

      try {
        ;[currentSteward, isStewardActive, termEnd, actionDelay] = await Promise.all([
          steward.currentSteward(),
          steward.isStewardActive().catch(() => false),
          steward.termEnd().catch(() => 0n),
          steward.actionDelay(),
        ])

        const actionCountRaw = await steward.actionCount()
        stewardActionCount = Number(actionCountRaw)
      } catch {
        // Steward queries may fail
      }

      // Fetch steward actions
      const stewardActions: StewardActionData[] = []
      for (let i = 1; i <= stewardActionCount; i++) {
        try {
          const action = await steward.getAction(i)
          stewardActions.push({
            id: i,
            target: action[0] as string,
            value: action[1] as bigint,
            timestamp: action[2] as bigint,
            executed: action[3] as boolean,
            vetoed: action[4] as boolean,
            executeAfter: action[5] as bigint,
          })
        } catch {
          // Action may not exist
        }
      }

      setData((prev) => ({
        ...prev,
        armBalance,
        armAllowance,
        lockedBalance,
        totalLocked,
        totalSupply,
        proposalThreshold,
        proposalCount,
        proposals,
        treasuryArmBalance,
        treasuryUsdcBalance,
        treasuryOwner,
        treasurySteward,
        claimCount,
        claims,
        stewardBudget,
        currentSteward,
        isStewardActive,
        termEnd,
        actionDelay,
        stewardActionCount,
        stewardActions,
        blockTimestamp,
        blockNumber,
        isLoading: false,
        error: null,
      }))
    } catch (err) {
      setData((prev) => ({
        ...prev,
        isLoading: false,
        error: err instanceof Error ? err.message : 'Failed to fetch governance data',
      }))
    } finally {
      isFetchingRef.current = false
    }
  }, [contracts, userAccount])

  // Expose refresh and wire it into state
  useEffect(() => {
    setData((prev) => ({ ...prev, refresh: fetchData }))
  }, [fetchData])

  // Initial fetch + polling
  useEffect(() => {
    if (contracts.isLoading || contracts.error) return

    fetchData()
    const interval = setInterval(fetchData, POLL_INTERVAL_MS)
    return () => clearInterval(interval)
  }, [contracts.isLoading, contracts.error, fetchData])

  return data
}

async function fetchProposal(
  governor: ethers.Contract,
  id: number,
  userAccount: string | null,
): Promise<ProposalData> {
  const [proposalData, stateRaw, quorumRequired] = await Promise.all([
    governor.getProposal(id),
    governor.state(id),
    governor.quorum(id),
  ])

  let hasVoted = false
  let userVoteChoice: number | null = null
  if (userAccount) {
    hasVoted = await governor.hasVoted(id, userAccount)
    if (hasVoted) {
      const choice = await governor.voteChoice(id, userAccount)
      userVoteChoice = Number(choice)
    }
  }

  return {
    id,
    proposer: proposalData[0] as string,
    proposalType: Number(proposalData[1]) as ProposalType,
    state: Number(stateRaw) as ProposalState,
    voteStart: proposalData[2] as bigint,
    voteEnd: proposalData[3] as bigint,
    forVotes: proposalData[4] as bigint,
    againstVotes: proposalData[5] as bigint,
    abstainVotes: proposalData[6] as bigint,
    snapshotBlock: proposalData[7] as bigint,
    quorumRequired,
    description: '', // Filled in via events
    hasVoted,
    userVoteChoice,
  }
}
