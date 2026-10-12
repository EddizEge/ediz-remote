import { describe, expect, it, vi } from 'vitest'
import { PendingIceCandidateQueue } from './negotiation'
import {
  DesktopNativeNegotiationTracker,
  MAX_DESKTOP_NATIVE_NEGOTIATIONS,
  NATIVE_UNCONNECTED_FAILURE_TOLERANCE_MS,
  NativeNegotiationFatalLatch,
  nativeRecoveryDelay,
  parseDesktopNativeMessage,
  toSafeNativeTransportFailureState,
  tripFatalNativeNegotiation,
} from './useNativeVideoPeer'

const sessionEpoch = '11111111-1111-4111-8111-111111111111'
const negotiationId = '22222222-2222-4222-8222-222222222222'
const nextNegotiationId = '33333333-3333-4333-8333-333333333333'

function nativeMessage(type: string, payload: Record<string, unknown>) {
  return {
    type,
    channel: 'native-video',
    version: 2,
    sessionEpoch,
    ...(type === 'desktop.native-video.signal' ? {} : { negotiationId }),
    payload,
  }
}

describe('parseDesktopNativeMessage', () => {
  it('accepts native network quality metrics', () => {
    expect(parseDesktopNativeMessage(nativeMessage(
      'desktop.native-video.metrics',
      {
        packetLossPercent: 2.34,
        jitterMilliseconds: 12.5,
        targetBitrate: 5_600_000,
        nackRequests: 4,
        retransmittedPackets: 3,
        pliRequests: 1,
      },
    ), sessionEpoch)).toEqual({
      type: 'desktop.native-video.metrics',
      channel: 'native-video',
      version: 2,
      sessionEpoch,
      negotiationId,
      payload: {
        packetLossPercent: 2.34,
        jitterMilliseconds: 12.5,
        targetBitrate: 5_600_000,
        nackRequests: 4,
        retransmittedPackets: 3,
        pliRequests: 1,
      },
    })
  })

  it('rejects incomplete metrics and extra fields', () => {
    expect(parseDesktopNativeMessage(nativeMessage(
      'desktop.native-video.metrics',
      { targetBitrate: 5_600_000 },
    ), sessionEpoch)).toBeNull()
    expect(parseDesktopNativeMessage({
      ...nativeMessage('desktop.native-video.metrics', {
        packetLossPercent: null,
        jitterMilliseconds: null,
        targetBitrate: 5_600_000,
        nackRequests: 0,
        retransmittedPackets: 0,
        pliRequests: 0,
      }),
      privileged: true,
    }, sessionEpoch)).toBeNull()
  })

  it('accepts only allowlisted native peer states from the current bridge epoch', () => {
    for (const state of [
      'new',
      'connecting',
      'connected',
      'disconnected',
      'failed',
      'closed',
    ]) {
      expect(parseDesktopNativeMessage(nativeMessage(
        'desktop.native-video.state',
        {
          state,
          errorCode: null,
          recoveryAttempt: null,
          recoveryMaximumAttempts: null,
        },
      ), sessionEpoch)).toMatchObject({
        type: 'desktop.native-video.state',
        sessionEpoch,
        payload: { state },
      })
    }
    expect(parseDesktopNativeMessage(nativeMessage(
      'desktop.native-video.state',
      {
        state: 'reconnecting',
        errorCode: null,
        recoveryAttempt: null,
        recoveryMaximumAttempts: null,
      },
    ), sessionEpoch)).toBeNull()
    expect(parseDesktopNativeMessage(nativeMessage(
      'desktop.native-video.state',
      {
        state: 'failed',
        errorCode: 'native_video_failed',
        recoveryAttempt: null,
        recoveryMaximumAttempts: null,
      },
    ), '22222222-2222-4222-8222-222222222222')).toBeNull()
  })

  it('reduces native failure codes to the two bridge outcomes', () => {
    const stateWith = (state: string, errorCode: unknown) =>
      parseDesktopNativeMessage(nativeMessage(
        'desktop.native-video.state',
        {
          state,
          errorCode,
          recoveryAttempt: null,
          recoveryMaximumAttempts: null,
        },
      ), sessionEpoch)

    expect(stateWith('failed', 'native_transport_failed')).toMatchObject({
      payload: { state: 'failed', errorCode: 'native_transport_failed' },
    })
    expect(stateWith('failed', 'native_video_failed')).toMatchObject({
      payload: { state: 'failed', errorCode: 'native_video_failed' },
    })
    expect(stateWith('connected', null)).toMatchObject({
      payload: { state: 'connected', errorCode: null },
    })
    // Unknown codes never select the automatic transport recovery.
    expect(stateWith('failed', 'capture_failed')).toMatchObject({
      payload: { state: 'failed', errorCode: 'native_video_failed' },
    })
    expect(stateWith('failed', 'NATIVE_TRANSPORT_FAILED')).toMatchObject({
      payload: { state: 'failed', errorCode: 'native_video_failed' },
    })
    // The bounded string and strict key rules still apply.
    expect(stateWith('failed', '')).toBeNull()
    expect(stateWith('failed', 'x'.repeat(65))).toBeNull()
    expect(stateWith('failed', 7)).toBeNull()
    expect(stateWith('failed', undefined)).toBeNull()
  })

  it('does not forward native exception details to React state', () => {
    const message = parseDesktopNativeMessage(nativeMessage(
      'desktop.native-video.state',
      {
        state: 'failed',
        errorCode: 'native_video_failed',
        recoveryAttempt: null,
        recoveryMaximumAttempts: null,
      },
    ), sessionEpoch)
    expect(message).toMatchObject({
      type: 'desktop.native-video.state',
      payload: { state: 'failed' },
    })
    expect(JSON.stringify(message)).not.toContain('credential')
  })

  it('requires a strict negotiation id on state and metrics envelopes', () => {
    const state = nativeMessage('desktop.native-video.state', {
      state: 'connected',
      errorCode: null,
      recoveryAttempt: null,
      recoveryMaximumAttempts: null,
    })
    const metrics = nativeMessage('desktop.native-video.metrics', {
      packetLossPercent: null,
      jitterMilliseconds: null,
      targetBitrate: 5_600_000,
      nackRequests: 0,
      retransmittedPackets: 0,
      pliRequests: 0,
    })

    expect(parseDesktopNativeMessage({ ...state, negotiationId: 'stale' }, sessionEpoch))
      .toBeNull()
    const { negotiationId: _removed, ...missingNegotiation } = metrics
    expect(parseDesktopNativeMessage(missingNegotiation, sessionEpoch)).toBeNull()
  })

  it('accepts only an empty strict negotiation-start envelope', () => {
    expect(parseDesktopNativeMessage(nativeMessage(
      'desktop.native-video.negotiation',
      {},
    ), sessionEpoch)).toMatchObject({
      type: 'desktop.native-video.negotiation',
      negotiationId,
      payload: {},
    })
    expect(parseDesktopNativeMessage(nativeMessage(
      'desktop.native-video.negotiation',
      { generation: 1 },
    ), sessionEpoch)).toBeNull()
  })
})

