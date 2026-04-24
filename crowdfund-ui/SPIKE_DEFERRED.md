# Spike: D3 Radial Tree — Deferred Items

This document tracks everything that was intentionally skipped in the
`spike/d3-radial-tree` branch so we can come back to it if the spike is
promoted. Do **not** ship the radial view without working through this list.

The spike replaces the xyflow-based `TreeView` with a D3-force radial layout
(`RadialTreeView` in `packages/shared/src/components/RadialTreeView.tsx`) in
both the observer and committer apps. The original `TreeView.tsx` is
untouched so we can diff / revert / compare.

## Feature parity gaps (vs. existing `TreeView`)

### Node rendering
- [ ] **Commit-amount size modulation** — `RadialTreeView` sized nodes by
      `committed` (sqrt scale, [5, 18]) before the hop-level sizing rewrite
      to match the design mockup. Commit amount no longer affects radius.
      If reintroducing, modulate within each hop's size band so hop ordering
      (root > hop-0 > hop-1 > hop-2) is preserved.
- [ ] **Multi-hop pie-slice nodes** — addresses appearing at multiple hops
      currently render as a composite pie chart coloured per hop. The spike
      collapses these to a single circle with the "multi" colour token.
- [ ] **Identicons** — `IdenticonSvg` fills on single-hop committed nodes
      above `IDENTICON_MIN_RADIUS`. Spike renders plain circles.
- [ ] **Node labels** — the spike omits ENS/address labels on nodes to keep
      the view legible. `TreeView` shows them beneath each node.
- [ ] **Invites-used/available badges** — `TreeView`'s small indicators
      attached to the node face.
- [ ] **Connected-wallet halo** — the spike uses a thin coloured stroke;
      the original adds a glow/ring and occasionally a pulse.

### Edge rendering
- [ ] **Curved invite edges** — `TreeView` uses quadratic Bezier paths; the
      spike uses straight lines.
- [ ] **Edge gradients / animation** — plan doc §8 mentions
      `stroke-dasharray` flow animation. Not yet applied.
- [ ] **Inviter-chain highlighting** — emphasises the path from
      `connectedAddress` back to Armada root.
- [ ] **Self-invite (same address, different hop) edges** rendered
      distinctly.
- [ ] **Dimmed edges** when only one endpoint matches the search.

### Interaction
- [ ] **Hover card** (`HoverCard` + `NodeDetail`) — rich hover summary with
      per-hop breakdown. Spike now renders a **light tooltip** (address,
      committed total, hop) on node hover, anchored to the node via the
      active zoom transform. Still deferred: the full NodeDetail breakdown
      with per-hop amounts, invite counts, allocation status, and Radix
      `HoverCard` semantics (keyboard focus, animation, portal-rendered so
      it escapes `overflow: hidden`).
- [ ] **Click-pinned popover** (`Popover`) with copy-address, "View in
      table", and `NodeDetail` body. Spike swallows the click but only
      toggles `onSelectAddress`.
- [ ] **Subtree collapse** — click a node's toggle to hide descendants.
- [ ] **Multi-hop expansion badge** — expands a multi-hop node into its
      per-hop instances.
- [x] ~~**Pan / zoom** — xyflow gives this for free (`Controls`, `fitView`,
      scroll-wheel zoom, drag-pan).~~ Wired via `d3-zoom` + bottom-left
      Controls panel (zoom in / zoom out / fit view). React-controlled mode:
      d3 captures events, transform lives in component state.
- [ ] **"My wallet" zoom button** (`Crosshair` icon, bottom-right).
- [ ] **Auto-zoom to single search match.**
- [ ] **Pane click clears selection** — spike does this via `onClick` on the
      SVG root; works but needs verification that it doesn't steal clicks
      from node handlers on fast-moving ticks.

### Layout / search
- [ ] **Search filtering + dimming** — `searchQuery` is accepted by the
      component for API parity but the spike ignores it.
