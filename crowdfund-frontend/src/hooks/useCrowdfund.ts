// ABOUTME: Main contract interaction hook for the crowdfund frontend.
// ABOUTME: Provides read (polling), write (tx), and faucet operations.
import { useCallback, useEffect, useRef } from 'react'
import { useAtom, useAtomValue, useSetAtom } from 'jotai'
import { type Signer, type Provider, ethers } from 'ethers'
import { toast } from 'sonner'
import {
  crowdfundStateAtom,
  eventLogAtom,
  deploymentAtom,
  participantListAtom,
  participantListLoadingAtom,
  type ParticipantRow,
} from '@/atoms/crowdfund'
import { currentAddressAtom } from '@/atoms/wallet'
import { loadDeployment } from '@/config/deployments'
import { POLL_INTERVAL_MS, isLocalMode } from '@/config/network'
import { getCrowdfundContract, getUsdcContract, getArmContract } from '@/services/contract'
import { fetchPastEvents, subscribeToEvents } from '@/services/events'
import type { CrowdfundDeployment, Phase, UserHopData, UserHopAllocation } from '@/types/crowdfund'
import { formatUsdc } from '@/utils/format'
import { parseParticipant, parseHopStats } from '@/utils/crowdfund-parse'

export function useCrowdfund(provider: Provider, getActiveSigner: () => Promise<Signer | null>) {
  const [state, setState] = useAtom(crowdfundStateAtom)
  const [events, setEvents] = useAtom(eventLogAtom)
  const [deployment, setDeployment] = useAtom(deploymentAtom)
  const currentAddress = useAtomValue(currentAddressAtom)
  const setParticipantList = useSetAtom(participantListAtom)
  const setParticipantListLoading = useSetAtom(participantListLoadingAtom)
  const unsubRef = useRef<(() => void) | null>(null)
  const selectedHopRef = useRef(0)

  // Load deployment on mount
  useEffect(() => {
    loadDeployment()
      .then(setDeployment)
      .catch((err) => {
        setState((prev) => ({ ...prev, isLoading: false, error: (err as Error).message }))
      })
  }, [setDeployment, setState])

  // Refresh all contract state
  const refreshState = useCallback(async () => {
    if (!deployment || !currentAddress) return

    try {
      const contract = getCrowdfundContract(deployment, provider)
      const usdc = getUsdcContract(deployment, provider)
      const arm = getArmContract(deployment, provider)

      // Get current block timestamp from the chain (not Date.now())
      const latestBlock = await provider.getBlock('latest')
      const blockTimestamp = latestBlock?.timestamp ?? Math.floor(Date.now() / 1000)

      // Batch all read calls (excluding per-hop participant data)
      const [
        phase,
        launchTeamAddr,
        armLoaded,
        totalCommitted,
        saleSize,
        windowStart,
        windowEnd,
        launchTeamInviteEnd,
        participantCount,
        hop0Stats,
        hop1Stats,
        hop2Stats,
        usdcBalance,
        armBalance,
        usdcAllowance,
        isRefundMode,
        claimDeadline,
        launchTeamBudgetRaw,
      ] = await Promise.all([
        contract.phase(),
        contract.launchTeam(),
        contract.armLoaded(),
        contract.totalCommitted(),
        contract.saleSize(),
        contract.windowStart(),
        contract.windowEnd(),
        contract.launchTeamInviteEnd(),
        contract.getParticipantCount(),
        contract.getHopStats(0),
        contract.getHopStats(1),
        contract.getHopStats(2),
        usdc.balanceOf(currentAddress),
        arm.balanceOf(currentAddress),
        usdc.allowance(currentAddress, deployment.contracts.crowdfund),
        contract.refundMode(),
        contract.claimDeadline(),
        contract.getLaunchTeamBudgetRemaining(),
      ])

      const parsedPhase = Number(phase) as Phase

      // Determine which hops the user is whitelisted in (may be multiple)
      const hopChecks = await Promise.all(
        [0, 1, 2].map((h) => contract.isWhitelisted(currentAddress, h)),
      )
      const whitelistedHops = [0, 1, 2].filter((_, i) => hopChecks[i])

      // Fetch participant data, effective cap, and invites remaining for ALL whitelisted hops
      const userHops: UserHopData[] = await Promise.all(
        whitelistedHops.map(async (hop) => {
          const [participantData, effectiveCap, invitesRemaining] = await Promise.all([
            contract.participants(currentAddress, hop),
            contract.getEffectiveCap(currentAddress, hop),
            contract.getInvitesRemaining(currentAddress, hop),
          ])
          return {
            hop,
            participant: parseParticipant(participantData),
            effectiveCap: BigInt(effectiveCap),
            invitesRemaining: Number(invitesRemaining),
          }
        }),
      )

      // Use previous selectedHop if still whitelisted, else fall back to lowest whitelisted hop
      const prevSelectedHop = selectedHopRef.current
      const selectedHop = whitelistedHops.includes(prevSelectedHop)
        ? prevSelectedHop
        : (whitelistedHops[0] ?? 0)
      selectedHopRef.current = selectedHop
      const selectedHopData = userHops.find((h) => h.hop === selectedHop)
      const currentParticipant = selectedHopData?.participant ?? null
      const currentInvitesRemaining = selectedHopData?.invitesRemaining ?? 0

      // Fetch aggregate allocation if finalized and not in refund mode
      let currentAllocation = null
      let userHopAllocations: UserHopAllocation[] = []
      if (parsedPhase === 1 && !isRefundMode) {
        // Aggregate allocation for the claim button
        const hasCommitted = userHops.some((h) => h.participant.committed > 0n)
        if (hasCommitted) {
          try {
            const allocResult = await contract.getAllocation(currentAddress)
            currentAllocation = {
              allocation: BigInt(allocResult[0]),
              refund: BigInt(allocResult[1]),
              claimed: allocResult[2] as boolean,
            }
          } catch {
            // getAllocation may fail if not finalized
          }

          // Per-hop allocation breakdown
          const hopsWithCommitments = userHops.filter((h) => h.participant.committed > 0n)
          userHopAllocations = (
            await Promise.all(
              hopsWithCommitments.map(async (h) => {
                try {
                  const res = await contract.getAllocationAtHop(currentAddress, h.hop)
                  return {
                    hop: h.hop,
                    allocation: BigInt(res[0]),
                    refund: BigInt(res[1]),
                    claimed: res[2] as boolean,
                  }
                } catch {
                  return null
                }
              }),
            )
          ).filter((a): a is UserHopAllocation => a !== null)
        }
      }

      setState({
        phase: parsedPhase,
        launchTeamAddress: launchTeamAddr as string,
        launchTeamBudget: {
          hop1Remaining: Number(launchTeamBudgetRaw[0]),
          hop2Remaining: Number(launchTeamBudgetRaw[1]),
        },
        armLoaded: armLoaded as boolean,
        totalCommitted: BigInt(totalCommitted),
        saleSize: BigInt(saleSize),
        windowStart: BigInt(windowStart),
        windowEnd: BigInt(windowEnd),
        launchTeamInviteEnd: BigInt(launchTeamInviteEnd),
        hopStats: [
          parseHopStats(hop0Stats),
          parseHopStats(hop1Stats),
          parseHopStats(hop2Stats),
        ],
        participantCount: Number(participantCount),
        userHops,
        selectedHop,
        userHopAllocations,
        claimDeadline: BigInt(claimDeadline),
        currentHop: selectedHop,
        currentParticipant,
        currentInvitesRemaining,
        currentAllocation,
        usdcBalance: BigInt(usdcBalance),
        armBalance: BigInt(armBalance),
        usdcAllowance: BigInt(usdcAllowance),
        refundMode: isRefundMode as boolean,
        blockTimestamp,
        isLoading: false,
        lastUpdated: Date.now(),
        error: null,
      })
    } catch (err) {
      setState((prev) => ({
        ...prev,
        isLoading: false,
        error: (err as Error).message,
      }))
    }
  }, [deployment, currentAddress, provider, setState])

  // Refresh participant list for the table
  const refreshParticipantList = useCallback(async () => {
    if (!deployment) return

    setParticipantListLoading(true)
    try {
      const contract = getCrowdfundContract(deployment, provider)
      const count = Number(await contract.getParticipantCount())
      const phase = Number(await contract.phase())
      const isFinalized = phase === 1 // Phase.Finalized
      const isRefundMode = isFinalized ? (await contract.refundMode()) as boolean : false
      const rows: ParticipantRow[] = []

      // Fetch in batches of 20. participantNodes returns (address, hop) tuples.
      const batchSize = 20
      for (let i = 0; i < count; i += batchSize) {
        const batch = Array.from(
          { length: Math.min(batchSize, count - i) },
          (_, j) => i + j,
        )
        const nodes = await Promise.all(
          batch.map((idx) => contract.participantNodes(idx)),
        )
        const addressesAndHops = nodes.map((n: any) => ({
          addr: n[0] as string,
          hop: Number(n[1]),
        }))

        const participants = await Promise.all(
          addressesAndHops.map(({ addr, hop }) => contract.participants(addr, hop)),
        )

        // After finalization, fetch computed allocations via getAllocationAtHop().
        // In refundMode, allocations are meaningless — committed amount IS the refund.
        const allocations = isFinalized && !isRefundMode
          ? await Promise.all(
              addressesAndHops.map(({ addr, hop }) =>
                contract.getAllocationAtHop(addr, hop).catch(() => null),
              ),
            )
          : null

        for (let j = 0; j < addressesAndHops.length; j++) {
          const parsed = parseParticipant(participants[j])

          // Override allocation/refund/armClaimed with computed values from getAllocationAtHop
          if (allocations?.[j]) {
            parsed.allocation = BigInt(allocations[j][0])
            parsed.refund = BigInt(allocations[j][1])
            parsed.armClaimed = allocations[j][2] as boolean
          } else if (isRefundMode) {
            // In refundMode, full committed amount is refundable
            parsed.allocation = 0n
            parsed.refund = parsed.committed
          }

          rows.push({
            address: addressesAndHops[j].addr,
            hop: addressesAndHops[j].hop,
            participant: parsed,
          })
        }
      }

      setParticipantList(rows)
    } catch {
      // Silently fail — table shows empty
    } finally {
      setParticipantListLoading(false)
    }
  }, [deployment, provider, setParticipantList, setParticipantListLoading])

  // Set up polling
  useEffect(() => {
    if (!deployment || !currentAddress) return

    refreshState()
    const interval = setInterval(refreshState, POLL_INTERVAL_MS)
    return () => clearInterval(interval)
  }, [deployment, currentAddress, refreshState])

  // Set up event subscription
  useEffect(() => {
    if (!deployment) return

    const contract = getCrowdfundContract(deployment, provider)

    // Fetch historical events
    fetchPastEvents(contract).then((pastEvents) => {
      setEvents(pastEvents.reverse())
    })

    // Subscribe to new events
    unsubRef.current = subscribeToEvents(contract, (event) => {
      setEvents((prev) => [event, ...prev])
    })

    return () => {
      unsubRef.current?.()
      unsubRef.current = null
    }
  }, [deployment, provider, setEvents])

  // =========== Hop Selection ===========

  const setSelectedHop = useCallback(
    (hop: number) => {
      selectedHopRef.current = hop
      setState((prev) => {
        const hopData = prev.userHops.find((h) => h.hop === hop)
        if (!hopData) return prev
        return {
          ...prev,
          selectedHop: hop,
          currentHop: hop,
          currentParticipant: hopData.participant,
          currentInvitesRemaining: hopData.invitesRemaining,
        }
      })
    },
    [setState],
  )

  // =========== Write Operations ===========

  const executeTx = useCallback(
    async (
      label: string,
      fn: (signer: Signer, deployment: CrowdfundDeployment) => Promise<any>,
    ) => {
      const signer = await getActiveSigner()
      if (!signer || !deployment) {
        toast.error('No wallet connected')
        return null
      }

      const toastId = toast.loading(`${label}...`)
      try {
        const result = await fn(signer, deployment)
        const tx = result
        if (tx?.wait) {
          const receipt = await tx.wait()
          toast.success(`${label} confirmed`, { id: toastId })
          // Refresh state after tx confirms
          await refreshState()
          await refreshParticipantList()
          return receipt
        }
        toast.success(label, { id: toastId })
        return result
      } catch (err: any) {
        const reason = err?.reason || err?.message || 'Transaction failed'
        toast.error(`${label} failed: ${reason}`, { id: toastId })
        return null
      }
    },
    [getActiveSigner, deployment, refreshState, refreshParticipantList],
  )

  const addSeeds = useCallback(
    (addresses: string[]) =>
      executeTx('Adding seeds', (signer, dep) => {
        const contract = getCrowdfundContract(dep, signer)
        return contract.addSeeds(addresses)
      }),
    [executeTx],
  )

  const loadArm = useCallback(
    () =>
      executeTx('Verifying ARM pre-load', (signer, dep) => {
        const contract = getCrowdfundContract(dep, signer)
        return contract.loadArm()
      }),
    [executeTx],
  )

  const invite = useCallback(
    (invitee: string, inviterHop: number) =>
      executeTx('Sending invite', (signer, dep) => {
        const contract = getCrowdfundContract(dep, signer)
        return contract.invite(invitee, inviterHop)
      }),
    [executeTx],
  )

  const launchTeamInvite = useCallback(
    (invitee: string, hop: number) =>
      executeTx('Launch team invite', (signer, dep) => {
        const contract = getCrowdfundContract(dep, signer)
        return contract.launchTeamInvite(invitee, hop)
      }),
    [executeTx],
  )

  const approveAndCommit = useCallback(
    (amount: bigint, hop: number) =>
      executeTx(`Committing ${formatUsdc(amount)}`, async (signer, dep) => {
        const usdc = getUsdcContract(dep, signer)
        const contract = getCrowdfundContract(dep, signer)

        // Check current allowance
        const signerAddr = await signer.getAddress()
        const currentAllowance = BigInt(
          await usdc.allowance(signerAddr, dep.contracts.crowdfund),
        )

        if (currentAllowance < amount) {
          const approveTx = await usdc.approve(dep.contracts.crowdfund, amount)
          await approveTx.wait()
        }

        return contract.commit(hop, amount)
      }),
    [executeTx],
  )

  const finalize = useCallback(
    () =>
      executeTx('Finalizing sale', (signer, dep) => {
        const contract = getCrowdfundContract(dep, signer)
        return contract.finalize()
      }),
    [executeTx],
  )

  const claim = useCallback(
    () =>
      executeTx('Claiming allocation', async (signer, dep) => {
        const contract = getCrowdfundContract(dep, signer)
        const tx = await contract.claim(ethers.ZeroAddress)
        return tx
      }),
    [executeTx],
  )

  const refund = useCallback(
    () =>
      executeTx('Claiming refund', (signer, dep) => {
        const contract = getCrowdfundContract(dep, signer)
        return contract.claimRefund()
      }),
    [executeTx],
  )

  const cancelSale = useCallback(
    () =>
      executeTx('Security council cancel', (signer, dep) => {
        const contract = getCrowdfundContract(dep, signer)
        return contract.cancel()
      }),
    [executeTx],
  )

  const withdrawUnallocatedArm = useCallback(
    () =>
      executeTx('Withdrawing unallocated ARM', (signer, dep) => {
        const contract = getCrowdfundContract(dep, signer)
        return contract.withdrawUnallocatedArm()
      }),
    [executeTx],
  )

  // =========== Faucet (local only) ===========

  const mintUsdc = useCallback(
    async (amount: bigint) => {
      if (!isLocalMode() || !deployment || !currentAddress) {
        toast.error('Mint only available in local mode')
        return
      }

      const toastId = toast.loading(`Minting ${formatUsdc(amount)} USDC...`)
      try {
        const response = await fetch('/api/mint-usdc', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            recipient: currentAddress,
            amount: amount.toString(),
            usdcAddress: deployment.contracts.usdc,
          }),
        })

        const data = await response.json()
        if (!response.ok) {
          throw new Error(data.error || 'Mint failed')
        }

        toast.success(`Minted ${formatUsdc(amount)} USDC`, { id: toastId })
        await refreshState()
      } catch (err: any) {
        toast.error(`Mint failed: ${err.message}`, { id: toastId })
      }
    },
    [deployment, currentAddress, refreshState],
  )

  // =========== Time Controls (local only) ===========

  const advanceTime = useCallback(
    async (seconds: number) => {
      if (!isLocalMode()) return

      const toastId = toast.loading(`Advancing time by ${seconds}s...`)
      try {
        const rpcProvider = provider as any
        await rpcProvider.send('evm_increaseTime', [seconds])
        await rpcProvider.send('evm_mine', [])
        toast.success(`Advanced time by ${seconds}s`, { id: toastId })
        await refreshState()
        await refreshParticipantList()
      } catch (err: any) {
        toast.error(`Time advance failed: ${err.message}`, { id: toastId })
      }
    },
    [provider, refreshState, refreshParticipantList],
  )

  return {
    state,
    events,
    deployment,
    refreshState,
    refreshParticipantList,
    setSelectedHop,
    // Write operations
    addSeeds,
    loadArm,
    invite,
    launchTeamInvite,
    approveAndCommit,
    finalize,
    claim,
    refund,
    cancelSale,
    withdrawUnallocatedArm,
    // Faucet
    mintUsdc,
    // Time controls
    advanceTime,
  }
}