describe('desktop native negotiation routing', () => {
  const offer = (id: string) => parseDesktopNativeMessage({
    ...nativeMessage('desktop.native-video.signal', {
      kind: 'session-description',
      negotiationId: id,
      description: { type: 'offer', sdp: 'v=0' },
    }),
  }, sessionEpoch)!

  const candidate = (id: string) => parseDesktopNativeMessage({
    ...nativeMessage('desktop.native-video.signal', {
      kind: 'ice-candidate',
      negotiationId: id,
      candidate: { candidate: 'candidate:test' },
    }),
  }, sessionEpoch)!

  const negotiation = (id: string) => parseDesktopNativeMessage({
    ...nativeMessage('desktop.native-video.negotiation', {}),
    negotiationId: id,
  }, sessionEpoch)!

  it('establishes an epoch only from negotiation-start, then accepts its offer', () => {
    const tracker = new DesktopNativeNegotiationTracker()
    expect(tracker.accept(candidate(negotiationId))).toBe('stale')
    expect(tracker.accept(offer(negotiationId))).toBe('stale')
    expect(tracker.accept(negotiation(negotiationId))).toBe('accepted')
    expect(tracker.activeNegotiationId).toBe(negotiationId)
    expect(tracker.accept(offer(negotiationId))).toBe('accepted')
    expect(tracker.accept(candidate(negotiationId))).toBe('accepted')
  })

  it('accepts pre-offer failure but rejects stale offer, state, and metrics', () => {
    const tracker = new DesktopNativeNegotiationTracker()
    expect(tracker.accept(negotiation(negotiationId))).toBe('accepted')
    const staleState = parseDesktopNativeMessage(nativeMessage(
      'desktop.native-video.state',
      {
        state: 'failed',
        errorCode: 'native_video_failed',
        recoveryAttempt: null,
        recoveryMaximumAttempts: null,
      },
    ), sessionEpoch)!
    const staleMetrics = parseDesktopNativeMessage(nativeMessage(
      'desktop.native-video.metrics',
      {
        packetLossPercent: null,
        jitterMilliseconds: null,
        targetBitrate: 5_600_000,
        nackRequests: 0,
        retransmittedPackets: 0,
        pliRequests: 0,
      },
    ), sessionEpoch)!
    expect(tracker.accept(staleState)).toBe('accepted')
    expect(tracker.accept(negotiation(nextNegotiationId))).toBe('accepted')
    expect(tracker.activeNegotiationId).toBe(nextNegotiationId)
    expect(tracker.accept(offer(negotiationId))).toBe('stale')
    expect(tracker.activeNegotiationId).toBe(nextNegotiationId)

    expect(tracker.accept(staleState)).toBe('stale')
    expect(tracker.accept(staleMetrics)).toBe('stale')
    expect(tracker.accept(offer(nextNegotiationId))).toBe('accepted')
    expect(tracker.accept(negotiation(negotiationId))).toBe('stale')
  })

  it('fails closed when the bounded seen-id set is exhausted', () => {
    const tracker = new DesktopNativeNegotiationTracker()
    for (let index = 0; index < MAX_DESKTOP_NATIVE_NEGOTIATIONS; index += 1) {
      expect(tracker.accept(negotiation(negotiationIdForIndex(index))))
        .toBe('accepted')
    }
    const current = tracker.activeNegotiationId
    expect(tracker.accept(negotiation(
      negotiationIdForIndex(MAX_DESKTOP_NATIVE_NEGOTIATIONS),
    ))).toBe('exhausted')
    expect(tracker.activeNegotiationId).toBe(current)
  })
})

