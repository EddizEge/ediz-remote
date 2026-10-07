import { describe, expect, it } from 'vitest'
import {
  MediaStateMessageGuard,
  PeerProtocolFatalLatch,
  SequencedMessageGuard,
  SessionSelectionRateGuard,
} from './usePeerConnection'

describe('MediaStateMessageGuard', () => {
  it('rejects replayed and out-of-order media state sequences', () => {
    const guard = new MediaStateMessageGuard()

    expect(guard.tryAccept(4, 0)).toBe(true)
    expect(guard.tryAccept(4, 1)).toBe(false)
    expect(guard.tryAccept(3, 2)).toBe(false)
    expect(guard.tryAccept(5, 3)).toBe(true)
  })

  it('bounds media state updates and resumes after the rate window', () => {
    const guard = new MediaStateMessageGuard()

    for (let sequence = 0; sequence < 8; sequence += 1) {
      expect(guard.tryAccept(sequence, 0)).toBe(true)
    }
    expect(guard.tryAccept(8, 0)).toBe(false)
    expect(guard.tryAccept(8, 1_000)).toBe(true)
  })
})

describe('SequencedMessageGuard', () => {
  it('does not advance the replay watermark when rate limiting a message', () => {
    const guard = new SequencedMessageGuard(2, 1_000)

    expect(guard.accept(0, 0)).toBe('accepted')
    expect(guard.accept(1, 0)).toBe('accepted')
    expect(guard.accept(Number.MAX_SAFE_INTEGER, 0)).toBe('rate-limited')
    expect(guard.accept(2, 1_000)).toBe('accepted')
  })

  it('uses one replay watermark across interleaved session message types', () => {
    const guard = new SequencedMessageGuard(8, 1_000)

    expect(guard.accept(10, 0)).toBe('accepted')
    expect(guard.accept(9, 1)).toBe('replay')
    expect(guard.accept(10, 2)).toBe('replay')
    expect(guard.accept(11, 3)).toBe('accepted')
  })
})

describe('PeerProtocolFatalLatch', () => {
  it('stays tripped across setup generations until an explicit reset', () => {
    const latch = new PeerProtocolFatalLatch()

    expect(latch.trip()).toBe(true)
    expect(latch.trip()).toBe(false)
    expect(latch.tripped).toBe(true)

    latch.reset()
    expect(latch.tripped).toBe(false)
    expect(latch.trip()).toBe(true)
  })
})

describe('SessionSelectionRateGuard', () => {
  it('fails the overflowing subtype without poisoning the other subtype', () => {
    const guard = new SessionSelectionRateGuard()

    for (let index = 0; index < 4; index += 1) {
      expect(guard.tryConsume('display.select', 0)).toBe(true)
    }
    expect(guard.tryConsume('display.select', 0)).toBe(false)
    expect(guard.tryConsume('quality.select', 0)).toBe(true)
    expect(guard.tryConsume('display.select', 1_000)).toBe(true)
  })
})
