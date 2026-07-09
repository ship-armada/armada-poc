// ABOUTME: Unit tests for the Sentry URL-scrubbing helpers.
// ABOUTME: Ensures invite-link signatures never leave the app via Sentry.
import { describe, it, expect } from 'vitest'
import type { ErrorEvent, Breadcrumb } from '@sentry/react'
import { stripQueryString, scrubEventUrls, scrubBreadcrumbUrls } from './sentry'

const INVITE_URL =
  'https://fund.armada.blue/invite?inviter=0xabc&nonce=1&deadline=2&sig=0xdeadbeef'

describe('stripQueryString', () => {
  it('removes the query string', () => {
    expect(stripQueryString(INVITE_URL)).toBe('https://fund.armada.blue/invite')
  })

  it('leaves a URL without a query string untouched', () => {
    expect(stripQueryString('https://fund.armada.blue/invite')).toBe(
      'https://fund.armada.blue/invite',
    )
  })
})

describe('scrubEventUrls', () => {
  it('strips the query string from request.url', () => {
    const event = { request: { url: INVITE_URL } } as ErrorEvent
    expect(scrubEventUrls(event).request?.url).toBe('https://fund.armada.blue/invite')
  })

  it('strips query strings from exception stack-frame paths', () => {
    const event = {
      exception: {
        values: [
          {
            stacktrace: {
              frames: [
                { abs_path: INVITE_URL, filename: INVITE_URL },
              ],
            },
          },
        ],
      },
    } as unknown as ErrorEvent
    const frame = scrubEventUrls(event).exception?.values?.[0]?.stacktrace?.frames?.[0]
    expect(frame?.abs_path).toBe('https://fund.armada.blue/invite')
    expect(frame?.filename).toBe('https://fund.armada.blue/invite')
  })

  it('passes through events without URLs untouched', () => {
    const event = { message: 'boom' } as ErrorEvent
    expect(scrubEventUrls(event)).toEqual({ message: 'boom' })
  })
})

describe('scrubBreadcrumbUrls', () => {
  it('strips navigation from/to query strings', () => {
    const crumb = {
      category: 'navigation',
      data: { from: INVITE_URL, to: INVITE_URL },
    } as Breadcrumb
    const scrubbed = scrubBreadcrumbUrls(crumb)
    expect(scrubbed.data?.from).toBe('https://fund.armada.blue/invite')
    expect(scrubbed.data?.to).toBe('https://fund.armada.blue/invite')
  })

  it('strips fetch/xhr breadcrumb url query strings', () => {
    const crumb = { category: 'fetch', data: { url: INVITE_URL } } as Breadcrumb
    expect(scrubBreadcrumbUrls(crumb).data?.url).toBe('https://fund.armada.blue/invite')
  })

  it('passes through breadcrumbs without data untouched', () => {
    const crumb = { category: 'ui.click' } as Breadcrumb
    expect(scrubBreadcrumbUrls(crumb)).toEqual({ category: 'ui.click' })
  })
})
