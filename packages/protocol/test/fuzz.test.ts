import { describe, expect, it } from 'vitest'
import {
  MAX_SIGNALING_MESSAGE_BYTES,
  clientMessageSchema,
  controlMessageSchema,
  iceConfigurationSchema,
  nativeVideoSignalEnvelopeSchema,
  peerSignalSchema,
  serverMessageSchema,
  signalingPayloadSchema,
} from '../src/index.js'
import {
  SUSPICIOUS_KEYS,
  SeededRandom,
  addOwnKey,
  canonicalJson,
  cloneJson,
  deeplyNestedArray,
  defineOwn,
  mutateJson,
  objectPaths,
  randomJsonValue,
  type JsonValue,
} from './fuzzSupport.js'

// Sabit seed: CI ve yerel koşu aynı girdileri üretir. Başarısızlık mesajı seed,
// grup ve iterasyonu verir; aynı değerlerle tek başına yeniden üretilebilir.
const FUZZ_SEED = 0x4544_495a
const RANDOM_VALUE_ITERATIONS = 2_500
const MUTATIONS_PER_SEED = 250
// Yalnız süre bütçesi; kapsam yukarıdaki sabitlerle belirlenir. Yüklü yerel
// makinede ağır test ~26 sn sürdü, CI runner'ı daha yavaş olabilir.
const FUZZ_TEST_TIMEOUT_MS = 120_000

const negotiationId = '11111111-1111-4111-8111-111111111111'
const nativeNegotiationId = '22222222-2222-4222-8222-222222222222'
const requestId = '19f3d8f5-2af5-4e77-a155-41e60d94c1b2'
const peerId = '7c9e6679-7425-40de-944b-e07fc1f90ae7'
const resumeToken = 'A'.repeat(43)
const iceConfiguration: JsonValue = {
  version: 1,
  expiresAt: '2026-10-09T13:00:00.000Z',
  iceServers: [
    { urls: ['stun:stun.example.invalid:3478'] },
    {
      urls: [
        'turn:turn.example.invalid:3478?transport=udp',
        'turn:turn.example.invalid:3478?transport=tcp',
      ],
      username: '1760000000:fuzz',
      credential: 'fuzz-credential',
    },
  ],
}
const offer: JsonValue = {
  kind: 'session-description',
  negotiationId,
  description: { type: 'offer', sdp: 'v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\n' },
}
const answer: JsonValue = {
  kind: 'session-description',
  negotiationId,
  description: { type: 'answer', sdp: 'v=0\r\n' },
}
const candidate: JsonValue = {
  kind: 'ice-candidate',
  negotiationId,
  candidate: {
    candidate: 'candidate:1 1 udp 1 192.0.2.1 9 typ host',
    sdpMid: '0',
    sdpMLineIndex: 0,
    usernameFragment: 'abcd',
  },
}
const nativeOffer: JsonValue = {
  channel: 'native-video',
  version: 2,
  signal: {
    kind: 'session-description',
    negotiationId: nativeNegotiationId,
    description: { type: 'offer', sdp: 'v=0\r\n' },
  },
}
const nativeCandidate: JsonValue = {
  channel: 'native-video',
  version: 2,
  signal: {
    kind: 'ice-candidate',
    negotiationId: nativeNegotiationId,
    candidate: {
      candidate: '',
      sdpMid: null,
      sdpMLineIndex: null,
      usernameFragment: null,
    },
  },
}

const clientSeeds: JsonValue[] = [
  { type: 'create_session' },
  { type: 'join_session', code: '123456' },
  { type: 'request_decision', requestId, approved: true, accessMode: 'control' },
  { type: 'request_decision', requestId, approved: false },
  { type: 'signal', payload: offer },
  { type: 'signal', payload: answer },
  { type: 'signal', payload: candidate },
  { type: 'signal', payload: nativeOffer },
  { type: 'signal', payload: nativeCandidate },
  { type: 'resume_session', token: resumeToken },
  { type: 'refresh_ice' },
  { type: 'revoke_control', channel: 'control', version: 1 },
  { type: 'leave_session' },
  { type: 'ping' },
]