describe('native negotiation fatal latch', () => {
  it('closes once and blocks later activity until an explicit reset', () => {
    const latch = new NativeNegotiationFatalLatch()
    const remote = new PendingIceCandidateQueue()
    const local = new PendingIceCandidateQueue()
    remote.beginNegotiation(negotiationId)
    local.beginNegotiation(negotiationId)
    remote.tryEnqueue(negotiationId, { candidate: 'candidate:remote' })
    local.tryEnqueue(negotiationId, { candidate: 'candidate:local' })
    const close = vi.fn()

    expect(tripFatalNativeNegotiation(latch, { close }, [remote, local])).toBe(true)
    expect(latch.tripped).toBe(true)
    expect(close).toHaveBeenCalledTimes(1)
    expect(remote.size).toBe(0)
    expect(local.size).toBe(0)
    expect(tripFatalNativeNegotiation(latch, { close }, [remote, local])).toBe(false)
    expect(close).toHaveBeenCalledTimes(1)

    latch.reset()
    expect(latch.tripped).toBe(false)
    expect(tripFatalNativeNegotiation(latch, { close }, [remote, local])).toBe(true)
    expect(close).toHaveBeenCalledTimes(2)
  })
})

describe('native guest transport failure state', () => {
  const connectedState = (): Parameters<
    typeof toSafeNativeTransportFailureState
  >[0] => ({
    status: 'connected',
    remoteStream: {} as MediaStream,
    error: null,
    active: true,
    metrics: {
      packetLossPercent: 1,
      jitterMilliseconds: 2,
      targetBitrate: 3_000_000,
      nackRequests: 4,
      retransmittedPackets: 3,
      pliRequests: 1,
    },
  })

  it.each(['disconnected', 'failed'] as const)(
    'clears a stale remote stream immediately when %s',
    (status) => {
      const next = toSafeNativeTransportFailureState(connectedState(), status)

      expect(next.status).toBe(status)
      expect(next.remoteStream).toBeNull()
      expect(next.metrics).toBeNull()
      expect(next.error).toBeTruthy()
      expect(next.active).toBe(true)
    },
  )
})

describe('native recovery delay', () => {
  it('keeps the exponential backoff after the negotiation connected', () => {
    expect([0, 1, 2].map((attempts) => nativeRecoveryDelay(attempts, true)))
      .toEqual([1_000, 2_000, 4_000])
  })

  it('waits at least the late-candidate tolerance before a first connection', () => {
    expect(NATIVE_UNCONNECTED_FAILURE_TOLERANCE_MS).toBe(5_000)
    expect([0, 1, 2, 3].map((attempts) => nativeRecoveryDelay(attempts, false)))
      .toEqual([5_000, 5_000, 5_000, 8_000])
  })
})

function negotiationIdForIndex(index: number): string {
  return `00000000-0000-4000-8000-${index.toString(16).padStart(12, '0')}`
}
