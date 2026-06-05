import { describe, it, expect } from 'vitest'
import { normalizeEnrollmentError } from './enrollmentErrors'

describe('normalizeEnrollmentError', () => {
  it('maps SyntaxError to artifact download guidance', () => {
    const out = normalizeEnrollmentError(new SyntaxError("Unexpected token ']'"))
    expect(out.message).toMatch(/IPFS/i)
    expect(out.message).not.toMatch(/underlying:/i)
  })

  it('maps missing deployment manifest errors', () => {
    const out = normalizeEnrollmentError(
      new Error('Deployment manifest not found: privacy-pool-hub.json. Run npm run setup'),
    )
    expect(out.message).toMatch(/VITE_NETWORK=sepolia|npm run setup/i)
  })
})