const serverSeeds: JsonValue[] = [
  { type: 'ready', clientId: peerId, protocolVersion: 3, minimumProtocolVersion: 3 },
  { type: 'session_created', code: '123456', expiresAt: '2026-10-09T13:00:00.000Z' },
  { type: 'join_pending', code: '123456', requestId },
  { type: 'incoming_request', requestId },
  {
    type: 'session_approved',
    code: '123456',
    peerId,
    accessMode: 'view',
    iceConfiguration,
    resumeToken,
    reconnectGraceSeconds: 30,
  },
  {
    type: 'peer_joined',
    peerId,
    accessMode: 'control',
    iceConfiguration,
    resumeToken,
    reconnectGraceSeconds: 30,
  },
  {
    type: 'session_resumed',
    role: 'guest',
    code: '123456',
    peerId: '',
    accessMode: 'view',
    resumeToken,
    peerConnected: false,
    reconnectGraceSeconds: 30,
    iceConfiguration,
  },
  { type: 'peer_suspended', reconnectUntil: '2026-10-09T13:00:30.000Z' },
  { type: 'peer_resumed', peerId, iceConfiguration },
  { type: 'ice_configuration', iceConfiguration },
  { type: 'request_rejected' },
  { type: 'peer_left' },
  { type: 'session_ended', reason: 'expired' },
  { type: 'signal', from: peerId, payload: candidate },
  { type: 'signal', from: peerId, payload: nativeOffer },
  { type: 'pong' },
  {
    type: 'error',
    code: 'rate_limited',
    message: 'Biraz bekleyin.',
    operation: 'signal',
    retryAfterSeconds: 1,
  },
  {
    type: 'error',
    code: 'capacity_exceeded',
    message: 'Kapasite dolu.',
    operation: 'create_session',
    retryAfterSeconds: 5,
  },
  { type: 'error', code: 'invalid_message', message: 'Geçersiz mesaj.' },
]

const controlSeeds: JsonValue[] = [
  { channel: 'control', version: 1, type: 'control.request', capabilities: ['pointer', 'keyboard'] },
  { channel: 'control', version: 1, type: 'control.granted', capabilities: ['pointer'] },
  { channel: 'control', version: 1, type: 'control.revoked', reason: 'host' },
  {
    channel: 'control',
    version: 1,
    type: 'control.event',
    sequence: 7,
    event: { kind: 'pointer.move', x: 0.25, y: 0.75 },
  },
  {
    channel: 'control',
    version: 1,
    type: 'control.event',
    sequence: 8,
    event: { kind: 'pointer.button', button: 'left', down: true, x: 0.5, y: 0.5 },
  },
  {
    channel: 'control',
    version: 1,
    type: 'control.event',
    sequence: 9,
    event: { kind: 'pointer.wheel', deltaX: 0, deltaY: -120 },
  },
  {
    channel: 'control',
    version: 1,
    type: 'control.event',
    sequence: 10,
    event: {
      kind: 'keyboard.key',
      code: 'KeyA',
      key: 'a',
      location: 0,
      down: true,
      repeat: false,
    },
  },
]

type SafeParser = { safeParse(value: unknown): { success: boolean; data?: unknown } }

const seedGroups: Array<{ name: string; schema: SafeParser; seeds: JsonValue[] }> = [
  { name: 'client', schema: clientMessageSchema, seeds: clientSeeds },
  { name: 'server', schema: serverMessageSchema, seeds: serverSeeds },
  { name: 'control', schema: controlMessageSchema, seeds: controlSeeds },
  { name: 'ice-configuration', schema: iceConfigurationSchema, seeds: [iceConfiguration] },
  { name: 'peer-signal', schema: peerSignalSchema, seeds: [offer, answer, candidate] },
  {
    name: 'native-video',
    schema: nativeVideoSignalEnvelopeSchema,
    seeds: [nativeOffer, nativeCandidate],
  },
  {
    name: 'signaling-payload',
    schema: signalingPayloadSchema,
    seeds: [offer, candidate, nativeOffer, nativeCandidate],
  },
]

function polluted(): unknown {
  return (Object.prototype as Record<string, unknown>).edizRemoteFuzzPolluted
}

