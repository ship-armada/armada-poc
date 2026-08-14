// ABOUTME: Public barrel for the app-vendored design system — the primitives this app consumes.
// ABOUTME: Vendored from @armada/ui so the interface is self-contained; style sheets live in ./styles.

export { ArmadaLogo } from './components/ArmadaLogo'
export type { ArmadaLogoProps } from './components/ArmadaLogo'

export { ArmadaSymbol } from './components/ArmadaSymbol/ArmadaSymbol'
export type { ArmadaSymbolProps } from './components/ArmadaSymbol/ArmadaSymbol'

export { Button } from './components/Button'
export type { ButtonProps, ButtonVariant, ButtonSize, ButtonIcon } from './components/Button'

export { Text } from './components/Text'
export type { TextProps, TypographyVariant } from './components/Text'

export { NavItem } from './components/NavItem'
export type { NavItemProps } from './components/NavItem'

export { NavBar } from './components/NavBar'
export type { NavBarProps, NavBarItem } from './components/NavBar'

export { WalletPillMenu } from './components/Header/WalletPillMenu'
export type { WalletPillMenuProps } from './components/Header/WalletPillMenu'

export { WalletButton } from './components/WalletButton'
export type { WalletButtonProps } from './components/WalletButton'
