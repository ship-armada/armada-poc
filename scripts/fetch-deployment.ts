// ABOUTME: Fetches a named deployment instance from the armada-deployments repo into deployments/instances/.
// ABOUTME: Usage: npm run fetch-deployment -- <instance> [--ref <git-ref>]

import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'

const REPO_BASE = 'https://raw.githubusercontent.com/ship-armada/armada-deployments'
const DEFAULT_REF = 'main'
const PROJECT_ROOT = path.resolve(__dirname, '..')
const OUT_ROOT = path.join(PROJECT_ROOT, 'deployments', 'instances')

interface DeploymentManifest {
  name: string
  version: string
  description?: string
  environment: string
  deployer: string
  deployedAt: string
  chains: Record<string, { chainId: number; role: string; artifacts: string[] }>
}

function parseArgs(argv: string[]): { instance: string; ref: string } {
  const positional: string[] = []
  let ref = DEFAULT_REF
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--ref') {
      const next = argv[i + 1]
      if (!next) throw new Error('--ref requires a value (commit SHA, tag, or branch name)')
      ref = next
      i++
    } else if (arg.startsWith('--')) {
      throw new Error(`Unknown flag: ${arg}`)
    } else {
      positional.push(arg)
    }
  }
  if (positional.length !== 1) {
    throw new Error('Expected exactly one positional argument: <instance>')
  }
  return { instance: positional[0], ref }
}

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url)
  if (!res.ok) {
    throw new Error(`GET ${url} → ${res.status} ${res.statusText}`)
  }
  return (await res.json()) as T
}

async function fetchText(url: string): Promise<string> {
  const res = await fetch(url)
  if (!res.ok) {
    throw new Error(`GET ${url} → ${res.status} ${res.statusText}`)
  }
  return await res.text()
}

async function main() {
  const { instance, ref } = parseArgs(process.argv.slice(2))
  const base = `${REPO_BASE}/${ref}/testnet/${instance}`
  const outDir = path.join(OUT_ROOT, instance)

  console.log(`Fetching deployment instance '${instance}' from ${base}`)

  const manifest = await fetchJson<DeploymentManifest>(`${base}/manifest.json`)
  console.log(`  manifest: ${manifest.name} v${manifest.version} (deployedAt ${manifest.deployedAt})`)

  await mkdir(outDir, { recursive: true })
  await writeFile(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n')

  for (const [chain, chainInfo] of Object.entries(manifest.chains)) {
    console.log(`  chain ${chain} (chainId=${chainInfo.chainId}, role=${chainInfo.role})`)
    for (const artifact of chainInfo.artifacts) {
      const artifactUrl = `${base}/${artifact}`
      const artifactOut = path.join(outDir, artifact)
      await mkdir(path.dirname(artifactOut), { recursive: true })
      const body = await fetchText(artifactUrl)
      await writeFile(artifactOut, body.endsWith('\n') ? body : body + '\n')
      console.log(`    ✓ ${artifact}`)
    }
  }

  console.log(`\nWrote ${outDir}`)
  console.log(`Point the committer at this instance with:`)
  console.log(`  VITE_DEPLOYMENT_INSTANCE=${instance} npm run crowdfund:committer`)
}

main().catch((err) => {
  console.error('fetch-deployment failed:', err instanceof Error ? err.message : err)
  process.exit(1)
})
