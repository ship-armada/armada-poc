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

export { WalletButton } from './components/WalletButton'
export type { WalletButtonProps } from './components/WalletButton'

export { IconButton } from './components/IconButton'
export type { IconButtonProps, IconButtonSize, IconButtonVariant } from './components/IconButton'
export { default as Tooltip } from './components/Tooltip/Tooltip'
export { BottomSheet, afterBottomSheetHandoff, BOTTOM_SHEET_EXIT_MS, BOTTOM_SHEET_HANDOFF_MS } from './components/BottomSheet'
export { SidePanel, SIDE_PANEL_EXIT_MS } from './components/SidePanel'
export type { SidePanelProps } from './components/SidePanel'
export type { BottomSheetProps } from './components/BottomSheet'

export { ModalShell, ModalStepSwitch, modalActionRowEnter, modalStepBodyEnter, modalStepShell } from './components/ModalShell'
export type { ModalShellProps, ModalShellChrome, ModalStepSwitchProps } from './components/ModalShell'
export { MODAL_EXIT_TIMING_VARS, MODAL_EXIT_TOTAL_MS, MODAL_EXIT_EASING, MODAL_STEP_EXIT_MS } from './components/ModalShell/modalExitMotion'
export { FlowModalOverlay } from './components/FlowModalOverlay'
export type { FlowModalOverlayProps } from './components/FlowModalOverlay'
export { Steps } from './components/Steps'
export type { StepsProps } from './components/Steps'
