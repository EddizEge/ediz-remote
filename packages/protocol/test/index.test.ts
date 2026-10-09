import { describe, expect, it } from 'vitest'
import {
  MAX_SIGNALING_MESSAGE_BYTES,
  MINIMUM_SIGNALING_PROTOCOL_VERSION,
  SIGNALING_PROTOCOL_VERSION,
  SIGNALING_SUBPROTOCOL,
  clientMessageSchema,
  controlMessageSchema,
  nativeVideoSignalEnvelopeSchema,
  serverMessageSchema,
} from '../src/index.js'

const negotiationId = '11111111-1111-4111-8111-111111111111'

describe('signaling protocol security boundary', () => {
  it('publishes an explicit minimum and current wire version', () => {
    expect(MINIMUM_SIGNALING_PROTOCOL_VERSION).toBe(3)
    expect(SIGNALING_PROTOCOL_VERSION).toBe(3)
    expect(SIGNALING_SUBPROTOCOL).toBe('ediz-remote.v3')
  })

  it('rejects unknown top-level fields instead of silently stripping them', () => {
    expect(clientMessageSchema.safeParse({ type: 'create_session' }).success).toBe(
      true,
    )
    expect(
      clientMessageSchema.safeParse({
        type: 'create_session',
        privileged: true,
      }).success,
    ).toBe(false)
    expect(
      serverMessageSchema.safeParse({
        type: 'pong',
        ignored: true,
      }).success,
    ).toBe(false)
    expect(
      controlMessageSchema.safeParse({
        channel: 'control',
        version: 1,
        type: 'control.granted',
        capabilities: ['pointer'],
        ignored: true,
      }).success,
    ).toBe(false)
  })

  it('bounds and strictly validates SDP and ICE signaling payloads', () => {
    expect(
      clientMessageSchema.safeParse({
        type: 'signal',
        payload: {
          kind: 'session-description',
          negotiationId,
          description: { type: 'offer', sdp: 'v=0' },
        },
      }).success,
    ).toBe(true)
    expect(
      clientMessageSchema.safeParse({
        type: 'signal',
        payload: {
          kind: 'session-description',
          negotiationId,
          description: { type: 'offer', sdp: 'x'.repeat(60 * 1024 + 1) },
        },
      }).success,
    ).toBe(false)
    expect(
      clientMessageSchema.safeParse({
        type: 'signal',
        payload: {
          kind: 'session-description',
          negotiationId,
          description: { type: 'offer', sdp: 'v=0\u0000' },
        },
      }).success,
    ).toBe(false)
    const maximumEscapedSdpMessage = {
      type: 'signal',
      payload: {
        kind: 'session-description',
        negotiationId,
        description: { type: 'offer', sdp: '"'.repeat(60 * 1024) },
      },
    }
    expect(clientMessageSchema.safeParse(maximumEscapedSdpMessage).success).toBe(true)
    expect(new TextEncoder().encode(JSON.stringify(maximumEscapedSdpMessage)).byteLength)
      .toBeLessThanOrEqual(MAX_SIGNALING_MESSAGE_BYTES)
    expect(
      clientMessageSchema.safeParse({
        type: 'signal',
        payload: {
          kind: 'session-description',
          negotiationId,
          description: { type: 'offer', sdp: '€'.repeat(30_000) },
        },
      }).success,
    ).toBe(false)
    expect(
      clientMessageSchema.safeParse({
        type: 'signal',
        payload: {
          kind: 'ice-candidate',
          negotiationId,
          candidate: { candidate: 'candidate:test', secret: 'unexpected' },
        },
      }).success,
    ).toBe(false)
  })

  it('requires a strict negotiation UUID on every peer signal', () => {
    for (const invalidNegotiationId of [undefined, '', 'epoch-1', 1]) {
      expect(clientMessageSchema.safeParse({
        type: 'signal',
        payload: {
          kind: 'ice-candidate',
          ...(invalidNegotiationId === undefined
            ? {}
            : { negotiationId: invalidNegotiationId }),
          candidate: { candidate: 'candidate:test' },
        },
      }).success).toBe(false)
    }
    expect(clientMessageSchema.safeParse({
      type: 'signal',
      payload: {
        kind: 'ice-candidate',
        negotiationId,
        candidate: { candidate: 'candidate:test' },
      },
    }).success).toBe(true)
  })

  it('requires a version on the native video signaling channel', () => {
    const signal = {
      kind: 'ice-candidate' as const,
      negotiationId,
      candidate: { candidate: 'candidate:test' },
    }
    expect(
      nativeVideoSignalEnvelopeSchema.safeParse({
        channel: 'native-video',
        version: 2,
        signal,
      }).success,
    ).toBe(true)
    expect(
      nativeVideoSignalEnvelopeSchema.safeParse({
        channel: 'native-video',
        version: 1,
        signal,
      }).success,
    ).toBe(false)
    expect(
      nativeVideoSignalEnvelopeSchema.safeParse({
        channel: 'native-video',
        signal,
      }).success,
    ).toBe(false)
  })

  it('rejects downgraded ready messages', () => {
    const clientId = '19f3d8f5-2af5-4e77-a155-41e60d94c1b2'
    expect(
      serverMessageSchema.safeParse({
        type: 'ready',
        clientId,
        protocolVersion: 3,
        minimumProtocolVersion: 3,
      }).success,
    ).toBe(true)
    expect(
      serverMessageSchema.safeParse({
        type: 'ready',
        clientId,
        protocolVersion: 1,
        minimumProtocolVersion: 1,
      }).success,
    ).toBe(false)
  })

  it('accepts accessMode only on an approved request decision', () => {
    const requestId = '19f3d8f5-2af5-4e77-a155-41e60d94c1b2'
    expect(
      clientMessageSchema.safeParse({
        type: 'request_decision',
        requestId,
        approved: true,
        accessMode: 'view',
      }).success,
    ).toBe(true)
    expect(
      clientMessageSchema.safeParse({
        type: 'request_decision',
        requestId,
        approved: false,
        accessMode: 'control',
      }).success,
    ).toBe(false)
  })

  it('strictly bounds operation-aware rate-limit errors', () => {
    expect(
      serverMessageSchema.safeParse({
        type: 'error',
        code: 'rate_limited',
        message: 'Biraz bekleyin.',
        operation: 'refresh_ice',
        retryAfterSeconds: 15,
      }).success,
    ).toBe(true)
    expect(
      serverMessageSchema.safeParse({
        type: 'error',
        code: 'rate_limited',
        message: 'Biraz bekleyin.',
        operation: 'unknown',
        retryAfterSeconds: 0,
      }).success,
    ).toBe(false)
    expect(
      serverMessageSchema.safeParse({
        type: 'error',
        code: 'rate_limited',
        message: 'Biraz bekleyin.',
      }).success,
    ).toBe(false)
    expect(
      serverMessageSchema.safeParse({
        type: 'error',
        code: 'capacity_exceeded',
        message: 'Kapasite dolu.',
        operation: 'create_session',
        retryAfterSeconds: 5,
      }).success,
    ).toBe(true)
    expect(
      serverMessageSchema.safeParse({
        type: 'error',
        code: 'capacity_exceeded',
        message: 'Kapasite dolu.',
        operation: 'join_session',
        retryAfterSeconds: 5,
      }).success,
    ).toBe(false)
    expect(
      serverMessageSchema.safeParse({
        type: 'error',
        code: 'invalid_code',
        message: 'Kod geçersiz.',
        operation: 'join_session',
        retryAfterSeconds: 5,
      }).success,
    ).toBe(false)
    expect(
      serverMessageSchema.safeParse({
        type: 'error',
        code: 'negotiation_exhausted',
        message: 'Yeni bir bağlantı koduyla tekrar onay alın.',
      }).success,
    ).toBe(true)
    expect(
      serverMessageSchema.safeParse({
        type: 'error',
        code: 'negotiation_exhausted',
        message: 'Yeni bir bağlantı koduyla tekrar onay alın.',
        operation: 'signal',
      }).success,
    ).toBe(false)
  })

  it('rejects root-field mutations for every client message variant without throwing', () => {
    const requestId = '19f3d8f5-2af5-4e77-a155-41e60d94c1b2'
    const seeds: unknown[] = [
      { type: 'create_session' },
      { type: 'join_session', code: '123456' },
      { type: 'request_decision', requestId, approved: false },
      {
        type: 'signal',
        payload: {
          kind: 'ice-candidate',
          negotiationId,
          candidate: { candidate: 'candidate:test' },
        },
      },
      { type: 'resume_session', token: 'A'.repeat(43) },
      { type: 'refresh_ice' },
      { type: 'revoke_control', channel: 'control', version: 1 },
      { type: 'leave_session' },
      { type: 'ping' },
    ]

    for (const seed of seeds) {
      expect(() => clientMessageSchema.safeParse(seed)).not.toThrow()
      expect(clientMessageSchema.safeParse(seed).success).toBe(true)
      expect(
        clientMessageSchema.safeParse({
          ...(seed as Record<string, unknown>),
          __unexpected: true,
        }).success,
      ).toBe(false)
    }
  })

  it('rejects prototype-shaped input without mutating the global object prototype', () => {
    const value = JSON.parse(
      '{"type":"ping","__proto__":{"edizRemotePolluted":true}}',
    )
    expect(clientMessageSchema.safeParse(value).success).toBe(false)
    expect(
      ({} as { edizRemotePolluted?: boolean }).edizRemotePolluted,
    ).toBeUndefined()
  })

  it('rejects nested prototype keys that a strict object would otherwise drop silently', () => {
    const nestedCandidate = JSON.parse(
      `{"type":"signal","payload":{"kind":"ice-candidate","negotiationId":"${negotiationId}",` +
        '"candidate":{"candidate":"x","__proto__":{"edizRemotePolluted":true}}}}',
    )
    expect(clientMessageSchema.safeParse(nestedCandidate).success).toBe(false)
    expect(
      clientMessageSchema.safeParse({
        type: 'signal',
        payload: {
          kind: 'ice-candidate',
          negotiationId,
          candidate: { candidate: 'x' },
        },
      }).success,
    ).toBe(true)

    const nestedControlEvent = JSON.parse(
      '{"channel":"control","version":1,"type":"control.event","sequence":1,' +
        '"event":{"kind":"pointer.move","x":0.5,"y":0.5,"__proto__":{}}}',
    )
    expect(controlMessageSchema.safeParse(nestedControlEvent).success).toBe(false)

    const nestedServerIce = JSON.parse(
      '{"type":"ice_configuration","iceConfiguration":{"version":1,"expiresAt":null,' +
        '"iceServers":[{"urls":["stun:stun.example.invalid"],"__proto__":{}}]}}',
    )
    expect(serverMessageSchema.safeParse(nestedServerIce).success).toBe(false)
    expect(
      nativeVideoSignalEnvelopeSchema.safeParse(
        JSON.parse(
          `{"channel":"native-video","version":2,"signal":{"kind":"ice-candidate",` +
            `"negotiationId":"${negotiationId}","candidate":{"candidate":"","__proto__":null}}}`,
        ),
      ).success,
    ).toBe(false)
    expect(
      ({} as { edizRemotePolluted?: boolean }).edizRemotePolluted,
    ).toBeUndefined()
  })

  it('rejects unpaired UTF-16 surrogates anywhere but keeps well-formed pairs', () => {
    const keyboardEvent = (key: string) => ({
      channel: 'control',
      version: 1,
      type: 'control.event',
      sequence: 1,
      event: { kind: 'keyboard.key', code: 'KeyA', key, location: 0, down: true, repeat: false },
    })
    expect(controlMessageSchema.safeParse(keyboardEvent('\u{1F600}')).success).toBe(true)
    for (const key of ['\ud800', '\udc00', 'a\ud800', '\udc00\ud800']) {
      expect(controlMessageSchema.safeParse(keyboardEvent(key)).success).toBe(false)
    }
    // JSON metninde kaçışlı tek surrogate da aynı yoldan reddedilir.
    expect(
      clientMessageSchema.safeParse(
        JSON.parse(
          `{"type":"signal","payload":{"kind":"session-description","negotiationId":"${negotiationId}",` +
            '"description":{"type":"offer","sdp":"v=0\\r\\na=x:\\ud800\\r\\n"}}}',
        ),
      ).success,
    ).toBe(false)
    expect(
      clientMessageSchema.safeParse(
        JSON.parse('{"type":"ping","\\ud800":true}'),
      ).success,
    ).toBe(false)
    expect(
      serverMessageSchema.safeParse({
        type: 'error',
        code: 'invalid_message',
        message: 'Geçersiz \ud800',
      }).success,
    ).toBe(false)
  })
})
