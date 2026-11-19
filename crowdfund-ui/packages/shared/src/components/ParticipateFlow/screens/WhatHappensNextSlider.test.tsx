// ABOUTME: Tests for the "What happens next" FAQ items: the refund-after-allocation item appears only
// ABOUTME: where that outcome can happen (not under priority fill, e.g. the relaunch).

import { describe, it, expect } from 'vitest'
import { faqItemIds } from './WhatHappensNextSlider.js'

describe('faqItemIds', () => {
  // WHY: under priority fill allocation equals min(capped demand, sale size), so a sale cannot
  // qualify on demand and then refund after allocation; describing it would mislead.
  it('drops the refund-after-allocation item under priority fill', () => {
    expect(faqItemIds(true)).toEqual(['window', 'under', 'over', 'claim'])
  })

  it('keeps every item otherwise', () => {
    expect(faqItemIds(false)).toEqual(['window', 'under', 'over', 'refund', 'claim'])
  })
})
