import { describe, expect, it } from 'vitest'
import {
  clampWheelDelta,
  ControlEventRateLimiter,
  mapRemoteCursorToCanvas,
  normalizeRemotePoint,
  normalizeRemotePointInRectangle,
  pointerButtonName,
} from './remoteControl'

describe('remote control helpers', () => {
  it('maps the rendered video content instead of its letterbox area', () => {
    const container = { left: 10, top: 20, width: 1000, height: 800 }

    expect(normalizeRemotePoint(510, 420, container, 1920, 1080)).toEqual({
      x: 0.5,
      y: 0.5,
    })
    expect(normalizeRemotePoint(510, 40, container, 1920, 1080)).toBeNull()
  })

  it('maps supported pointer buttons and bounds wheel input', () => {
    expect(pointerButtonName(0)).toBe('left')
    expect(pointerButtonName(1)).toBe('middle')
    expect(pointerButtonName(2)).toBe('right')
    expect(pointerButtonName(4)).toBeNull()
    expect(clampWheelDelta(20_000)).toBe(10_000)
    expect(clampWheelDelta(Number.NaN)).toBe(0)
  })

  it('maps pointer input against an actual-pixel video rectangle', () => {
    const renderedVideo = { left: -610, top: 40, width: 1920, height: 1080 }

    expect(normalizeRemotePointInRectangle(350, 580, renderedVideo)).toEqual({
      x: 0.5,
      y: 0.5,
    })
    expect(normalizeRemotePointInRectangle(1400, 580, renderedVideo)).toBeNull()
  })

  it('maps remote cursor metadata through scroll and letterbox offsets', () => {
    expect(mapRemoteCursorToCanvas(
      { x: 0.5, y: 0.25 },
      { left: -610, top: 40, width: 1920, height: 1080 },
      { left: 10, top: 20 },
      640,
      0,
    )).toEqual({ left: 980, top: 290 })
  })

  it('keeps the rate limiter bounded and resets it per session', () => {
    const limiter = new ControlEventRateLimiter(2, 1_000)
    expect(limiter.tryConsume(0)).toBe(true)
    expect(limiter.tryConsume(1)).toBe(true)
    expect(limiter.tryConsume(2)).toBe(false)
    expect(limiter.tryConsume(1_001)).toBe(true)
    limiter.reset()
    expect(limiter.tryConsume(1_002)).toBe(true)
  })
})
