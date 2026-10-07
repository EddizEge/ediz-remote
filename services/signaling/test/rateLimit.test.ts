import { describe, expect, it } from 'vitest'
import { BoundedTokenBucketStore } from '../src/rateLimit.js'

const limit = { capacity: 2, refillPerSecond: 1 }

describe('bounded token bucket store', () => {
  it('bounds bursts and refills from the injected clock', () => {
    const store = new BoundedTokenBucketStore(2, 10_000)

    expect(store.consume('198.51.100.1', 'join', limit, 1_000)).toBe(true)
    expect(store.consume('198.51.100.1', 'join', limit, 1_000)).toBe(true)
    expect(store.consume('198.51.100.1', 'join', limit, 1_000)).toBe(false)
    expect(store.consume('198.51.100.1', 'join', limit, 1_999)).toBe(false)
    expect(store.consume('198.51.100.1', 'join', limit, 2_000)).toBe(true)
  })

  it('fails closed at the subject cap and admits a new subject after TTL cleanup', () => {
    const store = new BoundedTokenBucketStore(2, 10_000)

    expect(store.consume('198.51.100.1', 'create', limit, 1_000)).toBe(true)
    expect(store.consume('198.51.100.2', 'create', limit, 2_000)).toBe(true)
    expect(store.size).toBe(2)
    expect(store.consume('198.51.100.3', 'create', limit, 3_000)).toBe(false)
    expect(store.size).toBe(2)

    expect(store.consume('198.51.100.3', 'create', limit, 11_001)).toBe(true)
    expect(store.size).toBe(2)
  })

  it('deletes short-lived socket subjects explicitly', () => {
    const store = new BoundedTokenBucketStore(1, 10_000)

    expect(store.consume('socket-1', 'signal', limit, 1_000)).toBe(true)
    expect(store.consume('socket-2', 'signal', limit, 1_000)).toBe(false)
    store.delete('socket-1')
    expect(store.consume('socket-2', 'signal', limit, 1_000)).toBe(true)
  })

  it('does not refill or age a subject early when the clock moves backwards', () => {
    const store = new BoundedTokenBucketStore(1, 10_000)
    const single = { capacity: 1, refillPerSecond: 1 }

    expect(store.consume('198.51.100.1', 'resume', single, 1_000)).toBe(true)
    expect(store.consume('198.51.100.1', 'resume', single, 500)).toBe(false)
    expect(store.sweep(10_500)).toBe(0)
    expect(store.size).toBe(1)
    expect(store.sweep(11_000)).toBe(1)
  })
})
