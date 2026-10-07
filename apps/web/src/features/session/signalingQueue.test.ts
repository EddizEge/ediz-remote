import { describe, expect, it } from 'vitest'
import {
  BoundedSignalQueue,
  MAX_PENDING_SIGNAL_BYTES,
  MAX_PENDING_SIGNAL_MESSAGES,
} from './signalingQueue'

describe('BoundedSignalQueue', () => {
  it('drains in order and clears its accounting', () => {
    const queue = new BoundedSignalQueue<{ id: number }>()
    expect(queue.tryEnqueue({ id: 1 })).toBe(true)
    expect(queue.tryEnqueue({ id: 2 })).toBe(true)
    expect(queue.drain()).toEqual([{ id: 1 }, { id: 2 }])
    expect(queue.size).toBe(0)
    expect(queue.byteLength).toBe(0)
  })

  it('fails closed at the message limit instead of dropping the oldest signal', () => {
    const queue = new BoundedSignalQueue<number>()
    for (let index = 0; index < MAX_PENDING_SIGNAL_MESSAGES; index += 1) {
      expect(queue.tryEnqueue(index)).toBe(true)
    }
    expect(queue.tryEnqueue(MAX_PENDING_SIGNAL_MESSAGES)).toBe(false)
    expect(queue.drain()[0]).toBe(0)
  })

  it('bounds UTF-8 bytes', () => {
    const queue = new BoundedSignalQueue<string>()
    const chunk = 'ş'.repeat(30_000)
    expect(queue.tryEnqueue(chunk)).toBe(true)
    expect(queue.tryEnqueue(chunk)).toBe(true)
    expect(queue.tryEnqueue(chunk)).toBe(false)
    expect(queue.byteLength).toBeLessThanOrEqual(MAX_PENDING_SIGNAL_BYTES)
  })
})
