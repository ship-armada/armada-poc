// ABOUTME: Dev-only preview surface for Phase 4a — renders NodeSphere / CrowdfundExperience / MyPosition variants with the designer's mock data.
// ABOUTME: Reached via `?mock=node-sphere | my-position | my-position-split | crowdfund-experience`. No wallet, deployment, or indexer required.

import { useMemo, useState } from 'react'
import {
  NodeSphere,
  CrowdfundExperience,
  MyPosition,
  MyPositionSplit,
  type ScenarioParticipants,
} from '@armada/crowdfund-shared'

const SCENARIOS: ScenarioParticipants[] = [0, 3, 4, 5, 30, 800]

export type PreviewVariant =
  | 'node-sphere'
  | 'my-position'
  | 'my-position-split'
  | 'crowdfund-experience'

interface NodeSpherePreviewProps {
  variant: PreviewVariant
}

export function NodeSpherePreview({ variant }: NodeSpherePreviewProps) {
  const initialScenario = useMemo<ScenarioParticipants>(() => {
    if (typeof window === 'undefined') return 30
    const raw = new URLSearchParams(window.location.search).get('scenario')
    const n = raw ? parseInt(raw, 10) : 30
    return (SCENARIOS as number[]).includes(n) ? (n as ScenarioParticipants) : 30
  }, [])
  const [scenario, setScenario] = useState<ScenarioParticipants>(initialScenario)

  if (variant === 'crowdfund-experience') {
    return <CrowdfundExperience />
  }
  if (variant === 'my-position') {
    return <MyPosition />
  }
  if (variant === 'my-position-split') {
    return <MyPositionSplit />
  }

  // node-sphere — standalone with a scenario picker overlay
  return (
    <div className="relative h-screen w-screen overflow-hidden bg-black text-white">
      <div className="absolute inset-0">
        <NodeSphere scenarioParticipants={scenario} scenarioSeed={42} />
      </div>
      <div className="absolute left-4 top-4 z-10 flex flex-col gap-2 rounded-md bg-black/60 p-3 text-xs backdrop-blur-md">
        <div className="font-mono uppercase tracking-widest opacity-60">
          NodeSphere preview · {scenario} participants
        </div>
        <div className="flex flex-wrap gap-1">
          {SCENARIOS.map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => setScenario(s)}
              className={`rounded-sm px-2 py-1 font-mono transition-colors ${
                s === scenario ? 'bg-white text-black' : 'bg-white/10 hover:bg-white/20'
              }`}
            >
              {s}
            </button>
          ))}
        </div>
        <div className="opacity-50">
          Try `?mock=my-position`, `?mock=my-position-split`, `?mock=crowdfund-experience`.
        </div>
      </div>
    </div>
  )
}
