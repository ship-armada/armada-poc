// ABOUTME: Ported byte-identical from the armada-crowdfund mockup (components/MyPosition/MyPositionHero.tsx).
// ABOUTME: Internal paths rewritten — @armada/ui primitives via package barrel; cross-folder refs use crowdfund-shared relative paths.

import { CrowdfundExperience } from '../CrowdfundExperience/CrowdfundExperience'

/** Hero-layout My Position (bottom corners + full-screen graph). */
export function MyPositionHero() {
  return <CrowdfundExperience initialView="myposition" />
}
