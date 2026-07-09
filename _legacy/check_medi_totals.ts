// ABOUTME: Diagnostic — prints on-chain crowdfund totals + hop configs for a named deployment instance, used to compare against UI-displayed values when the graph layer and contract appear to disagree.
// ABOUTME: Usage: npx ts-node scripts/check_medi_totals.ts [instance=medi2] [rpcUrl=https://ethereum-sepolia-rpc.publicnode.com]

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { Contract, JsonRpcProvider, formatUnits } from 'ethers'

const PROJECT_ROOT = path.resolve(__dirname, '..')

const ABI = [
  'function totalCommitted() view returns (uint256)',
  'function cappedDemand() view returns (uint256)',
  'function getEstimatedCappedDemand() view returns (uint256 globalCapped, uint256[3] perHopCapped)',
  'function saleSize() view returns (uint256)',
  'function getParticipantCount() view returns (uint256)',
  'function hopConfigs(uint256) view returns (uint16 ceilingBps, uint256 capUsdc, uint16 maxInvites, uint16 maxInvitesReceived)',
  'function getHopStats(uint8 hop) view returns (uint256 totalCommitted, uint256 cappedCommitted, uint32 uniqueCommitters, uint32 whitelistCount)',
  'function phase() view returns (uint8)',
  'function windowStart() view returns (uint256)',
  'function windowEnd() view returns (uint256)',
]

interface CrowdfundManifest {
  chainId: number
  contracts: { crowdfund: string }
}

function fmtUsdc(v: bigint): string {
  return `${formatUnits(v, 6)} USDC`
}

async function main() {
  const instance = process.argv[2] ?? 'medi2'
  const rpcUrl = process.argv[3] ?? 'https://ethereum-sepolia-rpc.publicnode.com'

  const manifestPath = path.join(
    PROJECT_ROOT,
    'deployments',
    'instances',
    instance,
    'sepolia',
    'crowdfund.json',
  )
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as CrowdfundManifest

  console.log(`Instance:           ${instance}`)
  console.log(`Manifest:           ${manifestPath}`)
  console.log(`Crowdfund address:  ${manifest.contracts.crowdfund}`)
  console.log(`Chain ID:           ${manifest.chainId}`)
  console.log(`RPC:                ${rpcUrl}`)
  console.log()

  const provider = new JsonRpcProvider(rpcUrl)
  const crowdfund = new Contract(manifest.contracts.crowdfund, ABI, provider)

  const [phase, totalCommitted, cappedDemand, saleSize, participantCount, estimated] =
    await Promise.all([
      crowdfund.phase() as Promise<bigint>,
      crowdfund.totalCommitted() as Promise<bigint>,
      crowdfund.cappedDemand() as Promise<bigint>,
      crowdfund.saleSize() as Promise<bigint>,
      crowdfund.getParticipantCount() as Promise<bigint>,
      crowdfund.getEstimatedCappedDemand() as Promise<[bigint, [bigint, bigint, bigint]]>,
    ])

  console.log('=== Contract-level totals ===')
  console.log(`Phase:                          ${phase}`)
  console.log(`totalCommitted() (raw):         ${fmtUsdc(totalCommitted)}`)
  console.log(`cappedDemand() (finalized):     ${fmtUsdc(cappedDemand)}`)
  console.log(`estimatedCappedDemand (global): ${fmtUsdc(estimated[0])}`)
  console.log(
    `estimatedCappedDemand (per-hop): [${fmtUsdc(estimated[1][0])}, ${fmtUsdc(
      estimated[1][1],
    )}, ${fmtUsdc(estimated[1][2])}]`,
  )
  console.log(`saleSize():                     ${fmtUsdc(saleSize)}`)
  console.log(`participantCount():             ${participantCount}`)
  console.log()

  console.log('=== Per-hop config (on-chain hopConfigs[i]) ===')
  for (const hop of [0, 1, 2] as const) {
    const cfg = await crowdfund.hopConfigs(hop)
    const ceilingBps = cfg[0] as bigint
    const capUsdc = cfg[1] as bigint
    const maxInvites = cfg[2] as bigint
    const maxInvitesReceived = cfg[3] as bigint
    console.log(
      `Hop ${hop}: capUsdc=${fmtUsdc(capUsdc).padEnd(20)} ceilingBps=${String(ceilingBps).padStart(5)} maxInvites=${maxInvites} maxInvitesReceived=${maxInvitesReceived}`,
    )
  }
  console.log()

  console.log('=== Per-hop stats (on-chain getHopStats) ===')
  let summed = 0n
  for (const hop of [0, 1, 2] as const) {
    const stats = await crowdfund.getHopStats(hop)
    const totalForHop = stats[0] as bigint
    const cappedForHop = stats[1] as bigint
    const uniqueCommitters = stats[2] as bigint
    const whitelistCount = stats[3] as bigint
    summed += totalForHop
    console.log(
      `Hop ${hop}: total=${fmtUsdc(totalForHop).padEnd(20)} capped=${fmtUsdc(cappedForHop).padEnd(20)} uniqueCommitters=${uniqueCommitters} whitelist=${whitelistCount}`,
    )
  }
  console.log(`Sum of hop totals:  ${fmtUsdc(summed)}`)
  console.log()

  if (summed !== totalCommitted) {
    console.log(
      `⚠️  Sum of per-hop totals (${fmtUsdc(summed)}) differs from totalCommitted() (${fmtUsdc(totalCommitted)}).`,
    )
  } else {
    console.log('✓ Per-hop totals sum to totalCommitted().')
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
