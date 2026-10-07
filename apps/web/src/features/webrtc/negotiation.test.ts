import { describe, expect, it } from 'vitest'
import {
  MAX_PENDING_ICE_CANDIDATES,
  PendingIceCandidateQueue,
  bindLocalIceGeneration,
  resolveLocalCandidateNegotiationId,
} from './negotiation'

const firstNegotiation = '11111111-1111-4111-8111-111111111111'
const secondNegotiation = '22222222-2222-4222-8222-222222222222'

describe('PendingIceCandidateQueue', () => {
  it('keeps candidates scoped to one negotiation and clears stale epochs', () => {
    const queue = new PendingIceCandidateQueue()
    expect(queue.tryEnqueue(firstNegotiation, { candidate: 'candidate:first' })).toBe(
      'accepted',
    )
    expect(queue.tryEnqueue(secondNegotiation, { candidate: 'candidate:stale' })).toBe(
      'epoch-mismatch',
    )

    queue.beginNegotiation(secondNegotiation)
    expect(queue.size).toBe(0)
    expect(queue.tryEnqueue(secondNegotiation, { candidate: 'candidate:second' })).toBe(
      'accepted',
    )
    expect(queue.drain(secondNegotiation)).toEqual([
      { candidate: 'candidate:second' },
    ])
  })

  it('fails closed at the element limit without growing the queue', () => {
    const queue = new PendingIceCandidateQueue()
    queue.beginNegotiation(firstNegotiation)
    for (let index = 0; index < MAX_PENDING_ICE_CANDIDATES; index += 1) {
      expect(
        queue.tryEnqueue(firstNegotiation, { candidate: `candidate:${index}` }),
      ).toBe('accepted')
    }

    expect(queue.tryEnqueue(firstNegotiation, { candidate: 'candidate:overflow' })).toBe(
      'overflow',
    )
    expect(queue.size).toBe(MAX_PENDING_ICE_CANDIDATES)
  })

  it('fails closed at the UTF-8 byte limit', () => {
    const queue = new PendingIceCandidateQueue()
    queue.beginNegotiation(firstNegotiation)
    const largeCandidate = { candidate: `candidate:${'ş'.repeat(4_000)}` }

    let result: ReturnType<typeof queue.tryEnqueue> = 'accepted'
    while (result === 'accepted') {
      result = queue.tryEnqueue(firstNegotiation, largeCandidate)
    }

    expect(result).toBe('overflow')
    expect(queue.byteLength).toBeLessThanOrEqual(64 * 1024)
  })
})

describe('local ICE generation guard', () => {
  it('binds strict bounded SDP ufrags to one negotiation id', () => {
    expect(bindLocalIceGeneration(firstNegotiation, [
      'v=0',
      'a=ice-ufrag:AbcD+/12',
      'm=video 9 UDP/TLS/RTP/SAVPF 96',
      'a=ice-ufrag:AbcD+/12',
    ].join('\r\n'))).toEqual({
      negotiationId: firstNegotiation,
      usernameFragments: ['AbcD+/12'],
    })
    expect(bindLocalIceGeneration(firstNegotiation, [
      'v=0',
      'a=ice-ufrag:firstOne',
      'a=ice-ufrag:secondTwo',
    ].join('\r\n'))).toEqual({
      negotiationId: firstNegotiation,
      usernameFragments: ['firstOne', 'secondTwo'],
    })
    expect(bindLocalIceGeneration(firstNegotiation,
      `a=ice-ufrag:${'a'.repeat(257)}`,
    )).toBeNull()
  })

  it('enforces ufrag, SDP byte, and unique-fragment bounds', () => {
    expect(bindLocalIceGeneration(
      firstNegotiation,
      'a=ice-ufrag:abcd',
    )).not.toBeNull()
    expect(bindLocalIceGeneration(
      firstNegotiation,
      `a=ice-ufrag:${'a'.repeat(256)}`,
    )).not.toBeNull()
    expect(bindLocalIceGeneration(firstNegotiation, 'a=ice-ufrag:abc'))
      .toBeNull()
    expect(bindLocalIceGeneration(firstNegotiation, 'a=ice-ufrag:bad-value'))
      .toBeNull()
    expect(bindLocalIceGeneration(
      firstNegotiation,
      `a=ice-ufrag:validUfrag\r\n${'x'.repeat(60 * 1024)}`,
    )).toBeNull()
    expect(bindLocalIceGeneration(
      firstNegotiation,
      Array.from(
        { length: 17 },
        (_, index) => `a=ice-ufrag:fragment${index.toString().padStart(2, '0')}`,
      ).join('\r\n'),
    )).toBeNull()
  })

  it('drops a late candidate from the retired ufrag instead of relabeling it', () => {
    const binding = bindLocalIceGeneration(
      secondNegotiation,
      'v=0\r\na=ice-ufrag:newGeneration\r\n',
    )
    expect(resolveLocalCandidateNegotiationId(binding, {
      candidate: 'candidate:1 1 udp 1 127.0.0.1 5000 typ host ufrag oldGeneration',
      usernameFragment: 'oldGeneration',
    })).toBeNull()
    expect(resolveLocalCandidateNegotiationId(binding, {
      candidate: 'candidate:2 1 udp 1 127.0.0.1 5001 typ host ufrag newGeneration',
      usernameFragment: 'newGeneration',
    })).toBe(secondNegotiation)
  })

  it('uses the bounded candidate-line ufrag only when the explicit field is absent', () => {
    const candidate =
      'candidate:3 1 udp 1 127.0.0.1 5002 typ host generation 0 ufrag lineUfrag'
    const binding = bindLocalIceGeneration(
      firstNegotiation,
      'v=0\r\na=ice-ufrag:lineUfrag\r\n',
    )
    expect(resolveLocalCandidateNegotiationId(binding, { candidate }))
      .toBe(firstNegotiation)
    expect(resolveLocalCandidateNegotiationId(binding, {
      candidate,
      usernameFragment: 'differentUfrag',
    })).toBeNull()
    expect(resolveLocalCandidateNegotiationId(null, { candidate })).toBeNull()
    expect(resolveLocalCandidateNegotiationId(binding, {
      candidate: `${candidate}${'x'.repeat(4_096)}`,
      usernameFragment: 'lineUfrag',
    })).toBeNull()
    expect(resolveLocalCandidateNegotiationId(binding, {
      candidate: 'candidate:4 1 udp 1 127.0.0.1 5003 typ host ufrag',
    })).toBeNull()
  })
})
