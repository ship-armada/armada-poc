// ABOUTME: Ambient module declaration so shared's tsc tolerates CSS side-effect imports.
// ABOUTME: Vite strips CSS imports at build time; this only keeps TypeScript happy.

declare module '*.css'
