// ABOUTME: Unit tests for indexer error-message sanitization.
// ABOUTME: Verifies RPC keys and DB credentials are redacted while messages stay legible.

import { describe, expect, it } from 'vitest'
import { sanitizeErrorMessage } from './errors.js'

describe('sanitizeErrorMessage', () => {
  it('strips an Alchemy-style API key from the URL path', () => {
    const out = sanitizeErrorMessage(
      'could not detect network (req to https://eth-sepolia.g.alchemy.com/v2/abc123SECRETkey failed)',
    )
    expect(out).not.toContain('abc123SECRETkey')
    expect(out).toContain('https://eth-sepolia.g.alchemy.com/[redacted]')
  })

  it('strips an Infura project secret from the URL path', () => {
    const out = sanitizeErrorMessage('timeout https://sepolia.infura.io/v3/PROJECTSECRET99')
    expect(out).not.toContain('PROJECTSECRET99')
    expect(out).toContain('https://sepolia.infura.io/[redacted]')
  })

  it('strips a key passed as a query parameter', () => {
    const out = sanitizeErrorMessage('fetch failed: https://rpc.example.com?apikey=SUPERSECRET')
    expect(out).not.toContain('SUPERSECRET')
    expect(out).toContain('https://rpc.example.com/[redacted]')
  })

  it('redacts Postgres connection credentials', () => {
    const out = sanitizeErrorMessage('connection to postgres://admin:hunter2@db.host:5432/crowdfund refused')
    expect(out).not.toContain('hunter2')
    expect(out).toContain('postgres://[redacted]@db.host:5432/crowdfund')
  })

  it('truncates very long messages', () => {
    const out = sanitizeErrorMessage('x'.repeat(600))
    expect(out.length).toBeLessThanOrEqual(520)
    expect(out).toContain('(truncated)')
  })

  it('passes through messages with no secrets unchanged', () => {
    const msg = 'RPC timeout after 15000ms during getLogs 100-200'
    expect(sanitizeErrorMessage(msg)).toBe(msg)
  })
})