- [ ] **Hop labels at the top of the canvas** ("Root / Seed / Hop-1 /
      Hop-2"). The spike uses faint dashed ring guides only.
- [ ] **Stable radial angles per subtree** — current simulation gives
      angular positions purely to the solver, which can make sibling order
      unstable across updates. Consider seeding angles from tree order.

## Technical debt / correctness
- [ ] **Tests** — no unit or integration tests for `RadialTreeView` or
      `buildRadialGraph`. The xyflow-based view also lacks component tests
      (integration only), but if the spike is promoted we should add both:
      a pure test for `buildRadialGraph` and a simulation-settling test for
      the component.
- [ ] **Performance with hundreds of nodes** — plan doc §0 targets "~300
      nodes". Spike uses default `d3-force` ticks with no throttling. If we
      see dropped frames, gate `setNodes` behind `requestAnimationFrame` or
      only emit every Nth tick.
- [ ] **Background depth polish** — current radial gradient is hex-coded
      (`#0F172A` → `#020617`). If promoted, tokenize as
      `--rtv-bg-inner`/`--rtv-bg-outer` so the gradient can respond to
      future theme changes. Also skipped: faint noise texture overlay
      (data-URL background + `mix-blend-mode: overlay`) and a separate
      vignette — the radial gradient already functions as a vignette.
- [ ] **LOD / zoom-aware edge hiding** — at very large graphs, even
      low-opacity edges add visual noise. A zoom-aware LOD pass could hide
      hop-2 edges when zoomed out and reveal them when the user zooms in
      on a subtree. Not needed at stress300 scale.
- [ ] **Per-edge gradient scaling** — each edge renders its own
      `<linearGradient>` with `userSpaceOnUse` coordinates so the gradient
      runs source→target regardless of angle. Fine at stress300 (~300
      gradients), starts to matter at 1000+. Cheaper alternatives if we
      hit a ceiling: (a) three shared gradients keyed by hop-pair
      (root→0, 0→1, 1→2) using `objectBoundingBox` — accepts directional
      inconsistency across edges at different angles; (b) solid
      destination-hop stroke colour — drops the flow aesthetic but is
      effectively free.
- [ ] **Ticking when off-screen** — the simulation runs whenever
      `alpha > alphaMin`. Consider pausing via `IntersectionObserver` when
      the tree is hidden (e.g. Tab switched to Table).
- [ ] **Memory leak risk** — `nodeMapRef` only grows; addresses that leave
      the graph are retained in the ref until unmount. Harmless for the
      spike but worth cleaning up before promotion.
- [ ] **`GraphLegend` may describe features the spike doesn't show** (e.g.
      multi-hop pie, inviter chain). Either gate the legend or keep a
      radial-specific legend.

## API parity
`RadialTreeViewProps` matches `TreeViewProps` so the import-alias swap in
`observer/src/App.tsx` and `committer/src/App.tsx` is zero-cost at the call
site. The following props are **accepted but not yet used** inside the
spike component:

- `onViewInTable` — no popover means no call site.
- `searchQuery` — filter logic deferred.
- `phase` — currently only used to drive `NodeDetail` in the existing
  hover/popover path; not needed until interaction is wired back.
- `resolveENS` — accepted but ignored by `RadialTreeView` and stripped from
  `buildRadialGraph`. Reason: callers (esp. the stress-mode observer) pass
  a fresh `() => null` closure every render, which was destabilising the
  target memo and restarting the simulation on every selection click.
  When ENS labels are displayed in the radial view, resolve them at render
  time (per-node `resolveENS(node.address)` call) rather than baking them
  into the sim input.

When promoting, implement these so the two apps get equivalent behaviour.

## Rollback

The legacy `TreeView` component, its exports, and its xyflow dependency are
all still in the tree. To revert:

1. In `observer/src/App.tsx` and `committer/src/App.tsx`, change
   `RadialTreeView as TreeView` back to `TreeView`.
2. Optionally remove `RadialTreeView.tsx`, `radialLayout.ts`, their index
   exports, and `d3-force` + `@types/d3-force` from
   `packages/shared/package.json`.

If the spike is **promoted** rather than reverted, the final cleanup is the
reverse: delete `TreeView.tsx`, its exports, and `@xyflow/react` +
`d3-hierarchy` from `packages/shared/package.json`.
