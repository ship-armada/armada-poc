// ABOUTME: Main contract interaction hook for the crowdfund frontend.
// ABOUTME: Provides read (polling), write (tx), and faucet operations.
import { useCallback, useEffect, useRef } from 'react'
import { useAtom, useAtomValue, useSetAtom } from 'jotai'
import { type Signer, type Provider } from 'ethers'
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
import type { CrowdfundDeployment, HopStats, Participant, Phase } from '@/types/crowdfund'
import { formatUsdc } from '@/utils/format'

/** Parse contract's Participant struct return value */
function parseParticipant(result: any): Participant {
  return {
    hop: Number(result[0]),
    isWhitelisted: result[1] as boolean,
    committed: BigInt(result[2]),
    allocation: BigInt(result[3]),
    refund: BigInt(result[4]),
    claimed: result[5] as boolean,
    invitedBy: result[6] as string,
    invitesSent: Number(result[7]),
  }
}

/** Parse contract's HopStats struct return value */
function parseHopStats(result: any): HopStats {
  return {
    totalCommitted: BigInt(result[0]),
    uniqueCommitters: Number(result[1]),
    whitelistCount: Number(result[2]),
  }
}

export function useCrowdfund(provider: Provider, getActiveSigner: () => Promise<Signer | null>) {
  const [state, setState] = useAtom(crowdfundStateAtom)
  const [events, setEvents] = useAtom(eventLogAtom)
  const [deployment, setDeployment] = useAtom(deploymentAtom)
  const currentAddress = useAtomValue(currentAddressAtom)
  const setParticipantList = useSetAtom(participantListAtom)
  const setParticipantListLoading = useSetAtom(participantListLoadingAtom)
  const unsubRef = useRef<(() => void) | null>(null)

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

      // Batch all read calls
      const [
        phase,
        admin,
        totalCommitted,
        saleSize,
        invitationStart,
        invitationEnd,
        commitmentStart,
        commitmentEnd,
        participantCount,
        hop0Stats,
        hop1Stats,
        hop2Stats,
        participantData,
        invitesRemaining,
        usdcBalance,
        armBalance,
        usdcAllowance,
      ] = await Promise.all([
        contract.phase(),
        contract.admin(),
        contract.totalCommitted(),
        contract.saleSize(),
        contract.invitationStart(),
        contract.invitationEnd(),
        contract.commitmentStart(),
        contract.commitmentEnd(),
        contract.getParticipantCount(),
        contract.getHopStats(0),
        contract.getHopStats(1),
        contract.getHopStats(2),
        contract.participants(currentAddress),
        contract.getInvitesRemaining(currentAddress),
        usdc.balanceOf(currentAddress),
        arm.balanceOf(currentAddress),
        usdc.allowance(currentAddress, deployment.contracts.crowdfund),
      ])

      const parsedPhase = Number(phase) as Phase
      const parsedParticipant = parseParticipant(participantData)

      // Fetch allocation if finalized and participant has committed
      let currentAllocation = null
      if (parsedPhase === 3 && parsedParticipant.committed > 0n) {
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
      }

      setState({
        phase: parsedPhase,
        adminAddress: admin as string,
        totalCommitted: BigInt(totalCommitted),
        saleSize: BigInt(saleSize),
        invitationStart: BigInt(invitationStart),
        invitationEnd: BigInt(invitationEnd),
        commitmentStart: BigInt(commitmentStart),
        commitmentEnd: BigInt(commitmentEnd),
        hopStats: [
          parseHopStats(hop0Stats),
          parseHopStats(hop1Stats),
          parseHopStats(hop2Stats),
        ],
        participantCount: Number(participantCount),
        currentParticipant: parsedParticipant,
        currentInvitesRemaining: Number(invitesRemaining),
        currentAllocation,
        usdcBalance: BigInt(usdcBalance),
        armBalance: BigInt(armBalance),
        usdcAllowance: BigInt(usdcAllowance),
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
      const isFinalized = phase === 3 // Phase.Finalized
      const rows: ParticipantRow[] = []

      // Fetch in batches of 20
      const batchSize = 20
      for (let i = 0; i < count; i += batchSize) {
        const batch = Array.from(
          { length: Math.min(batchSize, count - i) },
          (_, j) => i + j,
        )
        const addresses = await Promise.all(
          batch.map((idx) => contract.participantList(idx) as Promise<string>),
        )
        const participants = await Promise.all(
          addresses.map((addr) => contract.participants(addr)),
        )

        // After finalization, fetch computed allocations via getAllocation()
        // since the struct only stores allocation/refund after claim().
        const allocations = isFinalized
          ? await Promise.all(
              addresses.map((addr) =>
                contract.getAllocation(addr).catch(() => null),
              ),
            )
          : null

        for (let j = 0; j < addresses.length; j++) {
          const parsed = parseParticipant(participants[j])

          // Override allocation/refund/claimed with computed values
          if (allocations?.[j]) {
            parsed.allocation = BigInt(allocations[j][0])
            parsed.refund = BigInt(allocations[j][1])
            parsed.claimed = allocations[j][2] as boolean
          }

          rows.push({
            address: addresses[j],
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

  const startInvitations = useCallback(
    () =>
      executeTx('Starting invitations', (signer, dep) => {
        const contract = getCrowdfundContract(dep, signer)
        return contract.startInvitations()
      }),
    [executeTx],
  )

  const invite = useCallback(
    (invitee: string) =>
      executeTx('Sending invite', (signer, dep) => {
        const contract = getCrowdfundContract(dep, signer)
        return contract.invite(invitee)
      }),
    [executeTx],
  )

  const approveAndCommit = useCallback(
    (amount: bigint) =>
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

        return contract.commit(amount)
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
        const tx = await contract.claim()
        return tx
      }),
    [executeTx],
  )

  const refund = useCallback(
    () =>
      executeTx('Claiming refund', (signer, dep) => {
        const contract = getCrowdfundContract(dep, signer)
        return contract.refund()
      }),
    [executeTx],
  )

  const withdrawProceeds = useCallback(
    (treasury: string) =>
      executeTx('Withdrawing proceeds', (signer, dep) => {
        const contract = getCrowdfundContract(dep, signer)
        return contract.withdrawProceeds(treasury)
      }),
    [executeTx],
  )

  const withdrawUnallocatedArm = useCallback(
    (treasury: string) =>
      executeTx('Withdrawing unallocated ARM', (signer, dep) => {
        const contract = getCrowdfundContract(dep, signer)
        return contract.withdrawUnallocatedArm(treasury)
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
    // Write operations
    addSeeds,
    startInvitations,
    invite,
    approveAndCommit,
    finalize,
    claim,
    refund,
    withdrawProceeds,
    withdrawUnallocatedArm,
    // Faucet
    mintUsdc,
    // Time controls
    advanceTime,
  }
}
