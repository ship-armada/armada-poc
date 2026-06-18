// ABOUTME: Subdued static splash backdrop — a blurred + darkened image under a theme-tied radial wash.
// ABOUTME: Used as the NodeSphere no-WebGL fallback, behind the live graph, and as a page background (e.g. the Observe view).

import splashImg from '../assets/splash.jpg'

export interface SplashBackdropProps {
  /** Surface-tint % at the vignette center (lower = more image shows through). */
  washCenter?: number
  /** Surface-tint % at the vignette edge (higher = fades harder into the page). */
  washEdge?: number
  /** Image brightness multiplier (lower = darker / more subdued). */
  brightness?: number
  /** Image saturation multiplier (lower = greyer). */
  saturate?: number
}

/** Subdued static backdrop: a blurred + darkened splash image under a theme-tied
 *  radial wash. `washCenter`/`washEdge` are the surface-tint percentages at the
 *  center and edge of the vignette; `brightness`/`saturate` mute the image.
 *  Defaults match the no-WebGL fallback; callers (e.g. behind the live graph)
 *  pass heavier/darker values to recede further. Renders `position: absolute;
 *  inset: 0` — give it a positioned, clipping parent. */
export function SplashBackdrop({
  washCenter = 42,
  washEdge = 86,
  brightness = 0.38,
  saturate = 0.5,
}: SplashBackdropProps) {
  return (
    <div
      aria-hidden
      style={{
        position: 'absolute',
        inset: 0,
        zIndex: 0,
        overflow: 'hidden',
        // Master opacity for the whole backdrop. Defaults to 1; a theme can set
        // --splash-opacity to fade everything at once. (The committer's light
        // theme keeps this at 1 and instead hides just the photo layer — see
        // --splash-image-opacity below — so the light-tuned wash still shows.)
        opacity: 'var(--splash-opacity, 1)',
      }}
    >
      {/* Image layer — desaturated, darkened, and blurred so it reads as ambient
          backdrop rather than a competing photo. Oversized (inset negative) so
          the blur's soft edge stays outside the visible frame; blurring an
          inset:0 layer would otherwise bleed the page background in at the seams. */}
      <div
        style={{
          position: 'absolute',
          inset: '-24px',
          backgroundImage: `url(${splashImg})`,
          backgroundSize: 'cover',
          backgroundPosition: 'center',
          backgroundRepeat: 'no-repeat',
          filter: `blur(6px) saturate(${saturate}) brightness(${brightness})`,
          // The darkened photo only works on a dark page; a theme can hide just
          // this layer (--splash-image-opacity: 0) while keeping the wash below.
          opacity: 'var(--splash-image-opacity, 1)',
        }}
      />
      {/* Vignette/wash tied to the theme surface so the splash fades into the
          page background at the edges and the foreground UI stays legible. Each
          stop falls back to the surface-tied default but can be overridden per
          theme (--splash-wash-center / --splash-wash-edge) — the committer's
          light theme swaps in a faint brand glow now that the photo is hidden. */}
      <div
        style={{
          position: 'absolute',
          inset: 0,
          background:
            'radial-gradient(ellipse at center,' +
            ` var(--splash-wash-center, color-mix(in srgb, var(--semantic-color-surface-default) ${washCenter}%, transparent)),` +
            ` var(--splash-wash-edge, color-mix(in srgb, var(--semantic-color-surface-default) ${washEdge}%, transparent)))`,
        }}
      />
    </div>
  )
}
