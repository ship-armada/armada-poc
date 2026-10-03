// ABOUTME: Guards InviteActionScreen against referencing CSS-module classes its stylesheet doesn't define.
// ABOUTME: An undefined `styles.x` renders unstyled, and a sheet override aimed at a class the component never uses styles nothing.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it, expect } from 'vitest'

const dir = __dirname

function classesUsedInComponent(source: string): string[] {
  return [...new Set([...source.matchAll(/styles\.([A-Za-z_][\w-]*)/g)].map((m) => m[1]))]
}

function classesDefinedInStylesheet(css: string): Set<string> {
  return new Set([...css.matchAll(/\.([A-Za-z_][\w-]*)/g)].map((m) => m[1]))
}

describe('InviteActionScreen stylesheet', () => {
  it('defines every class the component references', () => {
    const source = readFileSync(join(dir, 'InviteActionScreen.tsx'), 'utf8')
    const css = readFileSync(join(dir, 'InviteActionScreen.module.css'), 'utf8')
    const defined = classesDefinedInStylesheet(css)
    const missing = classesUsedInComponent(source).filter((name) => !defined.has(name))
    expect(missing).toEqual([])
  })

  it('aims every sheet-layout override at a class the component uses', () => {
    const source = readFileSync(join(dir, 'InviteActionScreen.tsx'), 'utf8')
    const css = readFileSync(join(dir, 'InviteActionScreen.module.css'), 'utf8')
    const used = new Set(classesUsedInComponent(source))
    const sheetTargets = [...css.matchAll(/\.rootSheet\s+\.([A-Za-z_][\w-]*)/g)].map((m) => m[1])
    expect(sheetTargets.length).toBeGreaterThan(0)
    expect(sheetTargets.filter((name) => !used.has(name))).toEqual([])
  })
})