describe('protocol fuzz matrix', () => {
  it('accepts every valid seed without rewriting it', () => {
    for (const group of seedGroups) {
      for (const seed of group.seeds) {
        const result = group.schema.safeParse(cloneJson(seed))
        expect(result.success, `${group.name} ${canonicalJson(seed)}`).toBe(true)
        expect(canonicalJson(result.data)).toBe(canonicalJson(seed))
      }
    }
  })

  it('never throws on arbitrary JSON and never silently rewrites accepted input', () => {
    const random = new SeededRandom(FUZZ_SEED)
    for (let iteration = 0; iteration < RANDOM_VALUE_ITERATIONS; iteration += 1) {
      // Wire'daki gibi JSON metninden geçirilir; kendi `__proto__` anahtarı korunur.
      const value = cloneJson(randomJsonValue(random))
      for (const group of seedGroups) {
        const context = `seed=${FUZZ_SEED} iteration=${iteration} schema=${group.name}`
        let result: { success: boolean; data?: unknown } | undefined
        expect(() => {
          result = group.schema.safeParse(value)
        }, context).not.toThrow()
        if (result?.success) {
          expect(canonicalJson(result.data), context).toBe(canonicalJson(value))
        }
      }
    }
    expect(polluted()).toBeUndefined()
  }, FUZZ_TEST_TIMEOUT_MS)

  it('rejects suspicious keys at every object depth of every valid seed', () => {
    for (const group of seedGroups) {
      for (const seed of group.seeds) {
        for (const path of objectPaths(seed)) {
          for (const key of SUSPICIOUS_KEYS) {
            const mutated = addOwnKey(seed, path, key, { edizRemoteFuzzPolluted: true })
            // Sunucu ve tarayıcı yalnız JSON metni görür; aynı yoldan ayrıştır.
            const wire = JSON.parse(JSON.stringify(mutated)) as unknown
            const context = `${group.name} path=${JSON.stringify(path)} key=${JSON.stringify(key)}`
            expect(group.schema.safeParse(wire).success, context).toBe(false)
          }
        }
      }
    }
    expect(polluted()).toBeUndefined()
  }, FUZZ_TEST_TIMEOUT_MS)

  it('never throws on structural mutations and accepts only exact, unrewritten values', () => {
    const random = new SeededRandom(FUZZ_SEED ^ 0x5eed)
    for (const group of seedGroups) {
      group.seeds.forEach((seed, seedIndex) => {
        for (let iteration = 0; iteration < MUTATIONS_PER_SEED; iteration += 1) {
          const mutated = cloneJson(mutateJson(random, seed))
          const context =
            `seed=${FUZZ_SEED ^ 0x5eed} schema=${group.name} seedIndex=${seedIndex} ` +
            `iteration=${iteration}`
          let result: { success: boolean; data?: unknown } | undefined
          expect(() => {
            result = group.schema.safeParse(mutated)
          }, context).not.toThrow()
          if (result?.success) {
            expect(canonicalJson(result.data), context).toBe(canonicalJson(mutated))
          }
        }
      })
    }
    expect(polluted()).toBeUndefined()
  }, FUZZ_TEST_TIMEOUT_MS)

  it('rejects deep, wide and oversized structures without throwing', () => {
    const deep = { type: 'signal', payload: deeplyNestedArray(20_000) }
    const wideObjects = {
      type: 'signal',
      payload: Array.from({ length: 5_000 }, () => ({})),
    }
    const wideNumbers = { type: 'signal', payload: Array.from({ length: 50_000 }, () => 1) }
    const manyKeys: Record<string, JsonValue> = { type: 'ping' }
    for (let index = 0; index < 3_000; index += 1) {
      defineOwn(manyKeys, `k${index}`, index)
    }
    const deepControl = {
      channel: 'control',
      version: 1,
      type: 'control.event',
      sequence: 1,
      event: deeplyNestedArray(20_000),
    }
    for (const value of [deep, wideObjects, wideNumbers, manyKeys]) {
      expect(() => clientMessageSchema.safeParse(value)).not.toThrow()
      expect(clientMessageSchema.safeParse(value).success).toBe(false)
      expect(serverMessageSchema.safeParse(value).success).toBe(false)
    }
    expect(controlMessageSchema.safeParse(deepControl).success).toBe(false)
    expect(signalingPayloadSchema.safeParse(deeplyNestedArray(20_000)).success).toBe(false)
    expect(
      new TextEncoder().encode(JSON.stringify(wideObjects)).byteLength,
    ).toBeLessThanOrEqual(MAX_SIGNALING_MESSAGE_BYTES)
  })

  it('rejects non-finite and non-JSON values that only in-process callers can produce', () => {
    const nonJsonValues: unknown[] = [
      undefined,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Symbol('fuzz'),
      () => undefined,
      new Date(0),
      new Map([['type', 'ping']]),
      Object.create(null),
    ]
    for (const value of nonJsonValues) {
      for (const group of seedGroups) {
        expect(() => group.schema.safeParse(value)).not.toThrow()
        expect(group.schema.safeParse(value).success).toBe(false)
      }
    }
    for (const field of ['x', 'y'] as const) {
      for (const invalid of [Number.NaN, Number.POSITIVE_INFINITY, -0.0001, 1.0001]) {
        const event = { kind: 'pointer.move', x: 0.5, y: 0.5, [field]: invalid }
        expect(
          controlMessageSchema.safeParse({
            channel: 'control',
            version: 1,
            type: 'control.event',
            sequence: 1,
            event,
          }).success,
        ).toBe(false)
      }
    }
    const cyclic: Record<string, unknown> = { type: 'ping' }
    cyclic.self = cyclic
    expect(() => clientMessageSchema.safeParse(cyclic)).not.toThrow()
    expect(clientMessageSchema.safeParse(cyclic).success).toBe(false)
  })
})
