// ABOUTME: Ambient declarations for static asset imports — SVG/PNG/JPG/MP4 resolve to URL strings.
// ABOUTME: Lets crowdfund-shared bundle its own assets via ESM imports (Vite-handled at consumer build time).

declare module '*.svg' {
  const url: string
  export default url
}

declare module '*.png' {
  const url: string
  export default url
}

declare module '*.jpg' {
  const url: string
  export default url
}

declare module '*.mp4' {
  const url: string
  export default url
}
