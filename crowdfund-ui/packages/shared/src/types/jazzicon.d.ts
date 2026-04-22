// ABOUTME: Ambient module declaration for @metamask/jazzicon (ships without types).
// ABOUTME: The default export is a function returning the rendered identicon as an HTMLElement.

declare module '@metamask/jazzicon' {
  function jazzicon(diameter: number, seed: number): HTMLElement
  export default jazzicon
}
