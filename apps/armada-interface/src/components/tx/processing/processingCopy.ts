// ABOUTME: Presentational copy types + label/row-kind helpers for the tx processing UI.
// ABOUTME: Ported from the armada-app design mockup (txProcessingCopy + transactionProgressUtils).

export interface TxProgressStage {
  id: string
  label: string
  subtitle: string
  /** Shown on the final step once the whole flow has completed. */
  completedLabel?: string
}

export interface TxProgressCardCopy {
  /** Sentence case in copy; used for accessible name. */
  tag: string
  title: string
  titleBreakAfter?: string
  /** Explicit line breaks (takes precedence over `titleBreakAfter`). */
  titleLines?: readonly string[]
  subtitle: string
  subtitleLines?: readonly string[]
}

export function resolveStageLabel(
  stage: TxProgressStage,
  index: number,
  stageCount: number,
  completed: boolean,
): string {
  if (completed && index === stageCount - 1 && stage.completedLabel) {
    return stage.completedLabel
  }

  return stage.label
}

export type RowKind = 'done' | 'currentActive' | 'pending' | 'completedFinal'

export function rowKindFor(index: number, activeIndex: number, completed = false): RowKind {
  if (completed) {
    if (index < activeIndex) return 'done'
    if (index === activeIndex) return 'completedFinal'
    return 'pending'
  }

  if (index < activeIndex) return 'done'
  if (index === activeIndex) return 'currentActive'
  return 'pending'
}

export function stageLabelFor(
  stage: TxProgressStage,
  index: number,
  stages: ReadonlyArray<TxProgressStage>,
  completed: boolean,
): string {
  return resolveStageLabel(stage, index, stages.length, completed)
}
