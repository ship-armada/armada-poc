// ABOUTME: Tests for the Participate card's hover video.
// ABOUTME: A play() interrupted by pause() (hover-off, blur, unmount) must not surface as an unhandled rejection.
// @vitest-environment jsdom

import { render, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { Participate } from './Participate'

// Browsers reject the play() promise with an AbortError when pause() lands
// before playback starts. Reproduce that so the card's handling is exercised.
function abortedPlay() {
  return Promise.reject(new DOMException('The play() request was interrupted by a call to pause().', 'AbortError'))
}

describe('Participate hover video', () => {
  const unhandled: unknown[] = []
  const onUnhandled = (reason: unknown) => unhandled.push(reason)
  const originalPlay = HTMLMediaElement.prototype.play
  let playCalls = 0

  beforeEach(() => {
    unhandled.length = 0
    playCalls = 0
    process.on('unhandledRejection', onUnhandled)
    // jsdom doesn't implement media playback. play() is a plain stub, not a
    // vi.spyOn: Vitest spies attach .then() to returned promises to track
    // settled results, which would mark the rejection handled and mask the bug.
    HTMLMediaElement.prototype.play = () => {
      playCalls++
      return abortedPlay()
    }
    vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {})
    vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => {})
  })

  afterEach(() => {
    process.off('unhandledRejection', onUnhandled)
    HTMLMediaElement.prototype.play = originalPlay
    vi.restoreAllMocks()
  })

  // Let Node's unhandled-rejection detection run before asserting.
  const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

  it('swallows an interrupted play() once the video has buffered while hovered', async () => {
    const { container } = render(<Participate videoSrc="/fleet.mp4" imageSrc="/fleet.png" />)
    const card = container.firstChild as HTMLElement
    const video = container.querySelector('video')!

    fireEvent.mouseEnter(card)
    fireEvent.loadedData(video)
    await flush()

    expect(playCalls).toBe(1)
    expect(unhandled).toEqual([])
  })

  it('swallows an interrupted play() on re-hover after the video is ready', async () => {
    const { container } = render(<Participate videoSrc="/fleet.mp4" imageSrc="/fleet.png" />)
    const card = container.firstChild as HTMLElement
    const video = container.querySelector('video')!

    // First hover buffers the video; leave before it's ready.
    fireEvent.mouseEnter(card)
    fireEvent.mouseLeave(card)
    fireEvent.loadedData(video)
    // Second hover plays the now-ready video directly.
    fireEvent.mouseEnter(card)
    await flush()

    expect(playCalls).toBe(1)
    expect(unhandled).toEqual([])
  })
})
