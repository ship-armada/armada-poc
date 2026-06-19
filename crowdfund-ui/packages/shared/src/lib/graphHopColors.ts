// ABOUTME: Canonical hop colors shared across the NodeSphere graph and the hero list UI.
// ABOUTME: Ported byte-identical from the armada-crowdfund mockup (constants/graphHopColors.ts).

/** Canonical hop colors used by NodeSphere — keep list UI in sync. */
export const GRAPH_HOP_NODE_COLORS = {
  'Hop 0': 0x8b5cf6,
  'Hop 1': 0xfb923c,
  'Hop 2': 0xe879f9,
  'Multi-hop': 0x22c55e,
  'Your wallet': 0xfacc15,
} as const

export type GraphHopNodeKind = keyof typeof GRAPH_HOP_NODE_COLORS

export function graphHopColorToCss(hex: number): string {
  return `#${(hex & 0xffffff).toString(16).padStart(6, '0')}`
}

/** Crowdfund hero list hop labels (SEED = graph Hop 0, etc.). */
export function heroListHopColor(hop: 'SEED' | 'HOP-1' | 'HOP-2' | 'MULTI-HOP'): string {
  switch (hop) {
    case 'SEED':
      return graphHopColorToCss(GRAPH_HOP_NODE_COLORS['Hop 0'])
    case 'HOP-1':
      return graphHopColorToCss(GRAPH_HOP_NODE_COLORS['Hop 1'])
    case 'HOP-2':
      return graphHopColorToCss(GRAPH_HOP_NODE_COLORS['Hop 2'])
    case 'MULTI-HOP':
      return graphHopColorToCss(GRAPH_HOP_NODE_COLORS['Multi-hop'])
    default:
      return graphHopColorToCss(GRAPH_HOP_NODE_COLORS['Hop 1'])
  }
}

export function hopPillDotColor(variant: 'seed' | 'hop-1' | 'hop-2' | 'multi-hop'): string {
  switch (variant) {
    case 'seed':
      return graphHopColorToCss(GRAPH_HOP_NODE_COLORS['Hop 0'])
    case 'hop-1':
      return graphHopColorToCss(GRAPH_HOP_NODE_COLORS['Hop 1'])
    case 'hop-2':
      return graphHopColorToCss(GRAPH_HOP_NODE_COLORS['Hop 2'])
    case 'multi-hop':
      return graphHopColorToCss(GRAPH_HOP_NODE_COLORS['Multi-hop'])
    default:
      return graphHopColorToCss(GRAPH_HOP_NODE_COLORS['Hop 0'])
  }
}
